#!/usr/bin/env node
/**
 * Validates syntax across all extension & bridge scripts, builds `cws_build/`
 * (stripping the dev-only `"key"` field from manifest.json), verifies icon dimensions,
 * and creates `gemini-antigravity-chrome-v2.0.0.zip` ready for Chrome Web Store upload.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const EXT_DIR = path.join(ROOT, 'extension');
const BRIDGE_DIR = path.join(ROOT, 'bridge');
const CWS_DIR = path.join(ROOT, 'cws_build');

function collectJsFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collectJsFiles(full, out);
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

// 1. Syntax check every JS file
const allJs = [...collectJsFiles(EXT_DIR), ...collectJsFiles(BRIDGE_DIR)];
for (const file of allJs) {
  execFileSync(process.execPath, ['--check', file], { stdio: 'inherit' });
}
console.log(`✔ Syntax verified for ${allJs.length} JS files.`);

// 2. Verify icons & dimensions
const manifest = JSON.parse(fs.readFileSync(path.join(EXT_DIR, 'manifest.json'), 'utf8'));
for (const [sizeStr, relPath] of Object.entries(manifest.icons || {})) {
  const expected = Number(sizeStr);
  const full = path.join(EXT_DIR, relPath);
  if (!fs.existsSync(full)) {
    throw new Error(`Missing icon referenced in manifest.json: ${relPath}`);
  }
  const buf = fs.readFileSync(full);
  const w = buf.readUInt32BE(16);
  const h = buf.readUInt32BE(20);
  if (w !== expected || h !== expected) {
    throw new Error(`Icon ${relPath} is ${w}x${h}, expected ${expected}x${expected}`);
  }
}
console.log('✔ All manifest icons exist with exact pixel dimensions.');

// 3. Copy extension/ -> cws_build/ and strip "key"
fs.rmSync(CWS_DIR, { recursive: true, force: true });
fs.cpSync(EXT_DIR, CWS_DIR, { recursive: true });

const cwsManifestPath = path.join(CWS_DIR, 'manifest.json');
const cwsManifest = JSON.parse(fs.readFileSync(cwsManifestPath, 'utf8'));
delete cwsManifest.key;

if ((cwsManifest.name || '').length > 45) {
  throw new Error(`manifest.name length (${cwsManifest.name.length}) exceeds CWS 45-char limit.`);
}
if ((cwsManifest.short_name || '').length > 12) {
  throw new Error(`manifest.short_name length (${cwsManifest.short_name.length}) exceeds CWS 12-char limit.`);
}
if ((cwsManifest.description || '').length > 132) {
  throw new Error(`manifest.description length (${cwsManifest.description.length}) exceeds CWS 132-char limit.`);
}
console.log(`✔ CWS manifest limits verified (name=${cwsManifest.name.length}/45, short_name=${(cwsManifest.short_name || '').length}/12, description=${cwsManifest.description.length}/132).`);

fs.writeFileSync(cwsManifestPath, `${JSON.stringify(cwsManifest, null, 2)}\n`);

// Also sync root manifest.json (without key, matching CWS)
fs.writeFileSync(path.join(ROOT, 'manifest.json'), `${JSON.stringify(cwsManifest, null, 2)}\n`);
console.log(`✔ Built clean cws_build/ (v${cwsManifest.version}, "key" stripped).`);

// 4. Create ZIP archive
const zipName = `gemini-antigravity-chrome-v${cwsManifest.version}.zip`;
const zipPath = path.join(ROOT, zipName);
if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);

if (process.platform === 'win32') {
  execFileSync(
    'powershell',
    [
      '-NoProfile',
      '-Command',
      `Compress-Archive -Path '${CWS_DIR}\\*' -DestinationPath '${zipPath}' -Force`
    ],
    { stdio: 'inherit' }
  );
} else {
  execFileSync('zip', ['-r', zipPath, '.'], { cwd: CWS_DIR, stdio: 'inherit' });
}

const zipBytes = fs.statSync(zipPath).size;
console.log(`✔ Packaged Chrome Web Store archive: ${zipPath} (${zipBytes} bytes)`);
