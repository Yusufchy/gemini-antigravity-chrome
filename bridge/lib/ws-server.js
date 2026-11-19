/**
 * Minimal, dependency-free RFC 6455 WebSocket server (text frames, ping/pong, close).
 * Bound to 127.0.0.1 only. Enough for the extension <-> bridge JSON protocol.
 */

'use strict';

const http = require('node:http');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_FRAME_BYTES = 64 * 1024 * 1024; // screenshots can be large

class WsConnection extends EventEmitter {
  constructor(socket, request) {
    super();
    this.socket = socket;
    this.request = request;
    this.buffer = Buffer.alloc(0);
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
    this.emit('close');
  }

  _writeFrame(opcode, payload) {
    const len = payload.length;
    let header;
    if (len < 126) {
      header = Buffer.from([0x80 | opcode, len]);
    } else if (len < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | opcode;
      header[1] = 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | opcode;
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }
    this.socket.write(Buffer.concat([header, payload]));
  }

  _onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 2) {
      const b0 = this.buffer[0];
      const b1 = this.buffer[1];
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let offset = 2;

      if (len === 126) {
        if (this.buffer.length < 4) return;
        len = this.buffer.readUInt16BE(2);
        offset = 4;
      } else if (len === 127) {
        if (this.buffer.length < 10) return;
        len = Number(this.buffer.readBigUInt64BE(2));
        offset = 10;
      }
      if (len > MAX_FRAME_BYTES) {
        this.close(1009);
        return;
      }
      const maskLen = masked ? 4 : 0;
      if (this.buffer.length < offset + maskLen + len) return;

      let payload = this.buffer.subarray(offset + maskLen, offset + maskLen + len);
      if (masked) {
        const mask = this.buffer.subarray(offset, offset + 4);
        payload = Buffer.from(payload);
        for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      }
      this.buffer = this.buffer.subarray(offset + maskLen + len);

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
          const message = Buffer.concat(this.fragments).toString('utf8');
          this.fragments = [];
          this.emit('message', message);
        }
      }
    }
  }
}

/**
 * Creates a WebSocket server.
 * @param {{port:number, host?:string, path?:string, verifyClient?:(req)=>boolean}} options
 * @returns {Promise<{server: http.Server, events: EventEmitter}>}
 */
function createWsServer(options) {
  const { port, host = '127.0.0.1', path = '/ws', verifyClient } = options;
  const events = new EventEmitter();

  const server = http.createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, service: 'antigravity-chrome-bridge' }));
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
