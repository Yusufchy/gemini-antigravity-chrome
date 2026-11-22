/**
 * Local PC Download Tracker, Project-Folder Delivery & Content Ingestion Engine (v2.2.0).
 * Zero external dependencies — pure Node.js (fs, crypto, zlib, path, stream).
 *
 * Capabilities:
 *   1. Real-time Chrome download tracking pushed from chrome.downloads listeners.
 *   2. Atomic cross-drive (e.g. C:\Users\...\Downloads -> D:\project\...) streaming transfer
 *      with concurrent SHA-256 verification and Windows file-lock settle checks.
 *   3. Tier 2 (Base64/Blob buffer) & Tier 4 (Direct CDP-cookie authenticated HTTP stream) writers.
 *   4. Persistent global download ledger + per-project `.chrome-downloads.json` manifest.
 *   5. Watch-Project auto-mirroring (automatically routes new Chrome downloads into active projectDir).
 *   6. Dependency-free project content reader (JSON, RFC-4180 CSV/TSV, PDF FlateDecode text,
 *      PNG/JPEG/GIF/WEBP dimensions, ZIP End-of-Central-Directory entry lister, UTF-8 text/code).
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');

const MAX_RECORDS = 500;
const RESERVED_WIN_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

const MIME_TO_EXT = {
  'application/pdf': '.pdf',
  'application/json': '.json',
  'text/csv': '.csv',
  'text/tab-separated-values': '.tsv',
  'text/plain': '.txt',
  'text/markdown': '.md',
  'text/html': '.html',
  'application/xml': '.xml',
  'text/xml': '.xml',
  'application/zip': '.zip',
  'application/gzip': '.gz',
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'image/svg+xml': '.svg',
  'video/mp4': '.mp4',
  'audio/mpeg': '.mp3',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx'
};

const EXT_TO_MIME = {
  '.pdf': 'application/pdf',
  '.json': 'application/json',
  '.jsonl': 'application/x-ndjson',
  '.csv': 'text/csv',
  '.tsv': 'text/tab-separated-values',
  '.txt': 'text/plain',
  '.log': 'text/plain',
  '.md': 'text/markdown',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.xml': 'application/xml',
  '.svg': 'image/svg+xml',
  '.yaml': 'text/yaml',
  '.yml': 'text/yaml',
  '.js': 'text/javascript',
  '.ts': 'text/typescript',
  '.py': 'text/x-python',
  '.css': 'text/css',
  '.zip': 'application/zip',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.mp4': 'video/mp4',
  '.mp3': 'audio/mpeg'
};

const TEXT_EXTENSIONS = new Set([
  '.txt', '.md', '.markdown', '.json', '.jsonl', '.csv', '.tsv', '.xml', '.html', '.htm',
  '.svg', '.yaml', '.yml', '.toml', '.ini', '.env', '.log', '.sql', '.js', '.mjs', '.cjs',
  '.ts', '.tsx', '.jsx', '.css', '.scss', '.py', '.rb', '.go', '.rs', '.java', '.c', '.cpp',
  '.h', '.cs', '.php', '.sh', '.ps1', '.bat', '.cmd', '.gitignore', '.dockerfile'
]);

function sanitizeFilename(rawName, fallbackExt = '') {
  let base = path.basename(String(rawName || '').trim());
  base = base
    .replace(/[\x00-\x1f\x7f]/g, '')
    .replace(/[<>:"/\\|?*]+/g, '_')
    .replace(/^\.+/, '')
    .trim();
  if (!base || base === '.' || base === '..') {
    base = `download-${Date.now()}${fallbackExt || '.bin'}`;
  }
  if (RESERVED_WIN_NAMES.test(base)) {
    base = `_${base}`;
  }
  if (fallbackExt && !path.extname(base)) {
    base += fallbackExt;
  }
  if (base.length > 180) {
    const ext = path.extname(base);
    base = `${base.slice(0, 180 - ext.length)}${ext}`;
  }
  return base;
}

function parseContentDispositionFilename(header) {
  if (!header) return null;
  const starMatch = String(header).match(/filename\*\s*=\s*(?:UTF-8''|utf-8'')?([^;\r\n]+)/i);
  if (starMatch) {
    try {
      return decodeURIComponent(starMatch[1].trim().replace(/^["']|["']$/g, ''));
    } catch (_e) {
      return starMatch[1].trim().replace(/^["']|["']$/g, '');
    }
  }
  const plainMatch = String(header).match(/filename\s*=\s*"([^"]+)"|filename\s*=\s*([^;\r\n]+)/i);
  if (plainMatch) {
    return (plainMatch[1] || plainMatch[2] || '').trim();
  }
  return null;
}

function inferFilenameFromUrl(urlStr, mimeType = '') {
  const fallbackExt = MIME_TO_EXT[String(mimeType || '').split(';')[0].trim().toLowerCase()] || '';
  try {
    const u = new URL(urlStr);
    const seg = decodeURIComponent(u.pathname.split('/').filter(Boolean).pop() || '');
    if (seg && seg.length > 0 && seg.length <= 160) {
      return sanitizeFilename(seg, fallbackExt);
    }
  } catch (_e) {}
  return sanitizeFilename(`download-${Date.now()}${fallbackExt || '.bin'}`);
}

function resolveCollisionSafePath(destDir, filename, overwrite = false) {
  const cleanName = sanitizeFilename(filename);
  const full = path.join(destDir, cleanName);
  if (overwrite || !fs.existsSync(full)) return full;
  const ext = path.extname(cleanName);
  const stem = ext ? cleanName.slice(0, -ext.length) : cleanName;
  for (let i = 1; i <= 9999; i++) {
    const candidate = path.join(destDir, `${stem} (${i})${ext}`);
    if (!fs.existsSync(candidate)) return candidate;
  }
  return path.join(destDir, `${stem}-${Date.now()}${ext}`);
}

async function waitForFileStable(filePath, timeoutMs = 4500) {
  const deadline = Date.now() + timeoutMs;
  let lastSize = -1;
  let stableChecks = 0;

  while (Date.now() < deadline) {
    try {
      if (!filePath.endsWith('.crdownload') && fs.existsSync(filePath)) {
        const st = fs.statSync(filePath);
        if (st.isFile()) {
          // Verify file handle is readable (not exclusively locked by Chrome/AV)
          const fd = fs.openSync(filePath, 'r');
          fs.closeSync(fd);
          if (st.size === lastSize && (st.size > 0 || stableChecks >= 1)) {
            return st;
          }
          lastSize = st.size;
          stableChecks++;
        }
      }
    } catch (_e) {}
    await new Promise((r) => setTimeout(r, 80));
  }
  if (fs.existsSync(filePath)) {
    return fs.statSync(filePath);
  }
  throw new Error(`Downloaded file did not appear on disk in time: ${filePath}`);
}

async function hashFileSha256(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const rs = fs.createReadStream(filePath);
    rs.on('error', reject);
    rs.on('data', (chunk) => hash.update(chunk));
    rs.on('end', () => resolve(hash.digest('hex')));
  });
}

/**
 * Atomic cross-drive streaming transfer (handles C:\Downloads -> D:\project safely).
 * Computes SHA-256 on the fly in a single pass.
 */
async function transferFileAtomic(srcPath, destPath, mode = 'copy') {
  const resolvedSrc = path.resolve(srcPath);
  const resolvedDest = path.resolve(destPath);
  fs.mkdirSync(path.dirname(resolvedDest), { recursive: true });

  if (resolvedSrc.toLowerCase() === resolvedDest.toLowerCase()) {
    const st = fs.statSync(resolvedSrc);
    const sha256 = await hashFileSha256(resolvedSrc);
    return { destPath: resolvedDest, sizeBytes: st.size, sha256, mode: 'in-place' };
  }

  const tmpPath = `${resolvedDest}.part-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const hash = crypto.createHash('sha256');
  let bytesWritten = 0;

  try {
    const rs = fs.createReadStream(resolvedSrc);
    const ws = fs.createWriteStream(tmpPath);
    rs.on('data', (chunk) => {
      hash.update(chunk);
      bytesWritten += chunk.length;
    });
    await pipeline(rs, ws);
    fs.renameSync(tmpPath, resolvedDest);
  } catch (err) {
    try {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    } catch (_e) {}
    throw err;
  }

  const sha256 = hash.digest('hex');
  if (mode === 'move') {
    try {
      fs.unlinkSync(resolvedSrc);
    } catch (_e) {
      // Source may be locked briefly; destination is already verified & complete
    }
  }
  return { destPath: resolvedDest, sizeBytes: bytesWritten, sha256, mode };
}

function writeBufferAtomic(buf, destPath) {
  const resolvedDest = path.resolve(destPath);
  fs.mkdirSync(path.dirname(resolvedDest), { recursive: true });
  const tmpPath = `${resolvedDest}.part-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  try {
    fs.writeFileSync(tmpPath, buf);
    fs.renameSync(tmpPath, resolvedDest);
  } catch (err) {
    try {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    } catch (_e) {}
    throw err;
  }
  const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
  return { destPath: resolvedDest, sizeBytes: buf.length, sha256 };
}

// --- Zero-Dependency Project Content Parsers ---

function parseCsvText(rawText, delimiter = ',', maxRows = 200) {
  const rows = [];
  let row = [];
  let cell = '';
  let inQuotes = false;

  for (let i = 0; i < rawText.length; i++) {
    const ch = rawText[i];
    if (inQuotes) {
      if (ch === '"') {
        if (rawText[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cell += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === delimiter) {
      row.push(cell);
      cell = '';
    } else if (ch === '\r' || ch === '\n') {
      if (ch === '\r' && rawText[i + 1] === '\n') i++;
      row.push(cell);
      if (row.some((c) => c.length > 0)) rows.push(row);
      row = [];
      cell = '';
      if (rows.length > maxRows + 1) break;
    } else {
      cell += ch;
    }
  }
  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    if (row.some((c) => c.length > 0)) rows.push(row);
  }

  const headers = rows[0] || [];
  const dataRows = rows.slice(1, maxRows + 1);
  const objects = dataRows.map((r) => {
    const obj = {};
    headers.forEach((h, idx) => {
      obj[h || `col_${idx + 1}`] = r[idx] ?? '';
    });
    return obj;
  });
  return { headers, rowCount: dataRows.length, rows: objects };
}

function extractPdfTextFromBuffer(buf, maxChars = 32000) {
  const latin = buf.toString('latin1');
  const pageMatches = latin.match(/\/Type\s*\/Page\b(?!s)/g);
  const estimatedPages = pageMatches ? pageMatches.length : null;
  const chunks = [];

  function unescapePdfLiteral(str) {
    return str
      .replace(/\\n/g, '\n')
      .replace(/\\r/g, ' ')
      .replace(/\\t/g, ' ')
      .replace(/\\\(/g, '(')
      .replace(/\\\)/g, ')')
      .replace(/\\\\/g, '\\');
  }

  function parseOperators(content) {
    const tjRe = /\(([^()\\]*(?:\\.[^()\\]*)*)\)\s*Tj/g;
    let m;
    while ((m = tjRe.exec(content)) !== null) {
      chunks.push(unescapePdfLiteral(m[1]));
    }
    const arrRe = /\[([\s\S]*?)\]\s*TJ/g;
    while ((m = arrRe.exec(content)) !== null) {
      const litRe = /\(([^()\\]*(?:\\.[^()\\]*)*)\)/g;
      let lm;
      const parts = [];
      while ((lm = litRe.exec(m[1])) !== null) {
        parts.push(unescapePdfLiteral(lm[1]));
      }
      if (parts.length) chunks.push(parts.join(''));
    }
  }

  const streamRe = /<<([\s\S]*?)>>\s*stream\r?\n/g;
  let sm;
  let count = 0;
  while ((sm = streamRe.exec(latin)) !== null && count < 80) {
    const dict = sm[1];
    const start = sm.index + sm[0].length;
    const end = latin.indexOf('endstream', start);
    if (end === -1) break;
    count++;

    let endIdx = end;
    if (buf[endIdx - 1] === 0x0a) endIdx--;
    if (buf[endIdx - 1] === 0x0d) endIdx--;
    const slice = buf.subarray(start, endIdx);

    if (/\/FlateDecode/.test(dict)) {
      let inflated = null;
      try {
        inflated = zlib.inflateSync(slice);
      } catch (_e1) {
        try {
          inflated = zlib.inflateRawSync(slice);
        } catch (_e2) {}
      }
      if (inflated) {
        const txt = inflated.toString('latin1');
        if (/BT[\s\S]*ET/.test(txt)) parseOperators(txt);
      }
    } else {
      const txt = slice.toString('latin1');
      if (/BT[\s\S]*ET/.test(txt)) parseOperators(txt);
    }
  }

  const text = chunks
    .join(' ')
    .replace(/[^\x09\x0A\x0D\x20-\x7E\u00A0-\uFFFF]/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .slice(0, maxChars);

  return { estimatedPages, text };
}

function parseImageDimensions(buf) {
  if (buf.length >= 24 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return { format: 'png', mimeType: 'image/png', width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  if (buf.length >= 10 && buf.toString('ascii', 0, 3) === 'GIF') {
    return { format: 'gif', mimeType: 'image/gif', width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
  }
  if (buf.length >= 30 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    const chunk = buf.toString('ascii', 12, 16);
    if (chunk === 'VP8X' && buf.length >= 30) {
      const w = 1 + (buf[24] | (buf[25] << 8) | (buf[26] << 16));
      const h = 1 + (buf[27] | (buf[28] << 8) | (buf[29] << 16));
      return { format: 'webp', mimeType: 'image/webp', width: w, height: h };
    }
    if (chunk === 'VP8 ' && buf.length >= 30) {
      return { format: 'webp', mimeType: 'image/webp', width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
    }
    if (chunk === 'VP8L' && buf.length >= 25) {
      const bits = buf.readUInt32LE(21);
      return { format: 'webp', mimeType: 'image/webp', width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
    }
    return { format: 'webp', mimeType: 'image/webp', width: null, height: null };
  }
  if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < buf.length) {
      if (buf[offset] !== 0xff) break;
      const marker = buf[offset + 1];
      const segLen = buf.readUInt16BE(offset + 2);
      if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2) {
        return {
          format: 'jpeg',
          mimeType: 'image/jpeg',
          height: buf.readUInt16BE(offset + 5),
          width: buf.readUInt16BE(offset + 7)
        };
      }
      if (segLen < 2) break;
      offset += 2 + segLen;
    }
    return { format: 'jpeg', mimeType: 'image/jpeg', width: null, height: null };
  }
  return null;
}

function listZipEntriesFromBuffer(buf, maxEntries = 200) {
  // Locate End of Central Directory (signature 0x06054b50) scanning backwards
  const minPos = Math.max(0, buf.length - 65557);
  let eocd = -1;
  for (let i = buf.length - 22; i >= minPos; i--) {
    if (buf[i] === 0x50 && buf[i + 1] === 0x4b && buf[i + 2] === 0x05 && buf[i + 3] === 0x06) {
      eocd = i;
      break;
    }
  }
  if (eocd === -1) return null;

  const totalEntries = buf.readUInt16LE(eocd + 10);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  const entries = [];
  let pos = cdOffset;

  for (let idx = 0; idx < totalEntries && entries.length < maxEntries; idx++) {
    if (pos + 46 > buf.length) break;
    if (buf.readUInt32LE(pos) !== 0x02014b50) break;
    const compressedSize = buf.readUInt32LE(pos + 20);
    const uncompressedSize = buf.readUInt32LE(pos + 24);
    const nameLen = buf.readUInt16LE(pos + 28);
    const extraLen = buf.readUInt16LE(pos + 30);
    const commentLen = buf.readUInt16LE(pos + 32);
    const name = buf.toString('utf8', pos + 46, pos + 46 + nameLen);
    entries.push({ name, compressedSize, uncompressedSize });
    pos += 46 + nameLen + extraLen + commentLen;
  }
  return { totalEntries, entries };
}

class DownloadManager {
  constructor({ stateDir }) {
    this.stateDir = stateDir;
    this.indexPath = path.join(stateDir, 'downloads-index.json');
    this.records = []; // newest first
    this.byChromeId = new Map();
    this.waiters = new Set();
    this.watchConfig = {
      enabled: false,
      projectDir: null,
      subdir: '',
      mode: 'copy', // 'copy' | 'move'
      extensions: null, // null = all
      writeManifest: true
    };
    this.agentProjectDirs = new Map(); // agentId -> projectDir
    this._loadIndex();
  }

  _loadIndex() {
    try {
      if (fs.existsSync(this.indexPath)) {
        const parsed = JSON.parse(fs.readFileSync(this.indexPath, 'utf8'));
        if (Array.isArray(parsed.records)) {
          this.records = parsed.records.slice(0, MAX_RECORDS);
          for (const rec of this.records) {
            if (typeof rec.downloadId === 'number') {
              this.byChromeId.set(rec.downloadId, rec);
            }
          }
        }
        if (parsed.watchConfig && typeof parsed.watchConfig === 'object') {
          this.watchConfig = { ...this.watchConfig, ...parsed.watchConfig };
        }
      }
    } catch (_e) {
      this.records = [];
    }
  }

  _saveIndex() {
    try {
      fs.mkdirSync(this.stateDir, { recursive: true });
      const tmp = `${this.indexPath}.tmp-${process.pid}`;
      fs.writeFileSync(
        tmp,
        JSON.stringify({ version: '2.2.0', watchConfig: this.watchConfig, records: this.records.slice(0, MAX_RECORDS) }, null, 2)
      );
      fs.renameSync(tmp, this.indexPath);
    } catch (_e) {}
  }

  _appendProjectManifest(projectDir, record) {
    if (!projectDir) return;
    try {
      const manifestPath = path.join(path.resolve(projectDir), '.chrome-downloads.json');
      let entries = [];
      if (fs.existsSync(manifestPath)) {
        try {
          const parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
          entries = Array.isArray(parsed.files) ? parsed.files : [];
        } catch (_e) {}
      }
      const next = [
        {
          id: record.id,
          downloadId: record.downloadId ?? null,
          filename: record.filename,
          projectPath: record.projectPath,
          relativePath: record.projectPath ? path.relative(path.resolve(projectDir), record.projectPath) : record.filename,
          url: record.url || null,
          mimeType: record.mimeType || null,
          sizeBytes: record.sizeBytes ?? null,
          sha256: record.sha256 || null,
          strategy: record.strategy || null,
          agentId: record.agentId || null,
          tabId: record.tabId ?? null,
          savedAt: record.completedAt || new Date().toISOString()
        },
        ...entries.filter((e) => e.projectPath !== record.projectPath)
      ].slice(0, 300);

      const tmp = `${manifestPath}.tmp-${process.pid}`;
      fs.writeFileSync(tmp, JSON.stringify({ updatedAt: new Date().toISOString(), count: next.length, files: next }, null, 2));
      fs.renameSync(tmp, manifestPath);
    } catch (_e) {}
  }

  setAgentProjectDir(agentId, projectDir) {
    if (!agentId) return;
    if (projectDir) this.agentProjectDirs.set(String(agentId), path.resolve(String(projectDir)));
    else this.agentProjectDirs.delete(String(agentId));
  }

  getEffectiveProjectDir(explicitProjectDir, agentId) {
    if (explicitProjectDir) return path.resolve(String(explicitProjectDir));
    if (agentId && this.agentProjectDirs.has(String(agentId))) {
      return this.agentProjectDirs.get(String(agentId));
    }
    if (this.watchConfig.enabled && this.watchConfig.projectDir) {
      return this.watchConfig.subdir
        ? path.join(this.watchConfig.projectDir, this.watchConfig.subdir)
        : this.watchConfig.projectDir;
    }
    return null;
  }

  configureWatchProject(params = {}) {
    if (params.disable || params.enabled === false) {
      this.watchConfig.enabled = false;
      this._saveIndex();
      return { ...this.watchConfig };
    }
    if (!params.projectDir) {
      throw new Error('Parameter "projectDir" is required when enabling watch_project.');
    }
    const resolvedDir = path.resolve(String(params.projectDir));
    fs.mkdirSync(resolvedDir, { recursive: true });
    this.watchConfig = {
      enabled: true,
      projectDir: resolvedDir,
      subdir: params.subdir ? String(params.subdir).replace(/^[/\\]+/, '') : '',
      mode: params.mode === 'move' ? 'move' : 'copy',
      extensions: Array.isArray(params.extensions) && params.extensions.length > 0
        ? params.extensions.map((e) => (String(e).startsWith('.') ? String(e).toLowerCase() : `.${String(e).toLowerCase()}`))
        : null,
      writeManifest: params.writeManifest !== false
    };
    if (params.agentId) {
      this.setAgentProjectDir(params.agentId, resolvedDir);
    }
    this._saveIndex();
    return { ...this.watchConfig };
  }

  getSummary() {
    const completeCount = this.records.filter((r) => r.state === 'complete').length;
    const syncedCount = this.records.filter((r) => Boolean(r.projectPath)).length;
    return {
      trackedCount: this.records.length,
      completeCount,
      syncedToProjectCount: syncedCount,
      watchEnabled: Boolean(this.watchConfig.enabled),
      watchProjectDir: this.watchConfig.enabled ? this.watchConfig.projectDir : null,
      latest: this.records[0]
        ? {
            filename: this.records[0].filename,
            state: this.records[0].state,
            projectPath: this.records[0].projectPath || null,
            chromePath: this.records[0].chromePath || null,
            completedAt: this.records[0].completedAt || null
          }
        : null
    };
  }

  upsertRecord(patch) {
    let rec = null;
    if (typeof patch.downloadId === 'number') {
      rec = this.byChromeId.get(patch.downloadId) || null;
    }
    if (!rec && patch.id) {
      rec = this.records.find((r) => r.id === patch.id) || null;
    }
    if (!rec) {
      rec = {
        id: patch.id || `dl-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        downloadId: typeof patch.downloadId === 'number' ? patch.downloadId : null,
        url: patch.url || null,
        finalUrl: patch.finalUrl || null,
        filename: patch.filename || null,
        chromePath: patch.chromePath || null,
        projectPath: patch.projectPath || null,
        projectDir: patch.projectDir || null,
        mimeType: patch.mimeType || null,
        sizeBytes: patch.sizeBytes ?? null,
        bytesReceived: patch.bytesReceived ?? 0,
        totalBytes: patch.totalBytes ?? -1,
        sha256: patch.sha256 || null,
        state: patch.state || 'in_progress',
        error: patch.error || null,
        strategy: patch.strategy || 'chrome_downloads',
        tabId: patch.tabId ?? null,
        agentId: patch.agentId || null,
        startedAt: patch.startedAt || new Date().toISOString(),
        completedAt: patch.completedAt || null
      };
      this.records.unshift(rec);
      if (this.records.length > MAX_RECORDS) {
        const dropped = this.records.pop();
        if (typeof dropped?.downloadId === 'number') this.byChromeId.delete(dropped.downloadId);
      }
      if (typeof rec.downloadId === 'number') {
        this.byChromeId.set(rec.downloadId, rec);
      }
    } else {
      Object.assign(rec, patch);
      if (typeof rec.downloadId === 'number') {
        this.byChromeId.set(rec.downloadId, rec);
      }
    }
    if (!rec.filename && (rec.projectPath || rec.chromePath)) {
      rec.filename = path.basename(rec.projectPath || rec.chromePath);
    }
    this._saveIndex();
    return rec;
  }

  /**
   * Called by BridgeHub whenever service-worker.js pushes a chrome.downloads event.
   */
  async handleChromeDownloadEvent(ev = {}) {
    const item = ev.item || {};
    const downloadId = typeof item.id === 'number' ? item.id : ev.downloadId;
    if (typeof downloadId !== 'number') return null;

    if (ev.kind === 'erased') {
      const existing = this.byChromeId.get(downloadId);
      if (existing) existing.erasedInChrome = true;
      this._saveIndex();
      return existing || null;
    }

    const chromePath = item.filename || undefined;
    const patch = {
      downloadId,
      url: item.url || undefined,
      finalUrl: item.finalUrl || undefined,
      chromePath,
      filename: chromePath ? path.basename(chromePath) : undefined,
      mimeType: item.mime || undefined,
      bytesReceived: typeof item.bytesReceived === 'number' ? item.bytesReceived : undefined,
      totalBytes: typeof item.totalBytes === 'number' ? item.totalBytes : undefined,
      sizeBytes: typeof item.fileSize === 'number' && item.fileSize >= 0 ? item.fileSize : undefined,
      state: item.state || undefined,
      error: item.error || undefined,
      startedAt: item.startTime || undefined,
      completedAt: item.endTime || (item.state === 'complete' ? new Date().toISOString() : undefined)
    };
    // Strip undefined values so we don't clobber populated fields
    for (const k of Object.keys(patch)) {
      if (patch[k] === undefined) delete patch[k];
    }

    const rec = this.upsertRecord(patch);

    if (rec.state === 'complete' && rec.chromePath) {
      // Auto-hash & auto-mirror if watch_project is active
      try {
        const st = await waitForFileStable(rec.chromePath, 3500);
        rec.sizeBytes = st.size;
        if (!rec.sha256) {
          rec.sha256 = await hashFileSha256(rec.chromePath);
        }
        if (this.watchConfig.enabled && this.watchConfig.projectDir && !rec.projectPath) {
          const ext = path.extname(rec.chromePath).toLowerCase();
          const extAllowed = !this.watchConfig.extensions || this.watchConfig.extensions.includes(ext);
          if (extAllowed) {
            const targetDir = this.watchConfig.subdir
              ? path.join(this.watchConfig.projectDir, this.watchConfig.subdir)
              : this.watchConfig.projectDir;
            await this.syncRecordToProject(rec, {
              projectDir: targetDir,
              mode: this.watchConfig.mode,
              writeManifest: this.watchConfig.writeManifest
            });
          }
        } else {
          this._saveIndex();
        }
      } catch (_e) {}
    }

    this._notifyWaiters(rec);
    return rec;
  }

  _notifyWaiters(rec) {
    for (const waiter of [...this.waiters]) {
      if (waiter.matches(rec)) {
        this.waiters.delete(waiter);
        clearTimeout(waiter.timer);
        waiter.resolve(rec);
      }
    }
  }

  waitForDownload({ downloadId, filenamePattern, sinceMs, excludeDownloadIds, onlyChromeDownloads = false, timeoutMs = 45000 } = {}) {
    const re = filenamePattern ? new RegExp(filenamePattern, 'i') : null;
    const excluded = excludeDownloadIds instanceof Set
      ? excludeDownloadIds
      : Array.isArray(excludeDownloadIds)
        ? new Set(excludeDownloadIds)
        : null;

    const matches = (rec) => {
      if (!rec) return false;
      if (rec.state !== 'complete' && rec.state !== 'interrupted') return false;
      if (onlyChromeDownloads && typeof rec.downloadId !== 'number') return false;
      if (excluded && typeof rec.downloadId === 'number' && excluded.has(rec.downloadId)) return false;
      if (typeof downloadId === 'number' && rec.downloadId !== downloadId) return false;
      if (sinceMs) {
        const ts = Date.parse(rec.completedAt || rec.startedAt || '') || 0;
        if (ts < sinceMs - 500) return false;
      }
      if (re && !re.test(rec.filename || rec.chromePath || rec.url || '')) return false;
      return true;
    };

    const existing = this.records.find(matches);
    if (existing) return Promise.resolve(existing);

    return new Promise((resolve, reject) => {
      const waiter = {
        matches,
        resolve,
        timer: setTimeout(() => {
          this.waiters.delete(waiter);
          reject(new Error(`Timed out after ${timeoutMs}ms waiting for Chrome download to finish.`));
        }, timeoutMs)
      };
      this.waiters.add(waiter);
    });
  }

  async syncRecordToProject(rec, { projectDir, savePath, filename, mode = 'copy', overwrite = false, writeManifest = true } = {}) {
    const srcPath = rec.chromePath && fs.existsSync(rec.chromePath)
      ? rec.chromePath
      : rec.projectPath && fs.existsSync(rec.projectPath)
        ? rec.projectPath
        : null;
    if (!srcPath) {
      throw new Error(`Source file not found on disk for download ${rec.downloadId ?? rec.id} (${rec.chromePath || rec.filename}).`);
    }

    await waitForFileStable(srcPath, 4000);

    let destPath;
    let resolvedProjectDir;
    if (savePath) {
      destPath = path.resolve(String(savePath));
      resolvedProjectDir = projectDir ? path.resolve(String(projectDir)) : path.dirname(destPath);
    } else if (projectDir) {
      resolvedProjectDir = path.resolve(String(projectDir));
      fs.mkdirSync(resolvedProjectDir, { recursive: true });
      const targetName = filename ? sanitizeFilename(filename) : path.basename(srcPath);
      destPath = resolveCollisionSafePath(resolvedProjectDir, targetName, overwrite);
    } else {
      throw new Error('Provide "projectDir" or "savePath" to sync a download into a project folder.');
    }

    const transfer = await transferFileAtomic(srcPath, destPath, mode === 'move' ? 'move' : 'copy');
    rec.projectPath = transfer.destPath;
    rec.projectDir = resolvedProjectDir;
    rec.filename = path.basename(transfer.destPath);
    rec.sizeBytes = transfer.sizeBytes;
    rec.sha256 = transfer.sha256;
    rec.syncMode = transfer.mode;
    rec.syncedAt = new Date().toISOString();
    this._saveIndex();

    if (writeManifest !== false) {
      this._appendProjectManifest(resolvedProjectDir, rec);
    }
    return rec;
  }

  async saveBase64ToProject({
    base64,
    url,
    filename,
    mimeType,
    projectDir,
    savePath,
    overwrite = false,
    writeManifest = true,
    tabId = null,
    agentId = null,
    strategy = 'page_fetch'
  }) {
    const buf = Buffer.from(String(base64 || ''), 'base64');
    const inferredName = filename
      ? sanitizeFilename(filename, MIME_TO_EXT[String(mimeType || '').split(';')[0].trim().toLowerCase()] || '')
      : inferFilenameFromUrl(url || '', mimeType);

    let destPath;
    let resolvedProjectDir;
    if (savePath) {
      destPath = path.resolve(String(savePath));
      resolvedProjectDir = projectDir ? path.resolve(String(projectDir)) : path.dirname(destPath);
    } else {
      resolvedProjectDir = this.getEffectiveProjectDir(projectDir, agentId);
      if (!resolvedProjectDir) {
        resolvedProjectDir = path.join(this.stateDir, 'downloads');
      }
      fs.mkdirSync(resolvedProjectDir, { recursive: true });
      destPath = resolveCollisionSafePath(resolvedProjectDir, inferredName, overwrite);
    }

    const written = writeBufferAtomic(buf, destPath);
    const rec = this.upsertRecord({
      url: url || null,
      finalUrl: url || null,
      filename: path.basename(written.destPath),
      projectPath: written.destPath,
      projectDir: resolvedProjectDir,
      mimeType: mimeType || EXT_TO_MIME[path.extname(written.destPath).toLowerCase()] || 'application/octet-stream',
      sizeBytes: written.sizeBytes,
      bytesReceived: written.sizeBytes,
      totalBytes: written.sizeBytes,
      sha256: written.sha256,
      state: 'complete',
      strategy,
      tabId,
      agentId,
      completedAt: new Date().toISOString()
    });

    if (writeManifest !== false) {
      this._appendProjectManifest(resolvedProjectDir, rec);
    }
    return rec;
  }

  async streamUrlToProject({
    url,
    cookies = [],
    userAgent,
    referer,
    filename,
    projectDir,
    savePath,
    overwrite = false,
    writeManifest = true,
    timeoutMs = 60000,
    tabId = null,
    agentId = null
  }) {
    const headers = {};
    if (Array.isArray(cookies) && cookies.length > 0) {
      headers.Cookie = cookies.map((c) => `${c.name}=${c.value}`).join('; ');
    }
    if (userAgent) headers['User-Agent'] = userAgent;
    if (referer) headers.Referer = referer;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let resp;
    try {
      resp = await fetch(url, { headers, redirect: 'follow', signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }

    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status} ${resp.statusText} while streaming ${url}`);
    }

    const mimeType = (resp.headers.get('content-type') || '').split(';')[0].trim().toLowerCase() || 'application/octet-stream';
    const dispName = parseContentDispositionFilename(resp.headers.get('content-disposition'));
    const chosenName = filename
      ? sanitizeFilename(filename)
      : dispName
        ? sanitizeFilename(dispName)
        : inferFilenameFromUrl(resp.url || url, mimeType);

    let destPath;
    let resolvedProjectDir;
    if (savePath) {
      destPath = path.resolve(String(savePath));
      resolvedProjectDir = projectDir ? path.resolve(String(projectDir)) : path.dirname(destPath);
    } else {
      resolvedProjectDir = this.getEffectiveProjectDir(projectDir, agentId) || path.join(this.stateDir, 'downloads');
      fs.mkdirSync(resolvedProjectDir, { recursive: true });
      destPath = resolveCollisionSafePath(resolvedProjectDir, chosenName, overwrite);
    }

    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    const tmpPath = `${destPath}.part-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const hash = crypto.createHash('sha256');
    let bytesWritten = 0;

    try {
      const nodeStream = Readable.fromWeb(resp.body);
      const ws = fs.createWriteStream(tmpPath);
      nodeStream.on('data', (chunk) => {
        hash.update(chunk);
        bytesWritten += chunk.length;
      });
      await pipeline(nodeStream, ws);
      fs.renameSync(tmpPath, destPath);
    } catch (err) {
      try {
        if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
      } catch (_e) {}
      throw err;
    }

    const rec = this.upsertRecord({
      url,
      finalUrl: resp.url || url,
      filename: path.basename(destPath),
      projectPath: destPath,
      projectDir: resolvedProjectDir,
      mimeType,
      sizeBytes: bytesWritten,
      bytesReceived: bytesWritten,
      totalBytes: bytesWritten,
      sha256: hash.digest('hex'),
      state: 'complete',
      strategy: 'node_stream',
      tabId,
      agentId,
      completedAt: new Date().toISOString()
    });

    if (writeManifest !== false) {
      this._appendProjectManifest(resolvedProjectDir, rec);
    }
    return rec;
  }

  mergeChromeSearchItems(items = []) {
    for (const item of items) {
      if (typeof item.id !== 'number') continue;
      const existing = this.byChromeId.get(item.id);
      const chromePath = item.filename || existing?.chromePath || null;
      this.upsertRecord({
        downloadId: item.id,
        url: item.url || existing?.url || null,
        finalUrl: item.finalUrl || existing?.finalUrl || null,
        chromePath,
        filename: chromePath ? path.basename(chromePath) : existing?.filename || null,
        mimeType: item.mime || existing?.mimeType || null,
        bytesReceived: typeof item.bytesReceived === 'number' ? item.bytesReceived : existing?.bytesReceived ?? 0,
        totalBytes: typeof item.totalBytes === 'number' ? item.totalBytes : existing?.totalBytes ?? -1,
        sizeBytes:
          typeof item.fileSize === 'number' && item.fileSize >= 0
            ? item.fileSize
            : existing?.sizeBytes ?? null,
        state: item.state || existing?.state || 'complete',
        error: item.error || existing?.error || null,
        startedAt: item.startTime || existing?.startedAt,
        completedAt: item.endTime || existing?.completedAt
      });
    }
  }

  listDownloads({ projectDir, state, query, agentId, limit = 30 } = {}) {
    const resolvedDir = projectDir ? path.resolve(String(projectDir)).toLowerCase() : null;
    const re = query ? new RegExp(String(query), 'i') : null;

    return this.records
      .filter((r) => {
        if (state && r.state !== state) return false;
        if (agentId && r.agentId !== agentId) return false;
        if (resolvedDir && (!r.projectPath || !path.resolve(r.projectPath).toLowerCase().startsWith(resolvedDir))) {
          return false;
        }
        if (re && !re.test(`${r.filename || ''} ${r.url || ''} ${r.projectPath || ''} ${r.chromePath || ''}`)) {
          return false;
        }
        return true;
      })
      .slice(0, Math.min(200, Number(limit) || 30))
      .map((r) => {
        const diskPath = r.projectPath && fs.existsSync(r.projectPath)
          ? r.projectPath
          : r.chromePath && fs.existsSync(r.chromePath)
            ? r.chromePath
            : null;
        const progressPct =
          r.state === 'complete'
            ? 100
            : r.totalBytes > 0
              ? Math.min(100, Math.round((r.bytesReceived / r.totalBytes) * 100))
              : null;
        return {
          ...r,
          progressPct,
          existsOnDisk: Boolean(diskPath),
          activePath: diskPath
        };
      });
  }

  findRecord({ downloadId, id, filePath, filename, latest = false } = {}) {
    if (typeof downloadId === 'number') {
      return this.byChromeId.get(downloadId) || this.records.find((r) => r.downloadId === downloadId) || null;
    }
    if (id) return this.records.find((r) => r.id === id) || null;
    if (filePath) {
      const target = path.resolve(String(filePath)).toLowerCase();
      return (
        this.records.find(
          (r) =>
            (r.projectPath && path.resolve(r.projectPath).toLowerCase() === target) ||
            (r.chromePath && path.resolve(r.chromePath).toLowerCase() === target)
        ) || null
      );
    }
    if (filename) {
      const q = String(filename).toLowerCase();
      return this.records.find((r) => (r.filename || '').toLowerCase().includes(q)) || null;
    }
    if (latest) {
      return this.records.find((r) => r.state === 'complete') || this.records[0] || null;
    }
    return null;
  }

  readFileForProject({ downloadId, id, filePath, filename, latest = false, maxBytes = 65536, maxRows = 150, includeImage = false } = {}) {
    const rec = this.findRecord({ downloadId, id, filePath, filename, latest });
    const targetPath = filePath
      ? path.resolve(String(filePath))
      : rec?.projectPath && fs.existsSync(rec.projectPath)
        ? rec.projectPath
        : rec?.chromePath && fs.existsSync(rec.chromePath)
          ? rec.chromePath
          : null;

    if (!targetPath || !fs.existsSync(targetPath)) {
      throw new Error(`File not found on disk (${filePath || rec?.projectPath || rec?.chromePath || 'no matching download'}).`);
    }

    const st = fs.statSync(targetPath);
    const ext = path.extname(targetPath).toLowerCase();
    const sha256 = rec?.sha256 || crypto.createHash('sha256').update(fs.readFileSync(targetPath)).digest('hex');
    const baseMeta = {
      filePath: targetPath,
      filename: path.basename(targetPath),
      extension: ext,
      mimeType: rec?.mimeType || EXT_TO_MIME[ext] || 'application/octet-stream',
      sizeBytes: st.size,
      sha256,
      modifiedAt: st.mtime.toISOString(),
      downloadId: rec?.downloadId ?? null,
      sourceUrl: rec?.url || null
    };

    const readCap = Math.min(Number(maxBytes) || 65536, 512 * 1024);

    // Check magic bytes on first 16 bytes
    const headerBuf = Buffer.alloc(Math.min(st.size, 64));
    const fd = fs.openSync(targetPath, 'r');
    try {
      fs.readSync(fd, headerBuf, 0, headerBuf.length, 0);
    } finally {
      fs.closeSync(fd);
    }

    // PDF
    if (ext === '.pdf' || headerBuf.toString('latin1', 0, 5) === '%PDF-') {
      const fullBuf = st.size <= 25 * 1024 * 1024 ? fs.readFileSync(targetPath) : fs.readFileSync(targetPath).subarray(0, 25 * 1024 * 1024);
      const pdf = extractPdfTextFromBuffer(fullBuf, Math.min(readCap, 64000));
      return {
        ...baseMeta,
        kind: 'pdf',
        estimatedPages: pdf.estimatedPages,
        extractedCharCount: pdf.text.length,
        text: pdf.text
      };
    }

    // Images
    const imgInfo = parseImageDimensions(st.size <= 1024 * 1024 ? fs.readFileSync(targetPath) : headerBuf);
    if (imgInfo || ['.png', '.jpg', '.jpeg', '.gif', '.webp'].includes(ext)) {
      const dim = imgInfo || parseImageDimensions(fs.readFileSync(targetPath));
      const out = {
        ...baseMeta,
        kind: 'image',
        mimeType: dim?.mimeType || baseMeta.mimeType,
        width: dim?.width ?? null,
        height: dim?.height ?? null
      };
      if (includeImage && st.size <= 8 * 1024 * 1024) {
        out._imageBase64 = fs.readFileSync(targetPath).toString('base64');
      }
      return out;
    }

    // ZIP Archive
    if (ext === '.zip' || (headerBuf[0] === 0x50 && headerBuf[1] === 0x4b && headerBuf[2] === 0x03 && headerBuf[3] === 0x04)) {
      const zipBuf = st.size <= 64 * 1024 * 1024 ? fs.readFileSync(targetPath) : null;
      const listing = zipBuf ? listZipEntriesFromBuffer(zipBuf, 200) : null;
      return {
        ...baseMeta,
        kind: 'zip',
        totalEntries: listing?.totalEntries ?? null,
        entries: listing?.entries || []
      };
    }

    // Text / JSON / CSV / Code
    const looksText =
      TEXT_EXTENSIONS.has(ext) ||
      baseMeta.mimeType.startsWith('text/') ||
      baseMeta.mimeType.includes('json') ||
      baseMeta.mimeType.includes('xml') ||
      !headerBuf.includes(0);

    if (looksText) {
      const truncated = st.size > readCap;
      const sliceBuf = Buffer.alloc(Math.min(st.size, readCap));
      const tfd = fs.openSync(targetPath, 'r');
      try {
        fs.readSync(tfd, sliceBuf, 0, sliceBuf.length, 0);
      } finally {
        fs.closeSync(tfd);
      }
      const text = sliceBuf.toString('utf8');
      const lineCount = text.split(/\r?\n/).length;

      if (ext === '.json' || baseMeta.mimeType === 'application/json') {
        let parsed = null;
        let jsonSummary = null;
        if (!truncated) {
          try {
            parsed = JSON.parse(text);
            jsonSummary = Array.isArray(parsed)
              ? { type: 'array', length: parsed.length }
              : parsed && typeof parsed === 'object'
                ? { type: 'object', keys: Object.keys(parsed).slice(0, 40) }
                : { type: typeof parsed };
          } catch (_e) {}
        }
        return { ...baseMeta, kind: 'json', truncated, lineCount, jsonSummary, parsed, text };
      }

      if (ext === '.csv' || ext === '.tsv') {
        const csv = parseCsvText(text, ext === '.tsv' ? '\t' : ',', maxRows);
        return {
          ...baseMeta,
          kind: ext === '.tsv' ? 'tsv' : 'csv',
          truncated,
          lineCount,
          headers: csv.headers,
          rowCount: csv.rowCount,
          rows: csv.rows,
          text: text.slice(0, 8000)
        };
      }

      return { ...baseMeta, kind: 'text', truncated, lineCount, text };
    }

    return {
      ...baseMeta,
      kind: 'binary',
      headerHex: headerBuf.subarray(0, 24).toString('hex')
    };
  }

  clearHistory({ keepProjectFiles = true } = {}) {
    const prevCount = this.records.length;
    this.records = [];
    this.byChromeId.clear();
    this._saveIndex();
    return { cleared: true, previousCount: prevCount, keepProjectFiles };
  }
}

module.exports = {
  DownloadManager,
  sanitizeFilename,
  inferFilenameFromUrl,
  parseContentDispositionFilename
};
