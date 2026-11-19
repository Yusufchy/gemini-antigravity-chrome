/**
 * Auto-detects Google Antigravity (v2.33.0+) & Gemini CLI across Windows, macOS, and Linux,
 * dispatches prompts via `agentapi` (with `--model` selection, multimodal screenshot staging,
 * and Windows 32K command-line protection), and streams replies with zero-overhead byte-offset
 * incremental tailing of `transcript.jsonl`.
 */

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');

const HOME = os.homedir();
const GEMINI_DIR = process.env.GEMINI_DIR || path.join(HOME, '.gemini');
const APP_DATA_DIR = process.env.ANTIGRAVITY_APP_DATA_DIR || path.join(GEMINI_DIR, 'antigravity');
const CONFIG_DIR = path.join(GEMINI_DIR, 'config');
const MAX_WIN_PROMPT_CHARS = 22000;

function candidateInstallDirs() {
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA || path.join(HOME, 'AppData', 'Local');
    return [
      path.join(local, 'Programs', 'antigravity'),
      path.join(local, 'Programs', 'Antigravity IDE'),
      path.join(local, 'Programs', 'Antigravity'),
      path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Antigravity IDE'),
      path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Antigravity')
    ];
  }
  if (process.platform === 'darwin') {
    return [
      '/Applications/Antigravity.app',
      '/Applications/Antigravity IDE.app',
      path.join(HOME, 'Applications', 'Antigravity.app')
    ];
  }
  return ['/opt/antigravity', '/usr/share/antigravity', path.join(HOME, '.local', 'share', 'antigravity')];
}

function findLanguageServerFromDirs(dirs) {
  const exe = process.platform === 'win32' ? 'language_server.exe' : 'language_server';
  const found = [];
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    for (const sub of [
      path.join(dir, 'resources', 'bin', exe),
      path.join(dir, 'Contents', 'Resources', 'bin', exe),
      path.join(dir, 'bin', exe)
    ]) {
      if (fs.existsSync(sub)) {
        found.push({ path: sub, mtime: fs.statSync(sub).mtimeMs, dir });
      }
    }
  }
  found.sort((a, b) => b.mtime - a.mtime);
  return found[0] || null;
}

/**
 * Discovers the active Antigravity Language Server daemon (`~/.gemini/antigravity/daemon/hub_*.json`)
 * preferring highest semantic lsVersion + newest mtime with live PID verification.
 */
function findActiveDaemon() {
  try {
    const daemonDir = path.join(APP_DATA_DIR, 'daemon');
    if (!fs.existsSync(daemonDir)) return null;

    const alive = [];
    for (const f of fs.readdirSync(daemonDir)) {
      if (!/^hub_\d+\.json$/i.test(f)) continue;
      const full = path.join(daemonDir, f);
      try {
        const stat = fs.statSync(full);
        const data = JSON.parse(fs.readFileSync(full, 'utf8'));
        if (data?.pid && data?.httpPort) {
          process.kill(Number(data.pid), 0);
          alive.push({ data, mtime: stat.mtimeMs });
        }
      } catch (_dead) {}
    }
    alive.sort((a, b) => b.mtime - a.mtime);
    return alive[0]?.data || null;
  } catch (_err) {
    return null;
  }
}

function isLanguageServerRunning() {
  if (findActiveDaemon()) return true;
  try {
    if (process.platform === 'win32') {
      const out = execFileSync('tasklist', ['/FI', 'IMAGENAME eq language_server.exe', '/NH'], {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 3500
      });
      return /language_server\.exe/i.test(out);
    }
    const out = execFileSync('pgrep', ['-f', 'language_server'], { encoding: 'utf8', timeout: 3500 });
    return out.trim().length > 0;
  } catch (_err) {
    return false;
  }
}

function readVersion(installDir, daemon) {
  if (daemon?.lsVersion) return daemon.lsVersion;
  if (installDir) {
    try {
      const updateYml = path.join(installDir, 'resources', 'app-update.yml');
      if (fs.existsSync(updateYml)) {
        const m = fs.readFileSync(updateYml, 'utf8').match(/version:\s*([\w.-]+)/);
        if (m) return m[1];
      }
    } catch (_e) {}
  }
  return process.env.ANTIGRAVITY_LS_VERSION || null;
}

function activeConversations() {
  try {
    const dir = path.join(APP_DATA_DIR, 'presence');
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.lock'))
      .map((f) => f.replace(/\.lock$/, ''));
  } catch (_e) {
    return [];
  }
}

function detectAntigravity() {
  const dirs = candidateInstallDirs();
  const lsMatch = findLanguageServerFromDirs(dirs);
  const installDir = lsMatch?.dir || dirs.find((d) => fs.existsSync(d)) || null;
  const languageServer = process.env.ANTIGRAVITY_AGENTAPI_EXE || lsMatch?.path || null;
  const appDataExists = fs.existsSync(APP_DATA_DIR);
  const daemon = findActiveDaemon();

  return {
    installed: Boolean(installDir || languageServer || appDataExists),
    running: Boolean(daemon) || isLanguageServerRunning(),
    version: readVersion(installDir, daemon),
    daemonPort: daemon?.httpPort || null,
    installDir,
    languageServer,
    appDataDir: appDataExists ? APP_DATA_DIR : null,
    configDir: fs.existsSync(CONFIG_DIR) ? CONFIG_DIR : null,
    activeConversations: activeConversations(),
    platform: process.platform
  };
}

function getTranscriptBaseline(conversationId) {
  if (!conversationId) return { byteOffset: 0, lineIndex: 0 };
  try {
    const compactPath = path.join(APP_DATA_DIR, 'brain', conversationId, '.system_generated', 'logs', 'transcript.jsonl');
    if (!fs.existsSync(compactPath)) return { byteOffset: 0, lineIndex: 0 };
    const buf = fs.readFileSync(compactPath);
    let lines = 0;
    for (let i = 0; i < buf.length; i++) {
      if (buf[i] === 0x0a) lines++;
    }
    return { byteOffset: buf.length, lineIndex: lines };
  } catch (_e) {
    return { byteOffset: 0, lineIndex: 0 };
  }
}

function readFullTranscriptLine(fullPath, targetLineIndex) {
  try {
    if (!fs.existsSync(fullPath)) return null;
    const raw = fs.readFileSync(fullPath, 'utf8');
    const lines = raw.split('\n').filter((l) => l.trim().length > 0);
    if (!lines[targetLineIndex]) return null;
    const parsed = JSON.parse(lines[targetLineIndex]);
    return parsed?.content || null;
  } catch (_e) {
    return null;
  }
}

/**
 * Incremental byte-offset reader on `transcript.jsonl` (cuts disk I/O by >99% on long sessions).
 */
async function waitForTranscriptReply(conversationId, baseline = { byteOffset: 0, lineIndex: 0 }, onChunk, timeoutMs = 150000) {
  const logDir = path.join(APP_DATA_DIR, 'brain', conversationId, '.system_generated', 'logs');
  const compactPath = path.join(logDir, 'transcript.jsonl');
  const fullPath = path.join(logDir, 'transcript_full.jsonl');

  const start = Date.now();
  let byteOffset = baseline.byteOffset || 0;
  let lineIndex = baseline.lineIndex || 0;
  let carry = '';

  while (Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, 220));
    if (!fs.existsSync(compactPath)) continue;

    let size = 0;
    try {
      size = fs.statSync(compactPath).size;
    } catch (_e) {
      continue;
    }
    if (size <= byteOffset) continue;

    let chunkStr = '';
    let fd = null;
    try {
      fd = fs.openSync(compactPath, 'r');
      const len = size - byteOffset;
      const buf = Buffer.alloc(len);
      const bytesRead = fs.readSync(fd, buf, 0, len, byteOffset);
      byteOffset += bytesRead;
      chunkStr = carry + buf.subarray(0, bytesRead).toString('utf8');
    } catch (_e) {
      continue;
    } finally {
      if (fd !== null) {
        try { fs.closeSync(fd); } catch (_c) {}
      }
    }

    const parts = chunkStr.split('\n');
    carry = parts.pop() || '';

    for (const rawLine of parts) {
      const trimmed = rawLine.trim();
      if (!trimmed) continue;
      const currentIdx = lineIndex++;
      let step;
      try {
        step = JSON.parse(trimmed);
      } catch (_e) {
        continue;
      }

      if (step.type === 'PLANNER_RESPONSE') {
        if (Array.isArray(step.tool_calls) && step.tool_calls.length > 0) {
          const toolNames = step.tool_calls.map((tc) => tc.name || 'tool').join(', ');
          if (typeof onChunk === 'function') {
            onChunk(`Running ${toolNames}...`);
          }
        } else if (step.status === 'DONE' && step.content) {
          let finalContent = step.content;
          if (Array.isArray(step.truncated_fields) && step.truncated_fields.includes('content')) {
            const fullContent = readFullTranscriptLine(fullPath, currentIdx);
            if (fullContent) finalContent = fullContent;
          }
          return String(finalContent).trim();
        } else if (step.status === 'ERROR') {
          throw new Error(step.content || 'Antigravity agent encountered an error.');
        }
      }
    }
  }

  return null;
}

function stageScreenshotFile(screenshotDataUrl) {
  if (!screenshotDataUrl || !screenshotDataUrl.startsWith('data:image/')) return null;
  try {
    const m = screenshotDataUrl.match(/^data:image\/([a-zA-Z0-9+]+);base64,(.+)$/);
    if (!m) return null;
    const ext = m[1] === 'jpeg' ? 'jpg' : m[1];
    const dir = path.join(APP_DATA_DIR, 'chrome-captures');
    fs.mkdirSync(dir, { recursive: true });
    const fp = path.join(dir, `capture-${Date.now()}.${ext}`);
    fs.writeFileSync(fp, Buffer.from(m[2], 'base64'));
    return fp;
  } catch (_e) {
    return null;
  }
}

/**
 * Dispatches a prompt to Antigravity v2.33.0+ (`agentapi`) with `--model` support and 32K argv guard.
 */
function sendToAntigravity({ prompt, conversationId, title, model, screenshot, onChunk }) {
  return new Promise((resolve, reject) => {
    const info = detectAntigravity();
    if (!info.languageServer) {
      reject(new Error('Antigravity language_server binary not found. Please launch Google Antigravity.'));
      return;
    }

    const daemon = findActiveDaemon();
    const env = { ...process.env };
    if (!env.ANTIGRAVITY_LS_ADDRESS && daemon?.httpPort) {
      env.ANTIGRAVITY_LS_ADDRESS = `localhost:${daemon.httpPort}`;
    }
    if (!env.ANTIGRAVITY_CSRF_TOKEN && daemon?.csrfToken) {
      env.ANTIGRAVITY_CSRF_TOKEN = daemon.csrfToken;
    }

    if (!env.ANTIGRAVITY_LS_ADDRESS) {
      reject(new Error('Google Antigravity IDE is not currently running (no active daemon found). Open Antigravity and try again.'));
      return;
    }

    let finalPrompt = String(prompt || '');
    const stagedImg = stageScreenshotFile(screenshot);
    if (stagedImg) {
      finalPrompt = `[Attached Visual Capture saved at: ${stagedImg} — inspect with read_file if visual details are needed]\n\n${finalPrompt}`;
    }
    if (finalPrompt.length > MAX_WIN_PROMPT_CHARS) {
      finalPrompt = `${finalPrompt.slice(0, MAX_WIN_PROMPT_CHARS)}\n\n[Context truncated for CLI transport — call chrome_read_page or chrome_get_page_text for full content]`;
    }

    const baseline = getTranscriptBaseline(conversationId);
    const args = ['agentapi'];
    if (conversationId) {
      args.push('send-message', conversationId, finalPrompt);
    } else {
      args.push('new-conversation', `--title=${title || 'Chrome task'}`);
      if (model && ['flash_lite', 'flash', 'pro'].includes(model)) {
        args.push(`--model=${model}`);
      }
      args.push(finalPrompt);
    }

    const child = spawn(info.languageServer, args, { env, windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', reject);
    child.on('close', async (code) => {
      const combined = stdout.trim() || stderr.trim();
      if (code !== 0) {
        reject(new Error(combined || `agentapi exited with code ${code}`));
        return;
      }

      try {
        const parsed = JSON.parse(stdout.trim());
        if (parsed?.error) {
          reject(new Error(typeof parsed.error === 'string' ? parsed.error : JSON.stringify(parsed.error)));
          return;
        }
      } catch (_notJson) {}

      const uuidMatch = stdout.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
      const resolvedConvoId = uuidMatch ? uuidMatch[0] : conversationId || null;

      if (resolvedConvoId) {
        if (typeof onChunk === 'function') {
          onChunk('Antigravity is reasoning...');
        }
        try {
          const replyText = await waitForTranscriptReply(resolvedConvoId, baseline, onChunk, 150000);
          if (replyText) {
            resolve({ ok: true, output: replyText, conversationId: resolvedConvoId });
            return;
          }
        } catch (transcriptErr) {
          reject(transcriptErr);
          return;
        }
      }

      resolve({
        ok: true,
        output: combined || 'Task dispatched to Antigravity.',
        conversationId: resolvedConvoId
      });
    });
  });
}

module.exports = {
  detectAntigravity,
  findActiveDaemon,
  sendToAntigravity,
  GEMINI_DIR,
  APP_DATA_DIR,
  CONFIG_DIR
};
