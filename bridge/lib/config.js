/**
 * Shared configuration for the Antigravity <-> Chrome bridge (v2.0).
 * Supports both local deterministic unpacked ID and global Chrome Web Store ID.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { GEMINI_DIR } = require('./detect-antigravity');

const BRIDGE_ROOT = path.resolve(__dirname, '..');
const STATE_DIR = path.join(GEMINI_DIR, 'antigravity-chrome-bridge');
const CAPTURES_DIR = path.join(STATE_DIR, 'captures');
const TOKEN_FILE = path.join(STATE_DIR, 'token');
const EXTRA_IDS_FILE = path.join(STATE_DIR, 'allowed-extensions.json');
const DEFAULT_CWS_ID = 'jilnmjdedhlhhnlopjijgbkoblbeihmg';

function readIdentity() {
  try {
    return JSON.parse(fs.readFileSync(path.join(BRIDGE_ROOT, 'extension-id.json'), 'utf8'));
  } catch (_e) {
    return {
      extensionId: null,
      cwsExtensionId: DEFAULT_CWS_ID,
      nativeHostName: 'com.google.antigravity.chrome_bridge',
      wsPort: 17380
    };
  }
}

const identity = readIdentity();
const WS_PORT = Number(process.env.AGY_CHROME_BRIDGE_PORT) || identity.wsPort || 17380;
const NATIVE_HOST_NAME = identity.nativeHostName || 'com.google.antigravity.chrome_bridge';

/** Local secret shared by bridge processes (MCP servers, native host). Never sent to web pages. */
function getBridgeToken() {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  try {
    const existing = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
    if (existing.length >= 32) return existing;
  } catch (_e) {}
  const token = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(TOKEN_FILE, token, { mode: 0o600 });
  return token;
}

/** Extension IDs allowed to connect (local dev ID + Chrome Web Store global ID + extras). */
function getAllowedExtensionIds() {
  const ids = new Set();
  if (identity.extensionId) ids.add(identity.extensionId);
  if (identity.cwsExtensionId) ids.add(identity.cwsExtensionId);
  ids.add(DEFAULT_CWS_ID);
  try {
    for (const id of JSON.parse(fs.readFileSync(EXTRA_IDS_FILE, 'utf8'))) ids.add(String(id));
  } catch (_e) {}
  for (const id of (process.env.AGY_CHROME_EXTENSION_IDS || '').split(',')) {
    if (id.trim()) ids.add(id.trim());
  }
  return ids;
}

module.exports = {
  BRIDGE_ROOT,
  STATE_DIR,
  CAPTURES_DIR,
  WS_PORT,
  NATIVE_HOST_NAME,
  DEFAULT_CWS_ID,
  identity,
  getBridgeToken,
  getAllowedExtensionIds
};
