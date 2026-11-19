#!/usr/bin/env node
/** Removes the native messaging host registration and the Antigravity plugin. */

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const HOME = os.homedir();
const GEMINI_DIR = process.env.GEMINI_DIR || path.join(HOME, '.gemini');
const STATE_DIR = path.join(GEMINI_DIR, 'antigravity-chrome-bridge');
const PLUGIN_DIR = path.join(GEMINI_DIR, 'config', 'plugins', 'antigravity-chrome');
const HOST = 'com.google.antigravity.chrome_bridge';

if (process.platform === 'win32') {
  for (const base of [
    'Software\\Google\\Chrome',
    'Software\\Microsoft\\Edge',
    'Software\\Chromium',
    'Software\\BraveSoftware\\Brave-Browser'
  ]) {
    try {
      execFileSync('reg', ['delete', `HKCU\\${base}\\NativeMessagingHosts\\${HOST}`, '/f'], { stdio: 'ignore' });
    } catch (_e) {}
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
    fs.rmSync(path.join(HOME, rel, 'NativeMessagingHosts', `${HOST}.json`), { force: true });
  }
}

fs.rmSync(PLUGIN_DIR, { recursive: true, force: true });
fs.rmSync(STATE_DIR, { recursive: true, force: true });
console.log('Removed native host registration, Antigravity plugin, and bridge state.');
console.log('Remove the extension itself from chrome://extensions and restart Antigravity.');
