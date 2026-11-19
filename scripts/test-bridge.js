#!/usr/bin/env node
/**
 * End-to-end bridge test without a real browser:
 *   - spawns two MCP servers (first becomes hub, second becomes client)
 *   - connects a fake "extension" with a chrome-extension:// Origin
 *   - verifies a web-page Origin is rejected
 *   - runs initialize / tools/list / tools/call through BOTH MCP servers
 */

'use strict';

const http = require('node:http');
const crypto = require('node:crypto');
const path = require('node:path');
const { spawn } = require('node:child_process');

const PORT = 17399;
const ROOT = path.resolve(__dirname, '..');
const identity = require(path.join(ROOT, 'bridge', 'extension-id.json'));
const env = { ...process.env, AGY_CHROME_BRIDGE_PORT: String(PORT), AGY_CHROME_AUTOLAUNCH: '0' };

let failures = 0;
const check = (cond, label) => {
  console.log(`${cond ? '  PASS' : '  FAIL'}  ${label}`);
  if (!cond) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function startMcp() {
  const child = spawn(process.execPath, [path.join(ROOT, 'bridge', 'mcp-server.js')], { env });
  let buf = '';
  const waiters = new Map();
  child.stdout.on('data', (d) => {
    buf += d;
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      const msg = JSON.parse(line);
      waiters.get(msg.id)?.(msg);
    }
  });
  child.stderr.on('data', (d) => process.env.VERBOSE && process.stderr.write(d));
  let id = 0;
  const request = (method, params) =>
    new Promise((resolve) => {
      const myId = ++id;
      waiters.set(myId, resolve);
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: myId, method, params })}\n`);
    });
  return { child, request };
}

/** Minimal masked-frame WebSocket client so we can set a custom Origin header. */
function connectFakeClient(origin) {
  return new Promise((resolve, reject) => {
    const key = crypto.randomBytes(16).toString('base64');
    const req = http.request({
      host: '127.0.0.1',
      port: PORT,
      path: '/ws?client=chrome-extension',
      headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Key': key, 'Sec-WebSocket-Version': '13', Origin: origin }
    });
    req.on('response', (res) => reject(new Error(`HTTP ${res.statusCode}`)));
    req.on('error', reject);
    req.on('upgrade', (_res, socket) => {
      const handlers = [];
      let buffer = Buffer.alloc(0);
      socket.on('data', (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);
        while (buffer.length >= 2) {
          let len = buffer[1] & 0x7f;
          let off = 2;
          if (len === 126) { len = buffer.readUInt16BE(2); off = 4; }
          else if (len === 127) { len = Number(buffer.readBigUInt64BE(2)); off = 10; }
          if (buffer.length < off + len) return;
          const opcode = buffer[0] & 0x0f;
          const payload = buffer.subarray(off, off + len).toString('utf8');
          buffer = buffer.subarray(off + len);
          if (opcode === 1) handlers.forEach((h) => h(JSON.parse(payload)));
        }
      });
      const send = (obj) => {
        const data = Buffer.from(JSON.stringify(obj));
        const mask = crypto.randomBytes(4);
        let header;
        if (data.length < 126) header = Buffer.from([0x81, 0x80 | data.length]);
        else { header = Buffer.alloc(4); header[0] = 0x81; header[1] = 0x80 | 126; header.writeUInt16BE(data.length, 2); }
        const masked = Buffer.from(data.map((b, i) => b ^ mask[i & 3]));
        socket.write(Buffer.concat([header, mask, masked]));
      };
      resolve({ onMessage: (h) => handlers.push(h), send, socket });
    });
    req.end();
  });
}

(async () => {
  console.log('Bridge end-to-end test');
  const mcpA = startMcp();
  const init = await mcpA.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
  check(init.result?.serverInfo?.name === 'antigravity-chrome', 'MCP initialize');
  const list = await mcpA.request('tools/list', {});
  check(list.result?.tools?.length === 26, `tools/list returns ${list.result?.tools?.length} tools (expected 26)`);
  await sleep(600); // let A become the hub

  const mcpB = startMcp();
  await mcpB.request('initialize', { protocolVersion: '2025-06-18', capabilities: {} });
  await sleep(600);

  let rejected = false;
  try {
    await connectFakeClient('https://evil.example.com');
  } catch (_e) {
    rejected = true;
  }
  check(rejected, 'web page Origin is rejected');

  const cwsExt = await connectFakeClient(`chrome-extension://${identity.cwsExtensionId}`);
  check(Boolean(cwsExt), 'global Chrome Web Store extension Origin is accepted');
  cwsExt.socket.destroy();

  const ext = await connectFakeClient(`chrome-extension://${identity.extensionId}`);
  ext.onMessage((msg) => {
    if (msg.type === 'RPC_REQUEST') {
      ext.send({ type: 'RPC_RESPONSE', id: msg.id, ok: true, result: { echoed: msg.method, tabCount: 3 } });
    }
  });
  await sleep(200);

  const viaHub = await mcpA.request('tools/call', { name: 'chrome_status', arguments: {} });
  check(viaHub.result?.content?.[0]?.text?.includes('"tabCount": 3'), 'tool call via hub process reaches extension');

  const viaClient = await mcpB.request('tools/call', { name: 'chrome_list_tabs', arguments: {} });
  check(viaClient.result?.content?.[0]?.text?.includes('chrome_list_tabs'), 'tool call via client process is relayed through hub');

  const unknown = await mcpA.request('tools/call', { name: 'nope', arguments: {} });
  check(unknown.error?.code === -32602, 'unknown tool rejected');

  ext.socket.destroy();
  mcpA.child.kill();
  mcpB.child.kill();
  console.log(failures ? `\n${failures} test(s) failed` : '\nAll tests passed');
  process.exit(failures ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
