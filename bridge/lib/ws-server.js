/**
 * High-Throughput, Dependency-Free RFC 6455 WebSocket Server (v2.2.0).
 * Bound to 127.0.0.1 only.
 *
 * Performance upgrades (v2.2.0):
 *   - O(n) chunk-queue buffer reader (replaces O(n^2) Buffer.concat per TCP chunk).
 *   - 128 MB max frame ceiling for large binary downloads, PDFs, and full-page captures.
 *   - Corked header+payload writes to avoid extra Buffer allocation copies.
 */

'use strict';

const http = require('node:http');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_FRAME_BYTES = 128 * 1024 * 1024; // 128 MB ceiling for large file/blob & capture transfers

class ChunkQueue {
  constructor() {
    this.chunks = [];
    this.headOffset = 0;
    this.length = 0;
  }

  push(buf) {
    if (!buf || buf.length === 0) return;
    this.chunks.push(buf);
    this.length += buf.length;
  }

  peekByte(index) {
    let remaining = index + this.headOffset;
    for (let i = 0; i < this.chunks.length; i++) {
      const c = this.chunks[i];
      if (remaining < c.length) return c[remaining];
      remaining -= c.length;
    }
    return undefined;
  }

  peekBytes(offset, count) {
    const out = Buffer.allocUnsafe(count);
    let srcOff = offset + this.headOffset;
    let dstOff = 0;
    for (let i = 0; i < this.chunks.length && dstOff < count; i++) {
      const c = this.chunks[i];
      if (srcOff >= c.length) {
        srcOff -= c.length;
        continue;
      }
      const toCopy = Math.min(count - dstOff, c.length - srcOff);
      c.copy(out, dstOff, srcOff, srcOff + toCopy);
      dstOff += toCopy;
      srcOff = 0;
    }
    return out;
  }

  consume(count) {
    if (count <= 0) return Buffer.alloc(0);
    if (count > this.length) count = this.length;

    // Fast path: entire slice lies inside the head chunk (zero copy!)
    const head = this.chunks[0];
    if (head && this.headOffset + count <= head.length) {
      const slice = head.subarray(this.headOffset, this.headOffset + count);
      this.headOffset += count;
      this.length -= count;
      if (this.headOffset === head.length) {
        this.chunks.shift();
        this.headOffset = 0;
      }
      return slice;
    }

    const out = Buffer.allocUnsafe(count);
    let dstOff = 0;
    while (dstOff < count && this.chunks.length > 0) {
      const c = this.chunks[0];
      const avail = c.length - this.headOffset;
      const toCopy = Math.min(count - dstOff, avail);
      c.copy(out, dstOff, this.headOffset, this.headOffset + toCopy);
      dstOff += toCopy;
      this.headOffset += toCopy;
      this.length -= toCopy;
      if (this.headOffset === c.length) {
        this.chunks.shift();
        this.headOffset = 0;
      }
    }
    return out;
  }

  skip(count) {
    if (count <= 0) return;
    let remaining = Math.min(count, this.length);
    this.length -= remaining;
    while (remaining > 0 && this.chunks.length > 0) {
      const c = this.chunks[0];
      const avail = c.length - this.headOffset;
      if (remaining < avail) {
        this.headOffset += remaining;
        remaining = 0;
      } else {
        remaining -= avail;
        this.chunks.shift();
        this.headOffset = 0;
      }
    }
  }
}

class WsConnection extends EventEmitter {
  constructor(socket, request) {
    super();
    this.socket = socket;
    this.request = request;
    this.queue = new ChunkQueue();
    this.fragments = [];
    this.open = true;

    socket.setNoDelay(true);
    socket.on('data', (chunk) => this._onData(chunk));
    socket.on('close', () => this._finalize());
    socket.on('error', () => this._finalize());
  }

  get readyState() {
    return this.open ? 1 : 3;
  }

  send(text) {
    if (!this.open) return;
    this._writeFrame(0x1, Buffer.from(String(text), 'utf8'));
  }

  ping() {
    if (this.open) this._writeFrame(0x9, Buffer.alloc(0));
  }

  close(code = 1000) {
    if (!this.open) return;
    const payload = Buffer.alloc(2);
    payload.writeUInt16BE(code, 0);
    try {
      this._writeFrame(0x8, payload);
    } catch (_e) {}
    this.socket.end();
    this._finalize();
  }

  _finalize() {
    if (!this.open) return;
    this.open = false;
    this.fragments = [];
    this.emit('close');
  }

  _writeFrame(opcode, payload) {
    const len = payload.length;
    let header;
    if (len < 126) {
      header = Buffer.from([0x80 | opcode, len]);
    } else if (len < 65536) {
      header = Buffer.allocUnsafe(4);
      header[0] = 0x80 | opcode;
      header[1] = 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.allocUnsafe(10);
      header[0] = 0x80 | opcode;
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }
    this.socket.cork?.();
    this.socket.write(header);
    if (len > 0) this.socket.write(payload);
    this.socket.uncork?.();
  }

  _onData(chunk) {
    this.queue.push(chunk);
    while (this.queue.length >= 2) {
      const b0 = this.queue.peekByte(0);
      const b1 = this.queue.peekByte(1);
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let offset = 2;

      if (len === 126) {
        if (this.queue.length < 4) return;
        len = this.queue.peekBytes(2, 2).readUInt16BE(0);
        offset = 4;
      } else if (len === 127) {
        if (this.queue.length < 10) return;
        len = Number(this.queue.peekBytes(2, 8).readBigUInt64BE(0));
        offset = 10;
      }
      if (len > MAX_FRAME_BYTES) {
        this.close(1009);
        return;
      }
      const maskLen = masked ? 4 : 0;
      if (this.queue.length < offset + maskLen + len) return;

      this.queue.skip(offset);
      const mask = masked ? Buffer.from(this.queue.consume(4)) : null;
      let payload = this.queue.consume(len);
      if (masked && mask) {
        // Clone if slice shares backing chunk buffer, then unmask in-place
        payload = Buffer.from(payload);
        const m0 = mask[0];
        const m1 = mask[1];
        const m2 = mask[2];
        const m3 = mask[3];
        let i = 0;
        const limit = payload.length - 3;
        for (; i < limit; i += 4) {
          payload[i] ^= m0;
          payload[i + 1] ^= m1;
          payload[i + 2] ^= m2;
          payload[i + 3] ^= m3;
        }
        for (; i < payload.length; i++) {
          payload[i] ^= mask[i & 3];
        }
      }

      if (opcode === 0x8) {
        this.close(1000);
        return;
      }
      if (opcode === 0x9) {
        this._writeFrame(0xa, payload);
        continue;
      }
      if (opcode === 0xa) continue;

      if (opcode === 0x1 || opcode === 0x2 || opcode === 0x0) {
        this.fragments.push(payload);
        if (fin) {
          const message =
            this.fragments.length === 1
              ? this.fragments[0].toString('utf8')
              : Buffer.concat(this.fragments).toString('utf8');
          this.fragments = [];
          this.emit('message', message);
        }
      }
    }
  }
}

/**
 * Creates a WebSocket server.
 * @param {{port:number, host?:string, path?:string, verifyClient?:(req, url)=>boolean}} options
 * @returns {Promise<{server: http.Server, events: EventEmitter}>}
 */
function createWsServer(options) {
  const { port, host = '127.0.0.1', path = '/ws', verifyClient } = options;
  const events = new EventEmitter();

  const server = http.createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, service: 'antigravity-chrome-bridge', version: '2.2.0' }));
      return;
    }
    res.writeHead(404);
    res.end();
  });

  server.on('upgrade', (req, socket) => {
    const url = new URL(req.url, `http://${host}`);
    const key = req.headers['sec-websocket-key'];
    if (url.pathname !== path || !key || (verifyClient && !verifyClient(req, url))) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
    );
    events.emit('connection', new WsConnection(socket, req), url);
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve({ server, events });
    });
  });
}

module.exports = { createWsServer };
