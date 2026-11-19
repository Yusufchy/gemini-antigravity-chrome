#!/usr/bin/env node
/**
 * Installer for "Gemini Antigravity in Chrome" v2.0.
 *
 *  1. Generates minimalist icons + deterministic extension identity (local dev + CWS global ID).
 *  2. Registers Chrome Native Messaging host across Chrome, Edge, Brave, Chromium (Win/macOS/Linux)
 *     allowing BOTH the local unpacked extension ID and the published Chrome Web Store ID.
 *  3. Installs the Antigravity plugin at ~/.gemini/config/plugins/antigravity-chrome/.
 */

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const BRIDGE = path.join(ROOT, 'bridge');
const EXTENSION = path.join(ROOT, 'extension');
const HOME = os.homedir();
const GEMINI_DIR = process.env.GEMINI_DIR || path.join(HOME, '.gemini');
const STATE_DIR = path.join(GEMINI_DIR, 'antigravity-chrome-bridge');
const PLUGIN_DIR = path.join(GEMINI_DIR, 'config', 'plugins', 'antigravity-chrome');
const CWS_GLOBAL_ID = 'jilnmjdedhlhhnlopjijgbkoblbeihmg';

const step = (msg) => console.log(`\n▶ ${msg}`);
const ok = (msg) => console.log(`  ✔ ${msg}`);
const warn = (msg) => console.log(`  ⚠ ${msg}`);

// 1. Identity + icons --------------------------------------------------------
step('Preparing extension identity and minimalist icons');
execFileSync(process.execPath, [path.join(__dirname, 'generate-icons.js')], { stdio: 'inherit' });
const identity = JSON.parse(fs.readFileSync(path.join(BRIDGE, 'extension-id.json'), 'utf8'));

const manifestPath = path.join(EXTENSION, 'manifest.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
if (manifest.key !== identity.manifestKey) {
  manifest.key = identity.manifestKey;
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  ok('updated manifest.json "key"');
}
ok(`Local Unpacked ID: ${identity.extensionId}`);
ok(`Global Web Store ID: ${identity.cwsExtensionId || CWS_GLOBAL_ID}`);

// 2. Native messaging host ---------------------------------------------------
step('Registering Chrome Native Messaging host (Local + Global CWS)');
fs.mkdirSync(STATE_DIR, { recursive: true });

const allowedIdsFile = path.join(STATE_DIR, 'allowed-extensions.json');
let existingExtraIds = [];
try {
  existingExtraIds = JSON.parse(fs.readFileSync(allowedIdsFile, 'utf8'));
} catch (_e) {}
const mergedAllowedIds = Array.from(
  new Set([identity.extensionId, identity.cwsExtensionId || CWS_GLOBAL_ID, CWS_GLOBAL_ID, ...existingExtraIds].filter(Boolean))
);
fs.writeFileSync(allowedIdsFile, JSON.stringify(mergedAllowedIds, null, 2));

let launcherPath;
if (process.platform === 'win32') {
  launcherPath = path.join(STATE_DIR, 'native-host.cmd');
  fs.writeFileSync(launcherPath, `@echo off\r\n"${process.execPath}" "${path.join(BRIDGE, 'native-host.js')}" %*\r\n`);
} else {
  launcherPath = path.join(STATE_DIR, 'native-host.sh');
  fs.writeFileSync(launcherPath, `#!/bin/sh\nexec "${process.execPath}" "${path.join(BRIDGE, 'native-host.js')}" "$@"\n`, { mode: 0o755 });
}

const hostManifest = {
  name: identity.nativeHostName,
  description: 'Gemini Antigravity in Chrome v2.0 bridge',
  path: launcherPath,
  type: 'stdio',
  allowed_origins: mergedAllowedIds.map((id) => `chrome-extension://${id}/`)
};
const hostManifestFile = path.join(STATE_DIR, `${identity.nativeHostName}.json`);
fs.writeFileSync(hostManifestFile, JSON.stringify(hostManifest, null, 2));
ok(`host manifest: ${hostManifestFile}`);

if (process.platform === 'win32') {
  const browsers = {
    'Google Chrome': 'Software\\Google\\Chrome',
    'Microsoft Edge': 'Software\\Microsoft\\Edge',
    Chromium: 'Software\\Chromium',
    Brave: 'Software\\BraveSoftware\\Brave-Browser'
  };
  for (const [label, base] of Object.entries(browsers)) {
    const key = `HKCU\\${base}\\NativeMessagingHosts\\${identity.nativeHostName}`;
    try {
      execFileSync('reg', ['add', key, '/ve', '/t', 'REG_SZ', '/d', hostManifestFile, '/f'], { stdio: 'ignore' });
      ok(`registered for ${label}`);
    } catch (err) {
      warn(`could not register for ${label}: ${err.message}`);
    }
  }
} else {
  const dirs =
    process.platform === 'darwin'
      ? [
          'Library/Application Support/Google/Chrome',
          'Library/Application Support/Microsoft Edge',
          'Library/Application Support/Chromium',
          'Library/Application Support/BraveSoftware/Brave-Browser'
        ]
      : ['.config/google-chrome', '.config/microsoft-edge', '.config/chromium', '.config/BraveSoftware/Brave-Browser'];
  for (const rel of dirs) {
    const dir = path.join(HOME, rel, 'NativeMessagingHosts');
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `${identity.nativeHostName}.json`), JSON.stringify(hostManifest, null, 2));
      ok(`registered in ${dir}`);
    } catch (err) {
      warn(`could not write ${dir}: ${err.message}`);
    }
  }
}

// 3. Antigravity plugin ------------------------------------------------------
step('Installing Antigravity plugin v2.0 (26 MCP tools + skill + rules)');
fs.mkdirSync(path.join(PLUGIN_DIR, 'skills', 'chrome-browser-control'), { recursive: true });
fs.mkdirSync(path.join(PLUGIN_DIR, 'rules'), { recursive: true });

fs.writeFileSync(
  path.join(PLUGIN_DIR, 'plugin.json'),
  JSON.stringify(
    {
      name: 'antigravity-chrome',
      displayName: 'Gemini Antigravity in Chrome',
      version: '2.0.0',
      description:
        "Autonomous browser control in the user's real Chrome: Shadow DOM & PDF reading, multi-tab synthesis, element picker, drag-and-drop, file uploads, GIF recording, and CDP DevTools.",
      suggestedPrompts: [
        'Synthesize all open tabs in my Antigravity Chrome group and summarize key findings',
        'Test http://localhost:3000 in Chrome, inspect layout styles, and check console/network errors',
        'Record a GIF while filling and testing the checkout workflow in Chrome'
      ]
    },
    null,
    2
  )
);

fs.writeFileSync(
  path.join(PLUGIN_DIR, 'mcp_config.json'),
  JSON.stringify(
    {
      mcpServers: {
        'antigravity-chrome': {
          command: process.execPath,
          args: [path.join(BRIDGE, 'mcp-server.js')],
          env: { AGY_CHROME_AUTOLAUNCH: '1' }
        }
      }
    },
    null,
    2
  )
);

fs.copyFileSync(
  path.join(ROOT, 'antigravity-plugin', 'skills', 'chrome-browser-control', 'SKILL.md'),
  path.join(PLUGIN_DIR, 'skills', 'chrome-browser-control', 'SKILL.md')
);
fs.copyFileSync(path.join(ROOT, 'antigravity-plugin', 'rules', 'AGENTS.md'), path.join(PLUGIN_DIR, 'rules', 'AGENTS.md'));
ok(`plugin installed at ${PLUGIN_DIR}`);

console.log(`
══════════════════════════════════════════════════════════════
 Gemini Antigravity in Chrome v2.0 Installed!
  • Unpacked path: ${EXTENSION}
  • Local Dev ID:  ${identity.extensionId}
  • Global CWS ID: ${identity.cwsExtensionId || CWS_GLOBAL_ID}
══════════════════════════════════════════════════════════════`);
