#!/usr/bin/env node
/**
 * Antigravity Chrome Bridge Hub (v2.0)
 *
 * Routes bidirectional RPC & Side Panel prompts between Antigravity MCP servers and Chrome:
 *   - Supports both local unpacked dev ID and Chrome Web Store global ID.
 *   - Streams live `agentapi` output chunks back to the Side Panel.
 *   - Persists attached screenshots/snips from the Side Panel so multimodal `read_file` can inspect them.
 *   - Synthesizes active tab, @mentioned tabs, and picked DOM element styles into agent prompts.
 */

'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { createWsServer } = require('./lib/ws-server');
const { detectAntigravity, sendToAntigravity } = require('./lib/detect-antigravity');
const { WS_PORT, CAPTURES_DIR, getBridgeToken, getAllowedExtensionIds } = require('./lib/config');

const log = (...args) => process.stderr.write(`[agy-chrome-hub] ${args.join(' ')}\n`);

class BridgeHub {
  constructor({ port = WS_PORT, autoLaunchChrome = false } = {}) {
    this.port = port;
    this.autoLaunchChrome = autoLaunchChrome;
    this.token = getBridgeToken();
    this.extensions = new Set();
    this.clients = new Set();
    this.pending = new Map();
    this.seq = 0;
    this.extensionWaiters = [];
    this.lastChromeLaunch = 0;
  }

  async start() {
    const allowed = getAllowedExtensionIds();
    const { server, events } = await createWsServer({
      port: this.port,
      verifyClient: (req, url) => {
        const client = url.searchParams.get('client');
        const origin = req.headers.origin || '';
        if (client === 'chrome-extension') {
          const id = origin.replace(/^chrome-extension:\/\//, '').replace(/\/$/, '');
          return origin.startsWith('chrome-extension://') && (allowed.size === 0 || allowed.has(id));
        }
        if (client === 'bridge-client') {
          return !origin && url.searchParams.get('token') === this.token;
        }
        return false;
      }
    });
    this.server = server;

    events.on('connection', (conn, url) => {
      const client = url.searchParams.get('client');
      if (client === 'chrome-extension') this._onExtension(conn);
      else this._onBridgeClient(conn);
    });

    this.pingTimer = setInterval(() => {
      for (const ext of this.extensions) {
        ext.send(JSON.stringify({ type: 'PING', timestamp: Date.now() }));
      }
    }, 20000);
    this.pingTimer.unref?.();

    log(`listening on ws://127.0.0.1:${this.port}/ws`);
    return this;
  }

  stop() {
    clearInterval(this.pingTimer);
    for (const c of [...this.extensions, ...this.clients]) c.close();
    this.server?.close();
  }

  get extensionConnected() {
    return this.extensions.size > 0;
  }

  _primaryExtension() {
    let last = null;
    for (const ext of this.extensions) last = ext;
    return last;
  }

  _onExtension(conn) {
    this.extensions.add(conn);
    log('Chrome extension connected');
    conn.send(JSON.stringify({ type: 'BRIDGE_WELCOME', antigravity: detectAntigravity() }));
    for (const resolve of this.extensionWaiters.splice(0)) resolve(true);

    conn.on('message', async (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw);
      } catch (_e) {
        return;
      }
      if (msg.type === 'RPC_RESPONSE') {
        const entry = this.pending.get(msg.id);
        if (!entry) return;
        clearTimeout(entry.timer);
        this.pending.delete(msg.id);
        if (msg.ok) entry.resolve(msg.result);
        else entry.reject(new Error(msg.error || 'Chrome extension returned an error'));
      } else if (msg.type === 'USER_PROMPT_FROM_CHROME') {
        await this._forwardPrompt(conn, msg);
      }
    });

    conn.on('close', () => {
      this.extensions.delete(conn);
      log('Chrome extension disconnected');
    });
  }

  _onBridgeClient(conn) {
    this.clients.add(conn);
    conn.on('message', async (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw);
      } catch (_e) {
        return;
      }
      if (msg.type !== 'RPC_REQUEST') return;
      try {
        const result = await this.callExtension(msg.method, msg.params, msg.timeoutMs);
        conn.send(JSON.stringify({ type: 'RPC_RESPONSE', id: msg.id, ok: true, result }));
      } catch (err) {
        conn.send(JSON.stringify({ type: 'RPC_RESPONSE', id: msg.id, ok: false, error: err.message }));
      }
    });
    conn.on('close', () => this.clients.delete(conn));
  }

  _saveScreenshotCapture(dataUrl) {
    try {
      const m = String(dataUrl).match(/^data:image\/(\w+);base64,([\s\S]+)$/);
      if (!m) return null;
      const ext = m[1] === 'jpeg' ? 'jpg' : m[1];
      fs.mkdirSync(CAPTURES_DIR, { recursive: true });
      const filePath = path.join(CAPTURES_DIR, `capture-${Date.now()}.${ext}`);
      fs.writeFileSync(filePath, Buffer.from(m[2], 'base64'));
      return filePath;
    } catch (_e) {
      return null;
    }
  }

  async _forwardPrompt(conn, msg) {
    const sections = [String(msg.prompt || '').trim()];

    if (msg.screenshot) {
      const savedPath = this._saveScreenshotCapture(msg.screenshot);
      if (savedPath) {
        sections.push(`Attached Visual Capture (inspect with read_file): ${savedPath}`);
      }
    }

    if (msg.pickedElement) {
      const el = msg.pickedElement;
      sections.push(
        `Picked Page Element:\n` +
          `Ref: ${el.ref} | Selector: ${el.selector} | Tag: <${el.tag}> | Text: "${el.accessibleName || ''}"\n` +
          `Computed Styles: ${JSON.stringify(el.computedStyles || {})}\n` +
          `HTML Preview: ${(el.outerHTMLPreview || '').slice(0, 600)}`
      );
    }

    if (msg.pageContext) {
      const ctx = msg.pageContext;
      sections.push(
        `Active Chrome Tab (use antigravity-chrome MCP tools to act on it):\n` +
          `URL: ${ctx.url}\nTitle: ${ctx.title}\n` +
          (ctx.selection ? `Selected text: ${ctx.selection}\n` : '') +
          (ctx.formattedTree ? `Interactive elements:\n${ctx.formattedTree.slice(0, 3800)}\n` : '') +
          (ctx.visibleText ? `Visible text excerpt:\n${ctx.visibleText.slice(0, 3500)}` : '')
      );
    }

    if (Array.isArray(msg.extraTabsContext) && msg.extraTabsContext.length > 0) {
      const tabBlocks = msg.extraTabsContext.map(
        (t) => `[Tab ${t.tabId}] ${t.title} (${t.url}):\n${(t.markdown || '').slice(0, 2500)}`
      );
      sections.push(`Additional @Mentioned Tabs:\n${tabBlocks.join('\n\n')}`);
    }

    const fullPrompt = sections.join('\n\n---\n');

    try {
      const res = await sendToAntigravity({
        prompt: fullPrompt,
        conversationId: msg.conversationId || undefined,
        model: msg.model || undefined,
        title: `Chrome: ${(msg.prompt || 'Browser task').slice(0, 42)}`,
        onChunk: (chunk) => {
          conn.send(
            JSON.stringify({
              type: 'AGENT_STREAM_CHUNK',
              requestId: msg.requestId || null,
              chunk
            })
          );
        }
      });
      conn.send(
        JSON.stringify({
          type: 'PROMPT_RESULT',
          requestId: msg.requestId || null,
          ok: true,
          output: res.output,
          conversationId: res.conversationId || null
        })
      );
    } catch (err) {
      log('prompt forward failed:', err.message);
      conn.send(
        JSON.stringify({
          type: 'PROMPT_RESULT',
          requestId: msg.requestId || null,
          ok: false,
          error: err.message
        })
      );
    }
  }

  _launchChrome() {
    if (!this.autoLaunchChrome || Date.now() - this.lastChromeLaunch < 60000) return;
    this.lastChromeLaunch = Date.now();
    try {
      if (process.platform === 'win32') {
        const candidates = [
          path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
          path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Google', 'Chrome', 'Application', 'chrome.exe'),
          path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe')
        ];
        const exe = candidates.find((p) => fs.existsSync(p));
        if (exe) spawn(exe, [], { detached: true, stdio: 'ignore' }).unref();
        else spawn('cmd', ['/c', 'start', '', 'chrome'], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
      } else if (process.platform === 'darwin') {
        spawn('open', ['-a', 'Google Chrome'], { detached: true, stdio: 'ignore' }).unref();
      } else {
        spawn('google-chrome', [], { detached: true, stdio: 'ignore' }).unref();
      }
      log('launched Chrome to wake the extension');
    } catch (err) {
      log('could not launch Chrome:', err.message);
    }
  }

  waitForExtension(timeoutMs = 20000) {
    if (this.extensionConnected) return Promise.resolve(true);
    this._launchChrome();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.extensionWaiters = this.extensionWaiters.filter((r) => r !== done);
        resolve(false);
      }, timeoutMs);
      const done = (ok) => {
        clearTimeout(timer);
        resolve(ok);
      };
      this.extensionWaiters.push(done);
    });
  }

  async callExtension(method, params = {}, timeoutMs = 60000) {
    const ready = await this.waitForExtension();
    if (!ready) {
      throw new Error(
        'The "Gemini Antigravity in Chrome" extension is not connected. Make sure Chrome is open and the extension is enabled.'
      );
    }
    const ext = this._primaryExtension();
    const id = `hub-${++this.seq}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Chrome did not respond to ${method} within ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      ext.send(JSON.stringify({ type: 'RPC_REQUEST', id, method, params }));
    });
  }
}

module.exports = { BridgeHub };

if (require.main === module) {
  const hub = new BridgeHub();
  hub.start().catch((err) => {
    if (err.code === 'EADDRINUSE') {
      log(`port ${WS_PORT} already in use — another hub is running.`);
      process.exit(0);
    }
    log('failed to start:', err.message);
    process.exit(1);
  });
}
