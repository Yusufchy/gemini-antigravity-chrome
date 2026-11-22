#!/usr/bin/env node
/**
 * Antigravity Chrome Bridge Hub (v2.2.0)
 *
 * Routes high-throughput concurrent RPC, real-time local download tracking & project-folder
 * delivery, multi-agent session scheduling, and Side Panel prompts between MCP clients and Chrome:
 *   - Supports both local unpacked dev ID and Chrome Web Store global ID.
 *   - 4-Tier Local Project Download Engine (`DownloadManager`) with atomic cross-drive transfer,
 *     streaming SHA-256 verification, `.chrome-downloads.json` ledger, and content parsers.
 *   - Multi-Agent Concurrency Scheduler (`AgentScheduler`) + bounded parallel fan-out worker pool.
 *   - Streams live `agentapi` output chunks back to the Side Panel.
 */

'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { createWsServer } = require('./lib/ws-server');
const { detectAntigravity, sendToAntigravity } = require('./lib/detect-antigravity');
const { WS_PORT, STATE_DIR, CAPTURES_DIR, getBridgeToken, getAllowedExtensionIds } = require('./lib/config');
const { DownloadManager, sanitizeFilename } = require('./lib/download-manager');
const { AgentScheduler, runBoundedPool } = require('./lib/agent-scheduler');
const { SwarmOrchestrator } = require('./lib/swarm-orchestrator');

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
    this.downloadManager = new DownloadManager({ stateDir: STATE_DIR });
    this.scheduler = new AgentScheduler();
    this.swarm = new SwarmOrchestrator({ stateDir: STATE_DIR });
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
      else this._onBridgeClient(conn, url);
    });

    this.pingTimer = setInterval(() => {
      for (const ext of this.extensions) {
        ext.send(JSON.stringify({ type: 'PING', timestamp: Date.now() }));
      }
    }, 20000);
    this.pingTimer.unref?.();

    log(`listening on ws://127.0.0.1:${this.port}/ws (v2.2.0)`);
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
    conn.send(
      JSON.stringify({
        type: 'BRIDGE_WELCOME',
        hubVersion: '2.2.0',
        antigravity: detectAntigravity(),
        downloads: this.downloadManager.getSummary()
      })
    );
    for (const resolve of this.extensionWaiters.splice(0)) resolve(true);

    conn.on('message', (raw) => {
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
      } else if (msg.type === 'DOWNLOAD_EVENT') {
        // Handle asynchronously without blocking subsequent RPC responses
        this.downloadManager
          .handleChromeDownloadEvent(msg.event)
          .then((rec) => {
            if (rec && this.extensionConnected) {
              const ext = this._primaryExtension();
              ext?.send(JSON.stringify({ type: 'DOWNLOAD_STATE_SYNC', downloads: this.downloadManager.getSummary() }));
            }
          })
          .catch((err) => log('download event error:', err.message));
      } else if (msg.type === 'USER_PROMPT_FROM_CHROME') {
        this._forwardPrompt(conn, msg).catch((err) => log('prompt forward error:', err.message));
      }
    });

    conn.on('close', () => {
      this.extensions.delete(conn);
      log('Chrome extension disconnected');
    });
  }

  _onBridgeClient(conn, url) {
    const clientId = url?.searchParams?.get('clientId') || `client-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    conn.clientId = clientId;
    this.clients.add(conn);

    conn.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw);
      } catch (_e) {
        return;
      }
      if (msg.type !== 'RPC_REQUEST') return;
      // Non-blocking concurrent dispatch for multi-agent multiplexing
      this.executeTool(msg.method, msg.params || {}, msg.timeoutMs, { clientId })
        .then((result) => {
          conn.send(JSON.stringify({ type: 'RPC_RESPONSE', id: msg.id, ok: true, result }));
        })
        .catch((err) => {
          conn.send(JSON.stringify({ type: 'RPC_RESPONSE', id: msg.id, ok: false, error: err.message }));
        });
    });

    conn.on('close', () => {
      this.clients.delete(conn);
      const ownedAgents = this.scheduler.removeClient(clientId);
      if (ownedAgents.length > 0 && this.extensionConnected) {
        for (const agentId of ownedAgents) {
          this.callExtension('chrome_agent_session', { action: 'release', agentId, closeTabs: false }, 5000).catch(() => {});
        }
      }
    });
  }

  // --- Hybrid Local + Chrome Tool Execution Router (v2.2.0) ---
  async executeTool(method, params = {}, timeoutMs = 60000, clientCtx = {}) {
    return this.scheduler.trackDispatch(async () => {
      if (params?.agentId && clientCtx?.clientId) {
        this.scheduler.registerAgentClient(clientCtx.clientId, params.agentId);
      }

      if (method === 'chrome_download_file') {
        return await this._handleDownloadFile(params, timeoutMs);
      }
      if (method === 'chrome_track_downloads') {
        return await this._handleTrackDownloads(params, timeoutMs);
      }
      if (method === 'chrome_parallel_run') {
        return await this._handleParallelRun(params, timeoutMs, clientCtx);
      }
      if (method === 'chrome_agent_session') {
        return await this._handleAgentSession(params, timeoutMs, clientCtx);
      }
      if (method === 'chrome_swarm_plan') {
        return await this._handleSwarmPlan(params, timeoutMs, clientCtx);
      }
      if (method === 'chrome_swarm_blackboard') {
        return this.swarm.blackboardOp(params);
      }
      if (
        method === 'chrome_batch_actions' &&
        Array.isArray(params.steps) &&
        params.steps.some((s) => s?.action === 'download_file')
      ) {
        return await this._handleHybridBatchActions(params, timeoutMs);
      }

      const result = await this.callExtension(method, params, timeoutMs);

      if (method === 'chrome_status' && result && typeof result === 'object') {
        result.hubVersion = '2.2.0';
        result.connectedClients = this.clients.size + 1;
        result.scheduler = this.scheduler.getMetrics();
        result.downloads = this.downloadManager.getSummary();
        result.activeMissions = this.swarm.listMissions().slice(0, 5);
      }

      // Auto-persist & track binary exports when projectDir/savePath is specified
      if (method === 'chrome_save_pdf' && result?.base64 && (params.savePath || params.projectDir)) {
        const rec = await this.downloadManager.saveBase64ToProject({
          base64: result.base64,
          url: result.url,
          filename: params.filename || sanitizeFilename(`${result.title || 'page'}.pdf`, '.pdf'),
          mimeType: 'application/pdf',
          projectDir: params.projectDir,
          savePath: params.savePath,
          overwrite: true,
          tabId: result.tabId,
          agentId: params.agentId || null,
          strategy: 'cdp_print_pdf'
        });
        result.savedTo = rec.projectPath;
        result.sha256 = rec.sha256;
        result.byteLength = rec.sizeBytes;
      }

      if (method === 'chrome_screenshot' && result?.base64 && (params.savePath || params.projectDir)) {
        const ext = result.format === 'jpeg' ? '.jpg' : '.png';
        const rec = await this.downloadManager.saveBase64ToProject({
          base64: result.base64,
          url: result.url,
          filename: sanitizeFilename(`screenshot-${Date.now()}${ext}`, ext),
          mimeType: result.format === 'jpeg' ? 'image/jpeg' : 'image/png',
          projectDir: params.projectDir,
          savePath: params.savePath,
          overwrite: true,
          tabId: result.tabId,
          agentId: params.agentId || null,
          strategy: 'screenshot_capture'
        });
        result.savedTo = rec.projectPath;
        result.sha256 = rec.sha256;
      }

      if (method === 'chrome_gif_recorder' && result?.base64 && (params.savePath || params.projectDir)) {
        const rec = await this.downloadManager.saveBase64ToProject({
          base64: result.base64,
          filename: sanitizeFilename(`recording-${Date.now()}.gif`, '.gif'),
          mimeType: 'image/gif',
          projectDir: params.projectDir,
          savePath: params.savePath,
          overwrite: true,
          agentId: params.agentId || null,
          strategy: 'gif_recorder'
        });
        result.savedTo = rec.projectPath;
        result.sha256 = rec.sha256;
      }

      return result;
    });
  }

  async _handleAgentSession(params = {}, timeoutMs = 60000, clientCtx = {}) {
    const action = params.action || 'status';
    if (params.agentId) {
      if (action === 'claim' && params.projectDir) {
        fs.mkdirSync(path.resolve(String(params.projectDir)), { recursive: true });
        this.downloadManager.setAgentProjectDir(params.agentId, params.projectDir);
      } else if (action === 'release') {
        this.downloadManager.setAgentProjectDir(params.agentId, null);
        this.scheduler.unregisterAgent(params.agentId);
      }
      if (clientCtx?.clientId && action !== 'release') {
        this.scheduler.registerAgentClient(clientCtx.clientId, params.agentId);
      }
    }

    const res = await this.callExtension('chrome_agent_session', params, timeoutMs);
    if (res && typeof res === 'object') {
      res.scheduler = this.scheduler.getMetrics();
      if (params.agentId) {
        res.projectDir = this.downloadManager.getEffectiveProjectDir(params.projectDir, params.agentId);
      }
    }
    return res;
  }

  // --- 4-Tier Zero-Prompt Intelligent Download-to-Project-Folder Engine ---
  async _handleDownloadFile(params = {}, timeoutMs = 60000) {
    const dlTimeout = Math.min(Number(params.timeoutMs) || timeoutMs || 60000, 180000);
    const effectiveProjectDir = this.downloadManager.getEffectiveProjectDir(params.projectDir, params.agentId);
    const mode = params.mode === 'copy' ? 'copy' : 'move';
    const overwrite = Boolean(params.overwrite);
    const writeManifest = params.writeManifest !== false;
    const requestedStrategy = params.strategy || 'auto';
    const hasClickTarget = Boolean(params.ref || params.selector || params.text);
    const url = params.url ? String(params.url).trim() : '';

    if (!url && !hasClickTarget) {
      throw new Error('Provide "url" or an element target ("ref", "selector", or "text") to chrome_download_file.');
    }

    let record = null;

    // Tier 3: Click-triggered download capture (Zero-Prompt Smart Interceptor -> Native Chrome fallback)
    if (requestedStrategy === 'click' || (!url && hasClickTarget)) {
      const startedAt = Date.now();
      const existingChromeIds = new Set(
        this.downloadManager.records.map((r) => r.downloadId).filter((id) => typeof id === 'number')
      );

      // Install temporary MAIN-world anchor/blob download interceptor & click target
      const intercept = await this.callExtension(
        '_ext_download_click_smart',
        {
          tabId: params.tabId,
          agentId: params.agentId,
          ref: params.ref,
          selector: params.selector,
          text: params.text
        },
        30000
      );

      if (intercept?.base64) {
        // Zero-prompt intercepted JS Blob / Data / <a download> export!
        record = await this.downloadManager.saveBase64ToProject({
          base64: intercept.base64,
          url: intercept.capturedUrl || null,
          filename: params.filename || intercept.suggestedFilename || null,
          mimeType: intercept.mimeType || 'application/octet-stream',
          projectDir: effectiveProjectDir,
          savePath: params.savePath,
          overwrite,
          writeManifest,
          tabId: intercept.tabId ?? params.tabId ?? null,
          agentId: params.agentId || null,
          strategy: 'click_intercept'
        });
      } else if (intercept?.capturedUrl && /^https?:/i.test(intercept.capturedUrl)) {
        // Zero-prompt intercepted <a href="https://..."> download link -> stream directly with CDP cookies!
        record = await this._runTier4NodeStream(
          intercept.capturedUrl,
          { ...params, filename: params.filename || intercept.suggestedFilename || undefined, tabId: intercept.tabId ?? params.tabId },
          effectiveProjectDir,
          overwrite,
          writeManifest,
          dlTimeout
        );
        record.strategy = 'click_stream';
      } else {
        // Native server-side Content-Disposition navigation triggered by click -> wait for NEW Chrome downloadId
        let completed;
        try {
          completed = await this.downloadManager.waitForDownload({
            sinceMs: startedAt,
            excludeDownloadIds: existingChromeIds,
            onlyChromeDownloads: true,
            timeoutMs: dlTimeout
          });
        } catch (_waitErr) {
          const recent = await this.callExtension('_ext_downloads_search', { limit: 15 }, 15000);
          this.downloadManager.mergeChromeSearchItems(recent?.items || []);
          completed = this.downloadManager.records.find(
            (r) =>
              typeof r.downloadId === 'number' &&
              !existingChromeIds.has(r.downloadId) &&
              r.state === 'complete' &&
              (Date.parse(r.completedAt || r.startedAt || '') || 0) >= startedAt - 2000
          );
          if (!completed) {
            throw new Error(
              `Clicked target (${intercept?.name || params.ref || params.selector || params.text}) but no browser download completed within ${dlTimeout}ms.`
            );
          }
        }

        if (completed.state === 'interrupted') {
          throw new Error(`Browser download interrupted: ${completed.error || 'unknown error'}`);
        }
        completed.strategy = 'click';
        completed.tabId = intercept?.tabId ?? params.tabId ?? null;
        completed.agentId = params.agentId || null;

        if (effectiveProjectDir || params.savePath) {
          record = await this.downloadManager.syncRecordToProject(completed, {
            projectDir: effectiveProjectDir,
            savePath: params.savePath,
            filename: params.filename,
            mode,
            overwrite,
            writeManifest
          });
        } else {
          record = completed;
        }
      }
    } else if (requestedStrategy === 'page_fetch' || /^blob:|^data:/i.test(url)) {
      // Tier 2: In-page authenticated fetch / blob / data extraction (zero OS dialog)
      const fetched = await this.callExtension(
        '_ext_download_fetch_in_page',
        { tabId: params.tabId, agentId: params.agentId, url },
        dlTimeout
      );
      record = await this.downloadManager.saveBase64ToProject({
        base64: fetched.base64,
        url,
        filename: params.filename || fetched.filename,
        mimeType: fetched.mimeType,
        projectDir: effectiveProjectDir,
        savePath: params.savePath,
        overwrite,
        writeManifest,
        tabId: fetched.tabId,
        agentId: params.agentId || null,
        strategy: 'page_fetch'
      });
    } else if (requestedStrategy === 'chrome_downloads') {
      // Explicit Chrome native download manager + atomic sync
      const started = await this.callExtension(
        '_ext_download_start',
        { url, filename: params.filename ? sanitizeFilename(params.filename) : undefined },
        20000
      );
      const completed = await this.downloadManager.waitForDownload({
        downloadId: started.downloadId,
        onlyChromeDownloads: true,
        timeoutMs: dlTimeout
      });
      if (completed.state === 'interrupted') {
        throw new Error(`chrome.downloads interrupted: ${completed.error || 'unknown'}`);
      }
      completed.strategy = 'chrome_downloads';
      completed.tabId = params.tabId ?? null;
      completed.agentId = params.agentId || null;

      if (effectiveProjectDir || params.savePath) {
        record = await this.downloadManager.syncRecordToProject(completed, {
          projectDir: effectiveProjectDir,
          savePath: params.savePath,
          filename: params.filename,
          mode,
          overwrite,
          writeManifest
        });
      } else {
        record = completed;
      }
    } else if (requestedStrategy === 'node_stream') {
      // Explicit Tier 1/4: Direct Node authenticated HTTP stream using CDP cookies
      record = await this._runTier4NodeStream(url, params, effectiveProjectDir, overwrite, writeManifest, dlTimeout);
    } else {
      // AUTO ZERO-PROMPT STRATEGY for HTTP/HTTPS URLs:
      // 1st: Direct Node stream with CDP session cookies (instant ~20ms, multi-GB safe, ZERO Chrome Save-As popup!)
      // 2nd: In-page credentialed fetch (handles Service Workers, Chrome proxy/client certs, CORS-same-origin)
      // 3rd: Native chrome.downloads.download + atomic project sync
      try {
        record = await this._runTier4NodeStream(url, params, effectiveProjectDir, overwrite, writeManifest, dlTimeout);
      } catch (_streamErr) {
        try {
          const fetched = await this.callExtension(
            '_ext_download_fetch_in_page',
            { tabId: params.tabId, agentId: params.agentId, url },
            dlTimeout
          );
          record = await this.downloadManager.saveBase64ToProject({
            base64: fetched.base64,
            url,
            filename: params.filename || fetched.filename,
            mimeType: fetched.mimeType,
            projectDir: effectiveProjectDir,
            savePath: params.savePath,
            overwrite,
            writeManifest,
            tabId: fetched.tabId,
            agentId: params.agentId || null,
            strategy: 'page_fetch_fallback'
          });
        } catch (_pageErr) {
          const started = await this.callExtension(
            '_ext_download_start',
            { url, filename: params.filename ? sanitizeFilename(params.filename) : undefined },
            20000
          );
          const completed = await this.downloadManager.waitForDownload({
            downloadId: started.downloadId,
            onlyChromeDownloads: true,
            timeoutMs: dlTimeout
          });
          if (completed.state === 'interrupted') {
            throw new Error(`chrome.downloads interrupted: ${completed.error || 'unknown'}`);
          }
          completed.strategy = 'chrome_downloads_fallback';
          completed.tabId = params.tabId ?? null;
          completed.agentId = params.agentId || null;
          record =
            effectiveProjectDir || params.savePath
              ? await this.downloadManager.syncRecordToProject(completed, {
                  projectDir: effectiveProjectDir,
                  savePath: params.savePath,
                  filename: params.filename,
                  mode,
                  overwrite,
                  writeManifest
                })
              : completed;
        }
      }
    }

    const output = {
      downloaded: true,
      id: record.id,
      downloadId: record.downloadId,
      filename: record.filename,
      projectPath: record.projectPath || null,
      chromePath: record.chromePath || null,
      savedPath: record.projectPath || record.chromePath,
      projectDir: record.projectDir || effectiveProjectDir || null,
      manifestPath:
        writeManifest && (record.projectDir || effectiveProjectDir)
          ? path.join(record.projectDir || effectiveProjectDir, '.chrome-downloads.json')
          : null,
      url: record.url,
      mimeType: record.mimeType,
      sizeBytes: record.sizeBytes,
      sha256: record.sha256,
      strategy: record.strategy,
      state: record.state,
      agentId: record.agentId || params.agentId || null,
      completedAt: record.completedAt
    };

    if (params.readPreview && output.savedPath && fs.existsSync(output.savedPath)) {
      try {
        output.preview = this.downloadManager.readFileForProject({
          filePath: output.savedPath,
          maxBytes: 32768,
          maxRows: 50
        });
      } catch (_e) {}
    }

    // Notify extension sidepanel of updated download state
    this._primaryExtension()?.send(
      JSON.stringify({ type: 'DOWNLOAD_STATE_SYNC', downloads: this.downloadManager.getSummary() })
    );

    return output;
  }

  async _runTier4NodeStream(url, params, effectiveProjectDir, overwrite, writeManifest, timeoutMs) {
    let cookies = [];
    let userAgent = '';
    let referer = '';
    let tabId = params.tabId ?? null;
    try {
      const ctx = await this.callExtension(
        '_ext_get_cookies_for_url',
        { tabId: params.tabId, agentId: params.agentId, url },
        15000
      );
      cookies = ctx?.cookies || [];
      userAgent = ctx?.userAgent || '';
      referer = ctx?.referer || '';
      tabId = ctx?.tabId ?? tabId;
    } catch (_e) {}

    return await this.downloadManager.streamUrlToProject({
      url,
      cookies,
      userAgent,
      referer,
      filename: params.filename,
      projectDir: effectiveProjectDir,
      savePath: params.savePath,
      overwrite,
      writeManifest,
      timeoutMs,
      tabId,
      agentId: params.agentId || null
    });
  }

  // --- Download Tracker, Watcher & Project Content Reader ---
  async _handleTrackDownloads(params = {}, timeoutMs = 60000) {
    const action = params.action || 'list';

    if (action === 'watch_project') {
      const cfg = this.downloadManager.configureWatchProject(params);
      this._primaryExtension()?.send(
        JSON.stringify({ type: 'DOWNLOAD_STATE_SYNC', downloads: this.downloadManager.getSummary() })
      );
      return { action, watchConfig: cfg };
    }

    if (action === 'clear_history') {
      return this.downloadManager.clearHistory();
    }

    if (action === 'read_file') {
      // Refresh from Chrome search first if downloadId or latest isn't in local index yet
      if (this.extensionConnected && !params.filePath) {
        try {
          const search = await this.callExtension('_ext_downloads_search', { limit: 25 }, 10000);
          this.downloadManager.mergeChromeSearchItems(search?.items || []);
        } catch (_e) {}
      }
      return this.downloadManager.readFileForProject(params);
    }

    if (action === 'wait') {
      const rec = await this.downloadManager.waitForDownload({
        downloadId: params.downloadId,
        filenamePattern: params.filenamePattern,
        sinceMs: params.sinceMs,
        timeoutMs: Math.min(Number(params.timeoutMs) || timeoutMs || 45000, 180000)
      });
      const effectiveDir = this.downloadManager.getEffectiveProjectDir(params.projectDir, params.agentId);
      if (rec.state === 'complete' && (effectiveDir || params.savePath)) {
        await this.downloadManager.syncRecordToProject(rec, {
          projectDir: effectiveDir,
          savePath: params.savePath,
          filename: params.filename,
          mode: params.mode || 'copy',
          overwrite: Boolean(params.overwrite),
          writeManifest: params.writeManifest !== false
        });
      }
      return { action, download: rec };
    }

    if (action === 'sync_to_project') {
      if (this.extensionConnected && !params.filePath) {
        try {
          const search = await this.callExtension('_ext_downloads_search', { limit: 30 }, 10000);
          this.downloadManager.mergeChromeSearchItems(search?.items || []);
        } catch (_e) {}
      }
      let rec = this.downloadManager.findRecord({
        downloadId: params.downloadId,
        id: params.id,
        filePath: params.filePath,
        filename: params.filename,
        latest: params.latest !== false && !params.downloadId && !params.id && !params.filePath && !params.filename
      });
      if (!rec && params.filePath && fs.existsSync(path.resolve(String(params.filePath)))) {
        rec = this.downloadManager.upsertRecord({
          chromePath: path.resolve(String(params.filePath)),
          filename: path.basename(String(params.filePath)),
          state: 'complete'
        });
      }
      if (!rec) {
        throw new Error('No matching download found to sync. Call chrome_track_downloads(action="list") first.');
      }
      const synced = await this.downloadManager.syncRecordToProject(rec, {
        projectDir: this.downloadManager.getEffectiveProjectDir(params.projectDir, params.agentId),
        savePath: params.savePath,
        filename: params.filename,
        mode: params.mode || 'copy',
        overwrite: Boolean(params.overwrite),
        writeManifest: params.writeManifest !== false
      });
      this._primaryExtension()?.send(
        JSON.stringify({ type: 'DOWNLOAD_STATE_SYNC', downloads: this.downloadManager.getSummary() })
      );
      return { action, synced: true, download: synced };
    }

    // Default: action === 'list'
    if (this.extensionConnected) {
      try {
        const search = await this.callExtension(
          '_ext_downloads_search',
          { limit: Math.min(100, (Number(params.limit) || 30) + 20) },
          10000
        );
        this.downloadManager.mergeChromeSearchItems(search?.items || []);
      } catch (_e) {}
    }
    const downloads = this.downloadManager.listDownloads(params);
    return {
      action: 'list',
      count: downloads.length,
      watchConfig: this.downloadManager.watchConfig,
      downloads
    };
  }

  // --- Bounded Multi-Agent / Multi-Tab Parallel Fan-Out Engine ---
  async _handleParallelRun(params = {}, timeoutMs = 60000, clientCtx = {}) {
    const tasks = Array.isArray(params.tasks) ? params.tasks : [];
    if (tasks.length === 0) {
      throw new Error('Parameter "tasks" must be a non-empty array.');
    }
    const concurrency = Math.max(1, Math.min(12, Number(params.concurrency) || 6));
    const perTaskTimeout = Math.min(Number(params.timeoutMs) || timeoutMs || 60000, 180000);
    const closeSpawnedTabs = Boolean(params.closeSpawnedTabs);
    const wallStart = Date.now();
    this.scheduler.metrics.parallelBatchesRun++;

    const rawResults = await runBoundedPool(tasks, concurrency, async (task, idx) => {
      if (!task || !task.method) {
        throw new Error(`Task #${idx} is missing required "method".`);
      }
      if (task.method === 'chrome_parallel_run') {
        throw new Error('Nested chrome_parallel_run is not allowed.');
      }

      let targetTabId = task.tabId ? Number(task.tabId) : null;
      let spawnedTabId = null;

      if (!targetTabId && task.url) {
        const opened = await this.callExtension(
          'chrome_open_url',
          {
            url: task.url,
            newTab: true,
            active: false,
            waitForLoad: true,
            includeSnapshot: false,
            agentId: task.agentId || `parallel-${idx + 1}`
          },
          perTaskTimeout
        );
        targetTabId = opened.tabId;
        spawnedTabId = opened.tabId;
      }

      try {
        const taskParams = {
          ...(task.params || {}),
          ...(targetTabId ? { tabId: targetTabId } : {}),
          ...(task.agentId ? { agentId: task.agentId } : {})
        };
        const value = await this.executeTool(task.method, taskParams, perTaskTimeout, clientCtx);
        return {
          id: task.id || `task-${idx + 1}`,
          method: task.method,
          agentId: task.agentId || null,
          tabId: targetTabId ?? value?.tabId ?? null,
          result: value
        };
      } finally {
        if (closeSpawnedTabs && spawnedTabId) {
          await this.callExtension('chrome_manage_tabs', { tabId: spawnedTabId, action: 'close' }, 8000).catch(() => {});
        }
      }
    });

    const totalDurationMs = Date.now() - wallStart;
    const sumTaskMs = rawResults.reduce((acc, r) => acc + (r.durationMs || 0), 0);
    const formatted = rawResults.map((r, idx) =>
      r.ok
        ? {
            id: r.value.id,
            ok: true,
            method: r.value.method,
            agentId: r.value.agentId,
            tabId: r.value.tabId,
            durationMs: r.durationMs,
            result: r.value.result
          }
        : {
            id: tasks[idx]?.id || `task-${idx + 1}`,
            ok: false,
            method: tasks[idx]?.method || null,
            agentId: tasks[idx]?.agentId || null,
            durationMs: r.durationMs,
            error: r.error
          }
    );

    const okCount = formatted.filter((r) => r.ok).length;
    return {
      totalTasks: tasks.length,
      okCount,
      errorCount: tasks.length - okCount,
      concurrency,
      totalDurationMs,
      cumulativeTaskMs: sumTaskMs,
      parallelSpeedup: totalDurationMs > 0 ? Math.round((sumTaskMs / totalDurationMs) * 100) / 100 : 1,
      results: formatted
    };
  }

  // --- Hybrid Batch Runner (handles download_file steps inside chrome_batch_actions) ---
  async _handleHybridBatchActions(params = {}, timeoutMs = 60000) {
    const steps = Array.isArray(params.steps) ? params.steps : [];
    const stopOnError = params.stopOnError !== false;
    const stepResults = [];
    let resolvedTabId = params.tabId || null;
    const started = Date.now();
    let pendingDomChunk = [];

    const flushDomChunk = async () => {
      if (pendingDomChunk.length === 0) return true;
      const chunk = pendingDomChunk;
      pendingDomChunk = [];
      const res = await this.callExtension(
        'chrome_batch_actions',
        {
          tabId: resolvedTabId,
          agentId: params.agentId,
          steps: chunk,
          stopOnError,
          fast: params.fast !== false,
          includeFinalDeepRead: false
        },
        timeoutMs
      );
      if (res?.tabId) resolvedTabId = res.tabId;
      for (const r of res?.results || []) stepResults.push(r);
      return !(stopOnError && res?.stoppedEarly);
    };

    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      if (step?.action === 'download_file') {
        const cont = await flushDomChunk();
        if (!cont) break;
        const t0 = Date.now();
        try {
          const dlRes = await this._handleDownloadFile(
            {
              ...(step.params || {}),
              tabId: step.params?.tabId || resolvedTabId,
              agentId: step.params?.agentId || params.agentId
            },
            timeoutMs
          );
          stepResults.push({ stepIndex: i, action: 'download_file', ok: true, durationMs: Date.now() - t0, result: dlRes });
        } catch (err) {
          stepResults.push({ stepIndex: i, action: 'download_file', ok: false, durationMs: Date.now() - t0, error: err.message });
          if (stopOnError) break;
        }
      } else {
        pendingDomChunk.push(step);
      }
    }
    await flushDomChunk();

    let finalDeepRead = null;
    if (params.includeFinalDeepRead) {
      finalDeepRead = await this.callExtension(
        'chrome_deep_read',
        { tabId: resolvedTabId, agentId: params.agentId },
        30000
      );
    }

    const okCount = stepResults.filter((r) => r.ok).length;
    return {
      tabId: resolvedTabId,
      totalSteps: steps.length,
      executedSteps: stepResults.length,
      okCount,
      errorCount: stepResults.length - okCount,
      durationMs: Date.now() - started,
      results: stepResults,
      finalDeepRead
    };
  }

  // --- Cooperative Multi-Agent DAG Mission Planner & Executor ---
  async _handleSwarmPlan(params = {}, timeoutMs = 60000, clientCtx = {}) {
    const action = params.action || 'list';

    if (action === 'roles') {
      return { roles: this.swarm.getRoleProfiles() };
    }
    if (action === 'list') {
      return { missions: this.swarm.listMissions(), roles: Object.keys(this.swarm.getRoleProfiles()) };
    }
    if (action === 'status') {
      if (!params.missionId) throw new Error('Parameter "missionId" is required for action="status".');
      return this.swarm.getMission(params.missionId, true);
    }
    if (action === 'release') {
      if (!params.missionId) throw new Error('Parameter "missionId" is required for action="release".');
      const m = this.swarm.getMission(params.missionId, true);
      const released = [];
      for (const a of m.agents || []) {
        this.downloadManager.setAgentProjectDir(a.agentId, null);
        this.scheduler.unregisterAgent(a.agentId);
        if (this.extensionConnected) {
          await this.callExtension(
            'chrome_agent_session',
            { action: 'release', agentId: a.agentId, closeTabs: Boolean(params.closeTabs) },
            10000
          ).catch(() => {});
        }
        released.push(a.agentId);
      }
      return { released: true, missionId: params.missionId, agentIds: released };
    }

    if (action === 'create_plan') {
      const plan = this.swarm.createPlan(params);
      if (params.provisionNow && this.extensionConnected) {
        await Promise.allSettled(
          (plan.agents || []).map((a) =>
            this._handleAgentSession(
              {
                action: 'claim',
                agentId: a.agentId,
                color: a.color,
                projectDir: a.projectDir,
                exclusive: a.exclusive
              },
              15000,
              clientCtx
            )
          )
        );
      }
      return plan;
    }

    if (action === 'execute') {
      let missionId = params.missionId;
      if (!missionId || Array.isArray(params.tasks)) {
        const created = this.swarm.createPlan(params);
        missionId = created.missionId;
      }

      const closeSpawnedTabs = params.closeSpawnedTabs !== false;
      const spawnedTabsByMission = [];

      const result = await this.swarm.executeMission(missionId, {
        concurrency: params.concurrency,
        closeSpawnedTabs,
        provisionAgents: async (agents) => {
          await Promise.allSettled(
            agents.map((a) =>
              this._handleAgentSession(
                {
                  action: 'claim',
                  agentId: a.agentId,
                  color: a.color,
                  projectDir: a.projectDir,
                  exclusive: a.exclusive
                },
                15000,
                clientCtx
              )
            )
          );
        },
        executor: async (agent, task, resolvedParams, resolvedUrl) => {
          let targetTabId = task.tabId || resolvedParams.tabId || null;
          let spawnedTabId = null;

          if (!targetTabId && resolvedUrl && task.method !== 'chrome_open_url') {
            const opened = await this.callExtension(
              'chrome_open_url',
              {
                url: resolvedUrl,
                newTab: true,
                active: false,
                waitForLoad: true,
                includeSnapshot: false,
                agentId: agent.agentId
              },
              task.timeoutMs || timeoutMs
            );
            targetTabId = opened.tabId;
            spawnedTabId = opened.tabId;
            spawnedTabsByMission.push(spawnedTabId);
          }

          try {
            const finalParams = {
              ...resolvedParams,
              ...(targetTabId ? { tabId: targetTabId } : {}),
              ...(resolvedUrl && task.method === 'chrome_open_url' ? { url: resolvedUrl, active: resolvedParams.active ?? false } : {}),
              agentId: agent.agentId
            };
            return await this.executeTool(task.method, finalParams, task.timeoutMs || timeoutMs, clientCtx);
          } finally {
            if (closeSpawnedTabs && spawnedTabId) {
              await this.callExtension('chrome_manage_tabs', { tabId: spawnedTabId, action: 'close' }, 8000).catch(() => {});
            }
          }
        },
        releaseAgents: async (agents, _m, closeTabs) => {
          await Promise.allSettled(
            agents.map((a) =>
              this._handleAgentSession({ action: 'release', agentId: a.agentId, closeTabs: Boolean(closeTabs) }, 10000, clientCtx)
            )
          );
        }
      });
      return result;
    }

    throw new Error(`Unsupported chrome_swarm_plan action: ${action}`);
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
