/**
 * BridgeLink (v2.2.0) — gives any bridge process (MCP server, native host, parallel agent)
 * a unified `call(method, params)` routed through BridgeHub.executeTool so both in-process
 * hubs and multi-agent WebSocket clients share identical DownloadManager & AgentScheduler routing.
 *
 *   1. Try to bind the hub port -> this process becomes the hub (in-process calls).
 *   2. If the port is taken     -> connect to the existing hub as an authenticated client.
 *   3. If the hub goes away     -> re-run the election (become hub or reconnect).
 */

'use strict';

const { BridgeHub } = require('../hub');
const { WS_PORT, getBridgeToken } = require('./config');

const log = (...args) => process.stderr.write(`[agy-chrome-link] ${args.join(' ')}\n`);

class BridgeLink {
  constructor({ port = WS_PORT, clientId } = {}) {
    this.port = port;
    this.clientId = clientId || `mcp-${process.pid}-${Math.random().toString(36).slice(2, 6)}`;
    this.hub = null;
    this.ws = null;
    this.pending = new Map();
    this.seq = 0;
    this.connecting = null;
  }

  get role() {
    return this.hub ? 'hub' : this.ws ? 'client' : 'none';
  }

  async ensure() {
    if (this.hub || (this.ws && this.ws.readyState === 1)) return;
    if (!this.connecting) {
      this.connecting = this._elect().finally(() => {
        this.connecting = null;
      });
    }
    await this.connecting;
  }

  async _elect() {
    try {
      this.hub = await new BridgeHub({ port: this.port }).start();
      log(`acting as hub (${this.clientId})`);
      return;
    } catch (err) {
      if (err.code !== 'EADDRINUSE') throw err;
    }
    await this._connectClient();
    log(`connected to existing hub as client (${this.clientId})`);
  }

  _connectClient() {
    const token = getBridgeToken();
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(
        `ws://127.0.0.1:${this.port}/ws?client=bridge-client&token=${token}&clientId=${encodeURIComponent(this.clientId)}`
      );
      const timer = setTimeout(() => {
        try {
          ws.close();
        } catch (_e) {}
        reject(new Error('Timed out connecting to the existing bridge hub'));
      }, 4000);

      ws.onopen = () => {
        clearTimeout(timer);
        this.ws = ws;
        resolve();
      };
      ws.onerror = () => {
        clearTimeout(timer);
        reject(new Error(`Port ${this.port} is in use by something that is not the Antigravity bridge hub`));
      };
      ws.onclose = () => {
        if (this.ws === ws) this.ws = null;
        for (const [id, entry] of this.pending) {
          clearTimeout(entry.timer);
          entry.reject(new Error('Bridge hub connection closed; retry the tool call.'));
          this.pending.delete(id);
        }
      };
      ws.onmessage = (event) => {
        let msg;
        try {
          msg = JSON.parse(event.data);
        } catch (_e) {
          return;
        }
        if (msg.type !== 'RPC_RESPONSE') return;
        const entry = this.pending.get(msg.id);
        if (!entry) return;
        clearTimeout(entry.timer);
        this.pending.delete(msg.id);
        if (msg.ok) entry.resolve(msg.result);
        else entry.reject(new Error(msg.error));
      };
    });
  }

  async call(method, params = {}, timeoutMs = 60000) {
    await this.ensure();
    if (this.hub) {
      return this.hub.executeTool(method, params, timeoutMs, { clientId: this.clientId });
    }

    const id = `c-${process.pid}-${++this.seq}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Bridge hub did not answer ${method} within ${timeoutMs + 25000}ms`));
      }, timeoutMs + 25000);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ type: 'RPC_REQUEST', id, method, params, timeoutMs }));
    });
  }

  close() {
    if (this.hub) {
      this.hub.stop();
      this.hub = null;
    }
    if (this.ws) {
      try {
        this.ws.close();
      } catch (_e) {}
      this.ws = null;
    }
  }
}

module.exports = { BridgeLink };
