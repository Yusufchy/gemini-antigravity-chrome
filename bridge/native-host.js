#!/usr/bin/env node
/**
 * Chrome Native Messaging host: com.google.antigravity.chrome_bridge
 *
 * Chrome launches this process when the extension calls chrome.runtime.connectNative().
 * Purpose:
 *   - Wake-up path: guarantees a bridge hub exists (becomes the hub in-process if none is running),
 *     so the extension can connect even before Antigravity spawns its MCP server.
 *   - Reports Antigravity auto-detection results (installed / running / version) to the extension.
 *   - Keeps the MV3 service worker alive while the native port is open.
 *
 * Protocol: each message = 4-byte little-endian length + UTF-8 JSON (both directions).
 */

'use strict';

const { BridgeLink } = require('./lib/bridge-link');
const { detectAntigravity } = require('./lib/detect-antigravity');
const { WS_PORT } = require('./lib/config');

const log = (...args) => process.stderr.write(`[agy-chrome-native] ${args.join(' ')}\n`);

function writeMessage(obj) {
  const json = Buffer.from(JSON.stringify(obj), 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(json.length, 0);
  process.stdout.write(Buffer.concat([header, json]));
}

let buffer = Buffer.alloc(0);
const link = new BridgeLink();

async function announce() {
  try {
    await link.ensure();
  } catch (err) {
    log('bridge election failed:', err.message);
  }
  writeMessage({
    type: 'BRIDGE_READY',
    wsPort: WS_PORT,
    role: link.role,
    antigravity: detectAntigravity()
  });
}

async function onMessage(msg) {
  switch (msg?.type) {
    case 'HELLO_FROM_EXTENSION':
    case 'DETECT':
      await announce();
      break;
    case 'PING':
      writeMessage({ type: 'PONG', timestamp: Date.now() });
      break;
    default:
      writeMessage({ type: 'ERROR', error: `Unknown native message type: ${msg?.type}` });
  }
}

process.stdin.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  while (buffer.length >= 4) {
    const len = buffer.readUInt32LE(0);
    if (buffer.length < 4 + len) break;
    const body = buffer.subarray(4, 4 + len).toString('utf8');
    buffer = buffer.subarray(4 + len);
    try {
      onMessage(JSON.parse(body)).catch((err) => log(err.message));
    } catch (err) {
      log('bad message:', err.message);
    }
  }
});

// Chrome closes stdin when the extension disconnects the port.
process.stdin.on('end', () => process.exit(0));
process.on('uncaughtException', (err) => log('uncaught:', err.stack || err.message));
