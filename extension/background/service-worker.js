/**
 * Gemini Antigravity in Chrome v2.0 - Manifest V3 Background Service Worker
 *
 * Responsibilities:
 * 1. Connects to the local Antigravity Bridge via WebSocket (127.0.0.1:17380) & Native Messaging.
 * 2. Keeps MV3 Service Worker responsive via Offscreen Document + chrome.alarms.
 * 3. Opens the minimalist Side Panel in 1 click (openPanelOnActionClick: true) with zero badge clutter.
 * 4. Dispatches all 26 autonomous browser tools (DOM + Shadow DOM, PDF extraction, Element Inspector,
 *    Multi-Tab Reader, Drag & Drop, File Upload, Dialog Handling, Viewport Resize, Animated GIF Recorder).
 * 5. Enforces Autonomy Mode ('auto' | 'ask'), Per-Domain Allow/Block Guardrails, Shortcuts & Scheduled Tasks.
 * 6. Streams live tool traces and bidirectional Antigravity agent responses directly to the Side Panel.
 */

import {
  cdpClick,
  cdpDrag,
  cdpScroll,
  cdpInsertText,
  cdpPressKey,
  cdpSetFileInput,
  cdpResizeViewport,
  cdpEmulate,
  cdpManageCookies,
  cdpPrintToPdf,
  cdpHandleDialog,
  cdpGetResponseBody,
  cdpEvaluate,
  cdpSend,
  clearCdpConsole,
  clearCdpNetwork,
  detachDebugger,
  getCdpTelemetry
} from './cdp-controller.js';

const DEFAULT_WS_PORTS = [17380, 17381, 17382];
const NATIVE_HOST_NAME = 'com.google.antigravity.chrome_bridge';
const ALARM_RECONNECT = 'agy-reconnect-alarm';
const SCHED_ALARM_PREFIX = 'agy-sched-';
const TAB_GROUP_TITLE = 'Antigravity';
const TAB_GROUP_COLOR = 'grey';
const STORAGE_CHAT_KEY = 'agy_sidepanel_chat_history';

const DEFAULT_SHORTCUTS = [
  {
    id: 'summarize',
    command: '/summarize',
    label: 'Summarize page',
    prompt: 'Read this page thoroughly and provide a concise, structured summary of key takeaways.'
  },
  {
    id: 'audit',
    command: '/audit',
    label: 'UI & accessibility audit',
    prompt: 'Inspect the layout, interactive elements, accessibility tree, and visual hierarchy of this page and list actionable improvements.'
  },
  {
    id: 'debug',
    command: '/debug',
    label: 'Debug console & network',
    prompt: 'Check console errors, uncaught exceptions, and failed network requests on this page and diagnose the root cause.'
  },
  {
    id: 'extract',
    command: '/extract',
    label: 'Extract structured data',
    prompt: 'Use chrome_extract_data to extract all structured tables, lists, metadata, and JSON-LD schemas from this page.'
  },
  {
    id: 'cwv',
    command: '/cwv',
    label: 'Core Web Vitals & WCAG audit',
    prompt: 'Run chrome_audit_page on this tab and present the Performance (TTFB, FCP, LCP, CLS), WCAG 2.2 AA Accessibility, and SEO scores with concrete code fixes.'
  },
  {
    id: 'cookies',
    command: '/cookies',
    label: 'Inspect cookies & storage',
    prompt: 'Use chrome_storage to inspect cookies, localStorage, and sessionStorage on this tab and summarize auth/session state and any SameSite or security issues.'
  },
  {
    id: 'codegen',
    command: '/codegen',
    label: 'Generate Playwright test',
    prompt: 'Inspect the primary user flow on this page and generate a clean @playwright/test TypeScript spec using resilient role and label locators.'
  }
];

const MUTATING_METHODS = new Set([
  'chrome_click',
  'chrome_type',
  'chrome_select_option',
  'chrome_fill_form',
  'chrome_press_key',
  'chrome_drag_and_drop',
  'chrome_upload_file',
  'chrome_evaluate'
]);

let wsConnection = null;
let wsConnecting = false;
let nativePort = null;
let offscreenCreating = false;

// --- Persistent State Helpers (Mandatory Rule #7: chrome.storage) ---
async function getBridgeState() {
  const data = await chrome.storage.local.get([
    'connected',
    'bridgePort',
    'antigravityInfo',
    'paused',
    'autonomyMode',
    'domainRules',
    'autoGroupTabs',
    'controlledTabId',
    'tabGroupId',
    'actionLogs',
    'shortcuts',
    'schedules',
    'themePreference',
    'preferredModel'
  ]);
  const sess = await chrome.storage.session.get(['gifRecording', 'macroSession']).catch(() => ({}));
  return {
    connected: Boolean(data.connected),
    bridgePort: data.bridgePort || 17380,
    antigravityInfo: data.antigravityInfo || null,
    paused: Boolean(data.paused),
    autonomyMode: data.autonomyMode || 'auto', // 'auto' | 'ask'
    preferredModel: data.preferredModel || 'auto',
    domainRules: data.domainRules || { allow: [], block: [] },
    autoGroupTabs: data.autoGroupTabs !== false,
    controlledTabId: data.controlledTabId || null,
    tabGroupId: data.tabGroupId || null,
    actionLogs: Array.isArray(data.actionLogs) ? data.actionLogs : [],
    shortcuts: Array.isArray(data.shortcuts) && data.shortcuts.length > 0 ? data.shortcuts : DEFAULT_SHORTCUTS,
    schedules: Array.isArray(data.schedules) ? data.schedules : [],
    themePreference: data.themePreference || 'system',
    gifRecording: Boolean(sess?.gifRecording?.active),
    gifFrameCount: sess?.gifRecording?.frames?.length || 0,
    macroRecording: Boolean(sess?.macroSession?.active),
    macroStepCount: sess?.macroSession?.steps?.length || 0
  };
}

async function updateBridgeState(patch) {
  await chrome.storage.local.set(patch);
  await updateActionBadge();
  await broadcastStateToViews();
}

async function appendActionLog(action, details, status = 'ok') {
  const { actionLogs = [] } = await chrome.storage.local.get('actionLogs');
  const entry = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    timestamp: new Date().toISOString(),
    action,
    details: typeof details === 'string' ? details : JSON.stringify(details).slice(0, 300),
    status
  };
  const updated = [entry, ...actionLogs].slice(0, 120);
  await chrome.storage.local.set({ actionLogs: updated });
  await broadcastStateToViews();
  return entry;
}

// Minimalist Toolbar Badge: Zero clutter when idle/connected; subtle indicator only when Paused or Recording
async function updateActionBadge() {
  const state = await getBridgeState();
  if (state.gifRecording || state.macroRecording) {
    await chrome.action.setBadgeText({ text: 'REC' });
    await chrome.action.setBadgeBackgroundColor({ color: '#DC2626' });
  } else if (state.paused) {
    await chrome.action.setBadgeText({ text: 'II' });
    await chrome.action.setBadgeBackgroundColor({ color: '#D97706' });
  } else {
    await chrome.action.setBadgeText({ text: '' });
  }
}

async function broadcastToViews(payload) {
  try {
    await chrome.runtime.sendMessage(payload);
  } catch (_err) {
    // Side panel or popup may not be open
  }
}

async function broadcastStateToViews() {
  const state = await getBridgeState();
  await broadcastToViews({ type: 'STATE_UPDATED', state });
}

// --- Side Panel 1-Click Setup ---
async function configureSidePanelBehavior() {
  try {
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  } catch (_err) {}
}

// --- Offscreen Document Keepalive & Image/GIF Processor ---
async function ensureOffscreenDocument() {
  if (offscreenCreating) return;
  try {
    const existingContexts = await chrome.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT']
    });
    if (existingContexts.length > 0) return;

    offscreenCreating = true;
    await chrome.offscreen.createDocument({
      url: 'offscreen/offscreen.html',
      reasons: ['BLOBS'],
      justification: 'Maintain WebSocket heartbeat and process canvas region crops and animated GIF recordings.'
    });
  } catch (_err) {
    // Already exists
  } finally {
    offscreenCreating = false;
  }
}

async function callOffscreen(type, params = {}) {
  await ensureOffscreenDocument();
  const res = await chrome.runtime.sendMessage({
    offscreenTarget: true,
    type,
    params
  });
  if (!res?.ok) {
    throw new Error(res?.error || `Offscreen operation ${type} failed`);
  }
  return res.result;
}

// --- PDF Text Stream Extractor (Handles Chrome PDF Viewer Tabs) ---
async function extractPdfTextFromUrl(url, maxChars = 18000) {
  try {
    const resp = await fetch(url, { credentials: 'include' });
    if (!resp.ok) return '';
    const buf = await resp.arrayBuffer();
    const bytes = new Uint8Array(buf);
    const latin = new TextDecoder('latin1').decode(bytes);

    const extractedChunks = [];

    function parsePdfTextOperators(content) {
      // Match literal strings (...) Tj and arrays [...] TJ
      const tjRegex = /\(([^()\\]*(?:\\.[^()\\]*)*)\)\s*Tj/g;
      let m;
      while ((m = tjRegex.exec(content)) !== null) {
        extractedChunks.push(unescapePdfLiteral(m[1]));
      }
      const arrRegex = /\[([\s\S]*?)\]\s*TJ/g;
      while ((m = arrRegex.exec(content)) !== null) {
        const inner = m[1];
        const litRegex = /\(([^()\\]*(?:\\.[^()\\]*)*)\)/g;
        let lm;
        const parts = [];
        while ((lm = litRegex.exec(inner)) !== null) {
          parts.push(unescapePdfLiteral(lm[1]));
        }
        if (parts.length) extractedChunks.push(parts.join(''));
      }
    }

    function unescapePdfLiteral(str) {
      return str
        .replace(/\\n/g, '\n')
        .replace(/\\r/g, ' ')
        .replace(/\\t/g, ' ')
        .replace(/\\\(/g, '(')
        .replace(/\\\)/g, ')')
        .replace(/\\\\/g, '\\');
    }

    // Decompress FlateDecode streams via standard Web DecompressionStream
    const streamRegex = /<<([\s\S]*?)>>\s*stream\r?\n/g;
    let sm;
    let streamCount = 0;
    while ((sm = streamRegex.exec(latin)) !== null && streamCount < 45) {
      const dict = sm[1];
      const dataStart = sm.index + sm[0].length;
      const dataEnd = latin.indexOf('endstream', dataStart);
      if (dataEnd === -1) break;
      streamCount++;

      let endIdx = dataEnd;
      if (bytes[endIdx - 1] === 0x0a) endIdx--;
      if (bytes[endIdx - 1] === 0x0d) endIdx--;
      const slice = bytes.subarray(dataStart, endIdx);

      if (/\/FlateDecode/.test(dict) && typeof DecompressionStream !== 'undefined') {
        for (const fmt of ['deflate', 'deflate-raw']) {
          try {
            const ds = new DecompressionStream(fmt);
            const writer = ds.writable.getWriter();
            writer.write(slice).catch(() => {});
            writer.close().catch(() => {});
            const decompressed = await new Response(ds.readable).arrayBuffer();
            const textStream = new TextDecoder('latin1').decode(decompressed);
            if (/BT[\s\S]*ET/.test(textStream)) {
              parsePdfTextOperators(textStream);
            }
            break;
          } catch (_decompErr) {}
        }
      } else {
        const rawText = new TextDecoder('latin1').decode(slice);
        if (/BT[\s\S]*ET/.test(rawText)) {
          parsePdfTextOperators(rawText);
        }
      }
    }

    const joined = extractedChunks
      .join(' ')
      .replace(/[^\x09\x0A\x0D\x20-\x7E\u00A0-\uFFFF]/g, ' ')
      .replace(/\s{2,}/g, ' ')
      .trim();
    return joined.slice(0, maxChars);
  } catch (_err) {
    return '';
  }
}

// --- Domain Guardrail Checker ---
function extractHostname(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch (_e) {
    return '';
  }
}

function matchesDomainPattern(hostname, pattern) {
  const p = String(pattern || '').trim().toLowerCase();
  if (!p) return false;
  if (p.startsWith('*.')) {
    const suffix = p.slice(2);
    return hostname === suffix || hostname.endsWith(`.${suffix}`);
  }
  return hostname === p || hostname.endsWith(`.${p}`);
}

function checkDomainGuardrail(url, method, state) {
  if (!MUTATING_METHODS.has(method)) return { allowed: true };
  const host = extractHostname(url);
  if (!host) return { allowed: true };

  const blocked = (state.domainRules?.block || []).some((p) => matchesDomainPattern(host, p));
  if (blocked) {
    return {
      allowed: false,
      reason: `Blocked by user domain guardrail: "${host}" is in the blocklist.`
    };
  }

  if (state.autonomyMode === 'ask') {
    const isLocal = host === 'localhost' || host === '127.0.0.1' || host.endsWith('.localhost');
    const explicitlyAllowed = (state.domainRules?.allow || []).some((p) => matchesDomainPattern(host, p));
    if (!isLocal && !explicitlyAllowed) {
      broadcastToViews({
        type: 'DOMAIN_APPROVAL_NEEDED',
        hostname: host,
        method,
        url
      });
      return {
        allowed: false,
        reason: `Supervised Mode ("Ask before acting"): Domain "${host}" is not yet approved. Ask the user to click "Allow ${host}" in the Antigravity Side Panel or switch mode to Auto.`
      };
    }
  }

  return { allowed: true };
}

// --- Native Messaging Auto-Wakeup ---
function tryConnectNativeHost() {
  if (nativePort) return;
  try {
    nativePort = chrome.runtime.connectNative(NATIVE_HOST_NAME);
    nativePort.onMessage.addListener(async (msg) => {
      if (msg?.type === 'BRIDGE_READY' && msg.wsPort) {
        await chrome.storage.local.set({ bridgePort: msg.wsPort, antigravityInfo: msg.antigravity || null });
        await ensureWebSocketConnection();
      } else if (msg?.type === 'RPC_REQUEST') {
        const response = await handleBridgeRpc(msg);
        try {
          nativePort?.postMessage({ type: 'RPC_RESPONSE', id: msg.id, ...response });
        } catch (_e) {}
      }
    });
    nativePort.onDisconnect.addListener(() => {
      void chrome.runtime.lastError;
      nativePort = null;
    });
    nativePort.postMessage({ type: 'HELLO_FROM_EXTENSION', extensionId: chrome.runtime.id });
  } catch (_err) {
    nativePort = null;
  }
}

// --- WebSocket Client to Local Antigravity Bridge Hub ---
async function ensureWebSocketConnection() {
  if (wsConnection && wsConnection.readyState === WebSocket.OPEN) {
    return true;
  }
  if (wsConnecting) return false;
  wsConnecting = true;

  try {
    const { bridgePort } = await getBridgeState();
    const candidatePorts = Array.from(new Set([bridgePort, ...DEFAULT_WS_PORTS]));

    for (const port of candidatePorts) {
      const connected = await attemptWsPort(port);
      if (connected) {
        wsConnecting = false;
        return true;
      }
    }

    tryConnectNativeHost();
    await updateBridgeState({ connected: false });
    wsConnecting = false;
    return false;
  } catch (_err) {
    wsConnecting = false;
    await updateBridgeState({ connected: false });
    return false;
  }
}

async function persistAgentReplyToChat(msg) {
  const data = await chrome.storage.local.get([STORAGE_CHAT_KEY, 'agy_active_convo_id']);
  const history = Array.isArray(data[STORAGE_CHAT_KEY]) ? data[STORAGE_CHAT_KEY] : [];
  if (msg.conversationId) {
    await chrome.storage.local.set({ agy_active_convo_id: msg.conversationId });
  }

  // Update pending message matching requestId if present, otherwise append
  const idx = msg.requestId ? history.findIndex((m) => m.requestId === msg.requestId) : -1;
  const replyText = msg.ok
    ? (msg.output || 'Completed.')
    : `Error: ${msg.error || 'Could not complete request.'}`;

  if (idx !== -1) {
    history[idx] = {
      ...history[idx],
      text: replyText,
      pending: false,
      error: !msg.ok,
      timestamp: Date.now()
    };
  } else {
    history.push({
      role: 'agent',
      requestId: msg.requestId || null,
      text: replyText,
      pending: false,
      error: !msg.ok,
      timestamp: Date.now()
    });
  }

  await chrome.storage.local.set({ [STORAGE_CHAT_KEY]: history.slice(-60) });
  await broadcastToViews({
    type: 'PROMPT_COMPLETED',
    requestId: msg.requestId || null,
    ok: msg.ok,
    output: replyText,
    conversationId: msg.conversationId || null
  });
}

function attemptWsPort(port) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok) => {
      if (!settled) {
        settled = true;
        resolve(ok);
      }
    };

    try {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?client=chrome-extension&extensionId=${chrome.runtime.id}`);
      const timeout = setTimeout(() => {
        try {
          ws.close();
        } catch (_e) {}
        finish(false);
      }, 1500);

      ws.onopen = async () => {
        clearTimeout(timeout);
        wsConnection = ws;
        await updateBridgeState({ connected: true, bridgePort: port });
        await appendActionLog('bridge.connected', `Connected to 127.0.0.1:${port}`);

        const tabs = await listBrowserTabs({});
        ws.send(
          JSON.stringify({
            type: 'EXTENSION_HELLO',
            extensionId: chrome.runtime.id,
            version: chrome.runtime.getManifest().version,
            tabs
          })
        );
        finish(true);
      };

      ws.onmessage = async (event) => {
        try {
          const message = JSON.parse(event.data);
          if (message.type === 'BRIDGE_WELCOME') {
            await updateBridgeState({
              connected: true,
              antigravityInfo: message.antigravity || null
            });
            return;
          }
          if (message.type === 'PING') {
            ws.send(JSON.stringify({ type: 'PONG', timestamp: Date.now() }));
            return;
          }
          if (message.type === 'AGENT_STREAM_CHUNK') {
            await broadcastToViews({
              type: 'PROMPT_STREAM',
              requestId: message.requestId || null,
              chunk: message.chunk || ''
            });
            return;
          }
          if (message.type === 'PROMPT_RESULT') {
            await appendActionLog(
              'antigravity.reply',
              message.ok ? String(message.output || 'Task finished').slice(0, 140) : `Error: ${message.error}`,
              message.ok ? 'ok' : 'error'
            );
            await persistAgentReplyToChat(message);
            return;
          }
          if (message.type === 'RPC_REQUEST') {
            await broadcastToViews({
              type: 'LIVE_TOOL_EVENT',
              phase: 'start',
              id: message.id,
              method: message.method,
              params: message.params
            });
            const response = await handleBridgeRpc(message);
            await broadcastToViews({
              type: 'LIVE_TOOL_EVENT',
              phase: response.ok ? 'done' : 'error',
              id: message.id,
              method: message.method,
              error: response.error || null
            });
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(
                JSON.stringify({
                  type: 'RPC_RESPONSE',
                  id: message.id,
                  ...response
                })
              );
            }
          }
        } catch (err) {
          console.error('[Antigravity SW] WS message error:', err);
        }
      };

      ws.onclose = async () => {
        clearTimeout(timeout);
        if (wsConnection === ws) {
          wsConnection = null;
          await updateBridgeState({ connected: false });
        }
        finish(false);
      };

      ws.onerror = () => {
        clearTimeout(timeout);
        finish(false);
      };
    } catch (_err) {
      finish(false);
    }
  });
}

// --- Content Script Auto-Injection ---
async function ensureContentScriptReady(tabId) {
  try {
    const res = await chrome.tabs.sendMessage(tabId, { type: 'PING_CONTENT' });
    if (res?.ok) return true;
  } catch (_err) {}

  await chrome.scripting.insertCSS({
    target: { tabId },
    files: ['content/content-style.css']
  });
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ['content/content-script.js']
  });
  await new Promise((r) => setTimeout(r, 60));
  return true;
}

async function sendToContentScript(tabId, type, params = {}) {
  await ensureContentScriptReady(tabId);
  const response = await chrome.tabs.sendMessage(tabId, { type, params });
  if (!response?.ok) {
    throw new Error(response?.error || `Content script failed on ${type}`);
  }
  return response.result;
}

// --- Tab Resolution & Group Management ---
async function resolveTargetTab(tabId) {
  if (tabId) {
    const tab = await chrome.tabs.get(Number(tabId));
    if (tab) return tab;
  }
  const { controlledTabId } = await getBridgeState();
  if (controlledTabId) {
    try {
      const controlled = await chrome.tabs.get(Number(controlledTabId));
      if (controlled && controlled.url && !controlled.url.startsWith('chrome://')) {
        return controlled;
      }
    } catch (_err) {}
  }
  const [activeTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (activeTab && activeTab.url && !activeTab.url.startsWith('chrome://')) {
    return activeTab;
  }
  const allTabs = await chrome.tabs.query({});
  const validTab = allTabs.find((t) => t.url && /^https?:/i.test(t.url));
  if (validTab) return validTab;
  throw new Error('No controllable HTTP/HTTPS tab is open in Chrome. Call chrome_open_url first.');
}

async function addTabToAntigravityGroup(tabId, windowId) {
  const { autoGroupTabs, tabGroupId } = await getBridgeState();
  if (!autoGroupTabs) return null;

  try {
    let groupId = tabGroupId;
    if (groupId) {
      try {
        await chrome.tabGroups.get(groupId);
      } catch (_e) {
        groupId = null;
      }
    }

    if (groupId) {
      await chrome.tabs.group({ groupId, tabIds: [tabId] });
    } else {
      groupId = await chrome.tabs.group({
        createProperties: windowId ? { windowId } : undefined,
        tabIds: [tabId]
      });
      await chrome.tabGroups.update(groupId, {
        title: TAB_GROUP_TITLE,
        color: TAB_GROUP_COLOR,
        collapsed: false
      });
      await chrome.storage.local.set({ tabGroupId: groupId });
    }
    return groupId;
  } catch (_err) {
    return null;
  }
}

async function waitForTabComplete(tabId, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const tab = await chrome.tabs.get(tabId);
    if (tab.status === 'complete') return tab;
    await new Promise((r) => setTimeout(r, 140));
  }
  return await chrome.tabs.get(tabId);
}

async function listBrowserTabs(params = {}) {
  const tabs = await chrome.tabs.query(params.currentWindowOnly ? { lastFocusedWindow: true } : {});
  const { controlledTabId, tabGroupId } = await getBridgeState();
  return tabs.map((t) => ({
    tabId: t.id,
    windowId: t.windowId,
    index: t.index,
    title: t.title || '',
    url: t.url || '',
    pinned: Boolean(t.pinned),
    audible: Boolean(t.audible),
    active: t.active,
    status: t.status,
    groupId: t.groupId,
    inAntigravityGroup: Boolean(tabGroupId && t.groupId === tabGroupId),
    isControlled: t.id === controlledTabId
  }));
}

// --- Non-Disruptive Tab Image Capture (Works on Background Tabs & Minimized Windows via CDP Fallback) ---
async function captureTabImageDataUrl(tab, format = 'png', quality = 85) {
  if (tab.active) {
    try {
      return await chrome.tabs.captureVisibleTab(tab.windowId, {
        format,
        quality: format === 'jpeg' ? quality : undefined
      });
    } catch (_readbackOrMinimizedErr) {
      // Fall through to CDP Page.captureScreenshot
    }
  }
  const shot = await cdpSend(tab.id, 'Page.captureScreenshot', {
    format,
    quality: format === 'jpeg' ? quality : undefined
  });
  return `data:image/${format};base64,${shot.data}`;
}

// --- GIF Session Frame Capture Helper ---
async function maybeRecordGifFrame(tab, caption, clickPoint = null) {
  try {
    const sess = await chrome.storage.session.get('gifRecording');
    const rec = sess?.gifRecording;
    if (!rec?.active || rec.frames.length >= 28) return;

    const dataUrl = await captureTabImageDataUrl(tab, 'jpeg', 80);
    rec.frames.push({
      dataUrl,
      caption: String(caption || '').slice(0, 90),
      clickPoint,
      delayMs: 750,
      timestamp: Date.now()
    });
    await chrome.storage.session.set({ gifRecording: rec });
    await broadcastStateToViews();
  } catch (_err) {}
}

// --- Playwright Codegen & Page Watch Diff Helpers ---
function generatePlaywrightSpec(steps = [], startUrl = 'https://example.com', testName = 'recorded browser workflow') {
  const lines = [
    "import { test, expect } from '@playwright/test';",
    '',
    `test(${JSON.stringify(testName)}, async ({ page }) => {`,
    `  await page.goto(${JSON.stringify(startUrl)});`
  ];

  for (const s of steps) {
    const loc = s.playwrightLocator || `page.locator(${JSON.stringify(s.selector || 'body')})`;
    if (s.kind === 'click') {
      lines.push(`  await ${loc}.click();`);
    } else if (s.kind === 'fill') {
      lines.push(`  await ${loc}.fill(${JSON.stringify(s.value ?? '')});`);
    } else if (s.kind === 'select') {
      lines.push(`  await ${loc}.selectOption(${JSON.stringify(s.value ?? '')});`);
    } else if (s.kind === 'check') {
      lines.push(`  await ${loc}.${s.checked ? 'check' : 'uncheck'}();`);
    } else if (s.kind === 'press') {
      lines.push(`  await ${loc}.press(${JSON.stringify(s.key || 'Enter')});`);
    }
  }

  lines.push('});', '');
  return lines.join('\n');
}

function computeLineDiff(beforeText = '', afterText = '') {
  const prevLines = beforeText.split('\n').filter(Boolean);
  const nextLines = afterText.split('\n').filter(Boolean);
  const prevSet = new Set(prevLines);
  const nextSet = new Set(nextLines);
  const added = nextLines.filter((l) => !prevSet.has(l)).slice(0, 40);
  const removed = prevLines.filter((l) => !nextSet.has(l)).slice(0, 40);
  return {
    changed: beforeText !== afterText,
    addedCount: added.length,
    removedCount: removed.length,
    addedLines: added,
    removedLines: removed
  };
}

// --- Core 34-Tool RPC Dispatcher ---
async function handleBridgeRpc(request) {
  const { method, params = {} } = request;
  const state = await getBridgeState();

  if (method === 'chrome_reload_extension') {
    setTimeout(() => chrome.runtime.reload(), 120);
    return { ok: true, result: { reloading: true } };
  }

  if (state.paused && !['chrome_status', 'chrome_list_tabs'].includes(method)) {
    return {
      ok: false,
      error: 'Antigravity browser control is currently PAUSED by the user. Ask the user to click Resume in the Side Panel or page HUD.'
    };
  }

  try {
    switch (method) {
      case 'chrome_status': {
        const tabs = await listBrowserTabs({});
        const windows = await chrome.windows.getAll({ populate: false });
        const activeTab = tabs.find((t) => t.active) || null;
        const cdpInfo = activeTab ? getCdpTelemetry(activeTab.tabId) : { activeDialog: null };
        return {
          ok: true,
          result: {
            extensionId: chrome.runtime.id,
            version: chrome.runtime.getManifest().version,
            connected: true,
            paused: state.paused,
            autonomyMode: state.autonomyMode,
            gifRecording: state.gifRecording,
            gifFrameCount: state.gifFrameCount,
            macroRecording: state.macroRecording,
            macroStepCount: state.macroStepCount,
            activeDialog: cdpInfo.activeDialog,
            controlledTabId: state.controlledTabId,
            tabGroupId: state.tabGroupId,
            windowCount: windows.length,
            tabCount: tabs.length,
            activeTab
          }
        };
      }

      case 'chrome_list_tabs': {
        const tabs = await listBrowserTabs(params);
        return { ok: true, result: { tabs } };
      }

      case 'chrome_open_url': {
        const url = params.url;
        if (!url) throw new Error('Parameter "url" is required.');
        const guard = checkDomainGuardrail(url, 'chrome_click', state);
        if (!guard.allowed) throw new Error(guard.reason);

        let tab;
        if (params.tabId) {
          tab = await chrome.tabs.update(Number(params.tabId), {
            url,
            active: params.active !== false
          });
        } else if (params.newTab !== false) {
          tab = await chrome.tabs.create({
            url,
            active: params.active !== false
          });
        } else {
          const target = await resolveTargetTab();
          tab = await chrome.tabs.update(target.id, { url, active: params.active !== false });
        }

        await addTabToAntigravityGroup(tab.id, tab.windowId);
        await updateBridgeState({ controlledTabId: tab.id });
        if (params.waitForLoad !== false) {
          tab = await waitForTabComplete(tab.id, params.timeoutMs || 15000);
        }

        await appendActionLog('open_url', `${url} (tab ${tab.id})`);
        await maybeRecordGifFrame(tab, `Open ${url}`);

        let snapshot = null;
        if (params.includeSnapshot !== false && tab.url && /^https?:/i.test(tab.url)) {
          try {
            snapshot = await sendToContentScript(tab.id, 'READ_PAGE', { maxElements: 150 });
            if (snapshot?.isPdfEmbed && !snapshot.visibleText) {
              snapshot.visibleText = await extractPdfTextFromUrl(tab.url);
            }
          } catch (_e) {}
        }

        return {
          ok: true,
          result: {
            tabId: tab.id,
            url: tab.url,
            title: tab.title,
            status: tab.status,
            snapshot
          }
        };
      }

      case 'chrome_read_page': {
        const tab = await resolveTargetTab(params.tabId);
        await updateBridgeState({ controlledTabId: tab.id });
        await addTabToAntigravityGroup(tab.id, tab.windowId);
        let snapshot;
        try {
          snapshot = await sendToContentScript(tab.id, 'READ_PAGE', params);
        } catch (err) {
          if (/\.pdf($|\?|#)/i.test(tab.url || '')) {
            const pdfText = await extractPdfTextFromUrl(tab.url, params.maxTextLength || 16000);
            snapshot = {
              url: tab.url,
              title: tab.title,
              isPdfEmbed: true,
              elementCount: 0,
              elements: [],
              formattedTree: '(PDF document rendered in Chrome PDF Viewer)',
              visibleText: pdfText,
              safetyGates: []
            };
          } else {
            throw err;
          }
        }

        if (snapshot.isPdfEmbed && !snapshot.visibleText) {
          snapshot.visibleText = await extractPdfTextFromUrl(tab.url, params.maxTextLength || 16000);
        }

        const cdpInfo = getCdpTelemetry(tab.id);
        if (cdpInfo.activeDialog) {
          snapshot.activeDialog = cdpInfo.activeDialog;
        }

        await appendActionLog('read_page', `${snapshot.elementCount} elements · ${tab.title || tab.url}`);
        return {
          ok: true,
          result: {
            tabId: tab.id,
            ...snapshot
          }
        };
      }

      case 'chrome_get_page_text': {
        const tab = await resolveTargetTab(params.tabId);
        let res;
        try {
          res = await sendToContentScript(tab.id, 'GET_PAGE_TEXT', params);
        } catch (_e) {
          res = { url: tab.url, title: tab.title, isPdfEmbed: /\.pdf($|\?|#)/i.test(tab.url || ''), markdown: '' };
        }
        if (res.isPdfEmbed && !res.markdown) {
          res.markdown = await extractPdfTextFromUrl(tab.url, params.maxLength || 20000);
        }
        await appendActionLog('get_page_text', `${(res.markdown || '').length} chars · ${tab.title || tab.url}`);
        return { ok: true, result: { tabId: tab.id, ...res } };
      }

      case 'chrome_find_elements': {
        const tab = await resolveTargetTab(params.tabId);
        const found = await sendToContentScript(tab.id, 'FIND_ELEMENTS', params);
        await appendActionLog('find_elements', `"${params.query || params.role}" -> ${found.count} matches`);
        return { ok: true, result: { tabId: tab.id, ...found } };
      }

      case 'chrome_inspect_element': {
        const tab = await resolveTargetTab(params.tabId);
        const inspected = await sendToContentScript(tab.id, 'INSPECT_ELEMENT', params);
        if (params.includeScreenshot && inspected.rect?.width > 2 && inspected.rect?.height > 2) {
          const fullDataUrl = await captureTabImageDataUrl(tab, 'png');
          const cropped = await callOffscreen('CROP_IMAGE', {
            dataUrl: fullDataUrl,
            rect: inspected.rect,
            dpr: inspected.rect.dpr || 1,
            format: 'png'
          });
          inspected.screenshotBase64 = cropped.base64;
        }
        await appendActionLog('inspect_element', `<${inspected.tag}> ${inspected.selector}`);
        return { ok: true, result: { tabId: tab.id, ...inspected } };
      }

      case 'chrome_read_multiple_tabs': {
        const allTabs = await listBrowserTabs({});
        let targets = [];
        if (Array.isArray(params.tabIds) && params.tabIds.length > 0) {
          const idSet = new Set(params.tabIds.map(Number));
          targets = allTabs.filter((t) => idSet.has(t.tabId));
        } else if (params.urlPattern) {
          const re = new RegExp(params.urlPattern, 'i');
          targets = allTabs.filter((t) => re.test(t.url) || re.test(t.title));
        } else {
          targets = allTabs.filter((t) => t.inAntigravityGroup && /^https?:/i.test(t.url));
          if (targets.length === 0) {
            targets = allTabs.filter((t) => /^https?:/i.test(t.url)).slice(0, 6);
          }
        }

        const maxPerTab = params.maxLengthPerTab || 6000;
        const pages = await Promise.all(
          targets.slice(0, 10).map(async (t) => {
            try {
              const extracted = await sendToContentScript(t.tabId, 'GET_PAGE_TEXT', { maxLength: maxPerTab });
              if (extracted.isPdfEmbed && !extracted.markdown) {
                extracted.markdown = await extractPdfTextFromUrl(t.url, maxPerTab);
              }
              return {
                tabId: t.tabId,
                title: t.title,
                url: t.url,
                markdown: extracted.markdown || ''
              };
            } catch (err) {
              if (/\.pdf($|\?|#)/i.test(t.url || '')) {
                const pdfTxt = await extractPdfTextFromUrl(t.url, maxPerTab);
                return { tabId: t.tabId, title: t.title, url: t.url, markdown: pdfTxt };
              }
              return { tabId: t.tabId, title: t.title, url: t.url, error: err.message };
            }
          })
        );

        await appendActionLog('read_multiple_tabs', `Synthesized ${pages.length} tabs`);
        return { ok: true, result: { count: pages.length, pages } };
      }

      case 'chrome_click': {
        const tab = await resolveTargetTab(params.tabId);
        const guard = checkDomainGuardrail(tab.url, method, state);
        if (!guard.allowed) throw new Error(guard.reason);

        await updateBridgeState({ controlledTabId: tab.id });
        let clickResult;
        if (params.useCdp && typeof params.x === 'number' && typeof params.y === 'number') {
          clickResult = await cdpClick(tab.id, params.x, params.y, params);
        } else {
          try {
            clickResult = await sendToContentScript(tab.id, 'CLICK', params);
            if (params.useCdp && clickResult.coordinates) {
              await cdpClick(tab.id, clickResult.coordinates.x, clickResult.coordinates.y, params);
            }
          } catch (csErr) {
            if (typeof params.x === 'number' && typeof params.y === 'number') {
              clickResult = await cdpClick(tab.id, params.x, params.y, params);
            } else {
              throw csErr;
            }
          }
        }
        await appendActionLog('click', `${clickResult.name || params.ref || params.selector || `(${params.x},${params.y})`}`);
        await maybeRecordGifFrame(tab, `Click ${clickResult.name || params.ref || ''}`, clickResult.coordinates);
        return { ok: true, result: { tabId: tab.id, ...clickResult } };
      }

      case 'chrome_hover': {
        const tab = await resolveTargetTab(params.tabId);
        await updateBridgeState({ controlledTabId: tab.id });
        const hoverResult = await sendToContentScript(tab.id, 'HOVER', params);
        await appendActionLog('hover', `${hoverResult.name || params.ref || params.selector}`);
        return { ok: true, result: { tabId: tab.id, ...hoverResult } };
      }

      case 'chrome_highlight': {
        const tab = await resolveTargetTab(params.tabId);
        await updateBridgeState({ controlledTabId: tab.id });
        const highlightResult = await sendToContentScript(tab.id, 'HIGHLIGHT', params);
        await appendActionLog('highlight', `${highlightResult.name || params.ref || params.selector}`);
        return { ok: true, result: { tabId: tab.id, ...highlightResult } };
      }

      case 'chrome_drag_and_drop': {
        const tab = await resolveTargetTab(params.tabId);
        const guard = checkDomainGuardrail(tab.url, method, state);
        if (!guard.allowed) throw new Error(guard.reason);

        await updateBridgeState({ controlledTabId: tab.id });
        let dragRes;
        if (params.useCdp && typeof params.startX === 'number' && typeof params.endX === 'number') {
          dragRes = await cdpDrag(tab.id, params.startX, params.startY, params.endX, params.endY, params.steps);
        } else {
          dragRes = await sendToContentScript(tab.id, 'DRAG_AND_DROP', params);
          if (params.useCdp && dragRes.from && dragRes.to) {
            await cdpDrag(tab.id, dragRes.from.x, dragRes.from.y, dragRes.to.x, dragRes.to.y, params.steps);
          }
        }
        await appendActionLog('drag_and_drop', `(${dragRes.from?.x},${dragRes.from?.y}) -> (${dragRes.to?.x},${dragRes.to?.y})`);
        await maybeRecordGifFrame(tab, 'Drag and drop', dragRes.to);
        return { ok: true, result: { tabId: tab.id, ...dragRes } };
      }

      case 'chrome_upload_file': {
        const tab = await resolveTargetTab(params.tabId);
        const guard = checkDomainGuardrail(tab.url, method, state);
        if (!guard.allowed) throw new Error(guard.reason);

        await updateBridgeState({ controlledTabId: tab.id });
        let upRes;
        if (Array.isArray(params.files) && params.files.length > 0) {
          try {
            upRes = await cdpSetFileInput(tab.id, {
              ref: params.ref,
              selector: params.selector,
              files: params.files
            });
          } catch (cdpErr) {
            if (params.base64) {
              upRes = await sendToContentScript(tab.id, 'UPLOAD_FILE_DATA', params);
            } else {
              throw cdpErr;
            }
          }
        } else if (params.base64) {
          upRes = await sendToContentScript(tab.id, 'UPLOAD_FILE_DATA', params);
        } else {
          throw new Error('Provide "filePath"/"files" or "base64" to chrome_upload_file.');
        }

        await appendActionLog('upload_file', `Uploaded ${params.fileName || params.files?.[0] || 'file'}`);
        return { ok: true, result: { tabId: tab.id, ...upRes } };
      }

      case 'chrome_type': {
        const tab = await resolveTargetTab(params.tabId);
        const guard = checkDomainGuardrail(tab.url, method, state);
        if (!guard.allowed) throw new Error(guard.reason);

        await updateBridgeState({ controlledTabId: tab.id });
        let typeResult;
        if (params.useCdp && !params.ref && !params.selector) {
          typeResult = await cdpInsertText(tab.id, params.text, params.pressEnter);
        } else {
          typeResult = await sendToContentScript(tab.id, 'TYPE', params);
        }
        await appendActionLog('type', `Typed into ${typeResult.name || params.ref || params.selector}`);
        await maybeRecordGifFrame(tab, `Type into ${typeResult.name || 'field'}`);
        return { ok: true, result: { tabId: tab.id, ...typeResult } };
      }

      case 'chrome_select_option': {
        const tab = await resolveTargetTab(params.tabId);
        const guard = checkDomainGuardrail(tab.url, method, state);
        if (!guard.allowed) throw new Error(guard.reason);

        await updateBridgeState({ controlledTabId: tab.id });
        const selResult = await sendToContentScript(tab.id, 'SELECT_OPTION', params);
        await appendActionLog('select_option', `${(selResult.labels || selResult.values || []).join(', ')} (${selResult.via})`);
        await maybeRecordGifFrame(tab, `Select ${(selResult.labels || [])[0] || 'option'}`);
        return { ok: true, result: { tabId: tab.id, ...selResult } };
      }

      case 'chrome_storage': {
        const tab = await resolveTargetTab(params.tabId);
        const action = params.action || 'get';
        const storageType = params.storageType || 'all';
        if (action !== 'get') {
          const guard = checkDomainGuardrail(tab.url, 'chrome_evaluate', state);
          if (!guard.allowed) throw new Error(guard.reason);
        }

        const out = { tabId: tab.id, url: tab.url, action };
        if (storageType === 'cookies' || (storageType === 'all' && action === 'get')) {
          const cookieRes = await cdpManageCookies(tab.id, tab.url, params);
          out.cookies = cookieRes;
        }
        if (storageType === 'localStorage' || storageType === 'sessionStorage' || (storageType === 'all' && action === 'get')) {
          try {
            const webRes = await sendToContentScript(tab.id, 'STORAGE_OP', params);
            Object.assign(out, webRes);
          } catch (_e) {}
        }
        await appendActionLog('storage', `${action} ${storageType}${params.key ? ':' + params.key : ''}`);
        return { ok: true, result: out };
      }

      case 'chrome_audit_page': {
        const tab = await resolveTargetTab(params.tabId);
        const auditRes = await sendToContentScript(tab.id, 'AUDIT_PAGE', params);
        await appendActionLog(
          'audit_page',
          `Perf=${auditRes.performance?.score ?? '-'} · A11y=${auditRes.accessibility?.score ?? '-'} · SEO=${auditRes.seo?.score ?? '-'}`
        );
        return { ok: true, result: { tabId: tab.id, ...auditRes } };
      }

      case 'chrome_emulate': {
        const tab = await resolveTargetTab(params.tabId);
        const emuRes = await cdpEmulate(tab.id, params);
        await appendActionLog('emulate', emuRes.reset ? 'Reset emulation' : JSON.stringify(emuRes.applied));
        return { ok: true, result: { tabId: tab.id, ...emuRes } };
      }

      case 'chrome_extract_data': {
        const tab = await resolveTargetTab(params.tabId);
        const extRes = await sendToContentScript(tab.id, 'EXTRACT_DATA', params);
        await appendActionLog('extract_data', `Mode=${params.mode || 'auto'} on ${tab.title || tab.url}`);
        return { ok: true, result: { tabId: tab.id, ...extRes } };
      }

      case 'chrome_save_pdf': {
        const tab = await resolveTargetTab(params.tabId);
        const pdfRes = await cdpPrintToPdf(tab.id, params);
        await appendActionLog('save_pdf', `Exported PDF from ${tab.title || tab.url}`);
        return { ok: true, result: { tabId: tab.id, url: tab.url, title: tab.title, ...pdfRes } };
      }

      case 'chrome_macro_recorder': {
        const action = params.action || 'status';
        const tab = await resolveTargetTab(params.tabId);
        const sess = await chrome.storage.session.get('macroSession');
        const current = sess?.macroSession || { active: false, startUrl: tab.url, tabId: tab.id, steps: [] };

        if (action === 'start') {
          const next = { active: true, startUrl: tab.url, tabId: tab.id, startedAt: Date.now(), steps: [] };
          await chrome.storage.session.set({ macroSession: next });
          try {
            await sendToContentScript(tab.id, 'SET_MACRO_RECORDING', { active: true });
          } catch (_e) {}
          await updateActionBadge();
          await broadcastStateToViews();
          await appendActionLog('macro_recorder', `Started macro recording on ${tab.url}`);
          return { ok: true, result: { recording: true, tabId: tab.id, startUrl: tab.url, stepCount: 0 } };
        }

        if (action === 'stop') {
          try {
            await sendToContentScript(tab.id, 'SET_MACRO_RECORDING', { active: false });
          } catch (_e) {}
          const steps = current.steps || [];
          const next = { ...current, active: false };
          await chrome.storage.session.set({ macroSession: next });
          await updateActionBadge();
          await broadcastStateToViews();
          const playwrightCode = generatePlaywrightSpec(
            steps,
            current.startUrl || tab.url,
            params.testName || `workflow on ${tab.title || 'page'}`
          );
          await appendActionLog('macro_recorder', `Stopped macro (${steps.length} steps)`);
          return {
            ok: true,
            result: {
              recording: false,
              stepCount: steps.length,
              startUrl: current.startUrl || tab.url,
              steps,
              playwrightCode
            }
          };
        }

        if (action === 'replay') {
          const steps = current.steps || [];
          let executed = 0;
          for (const s of steps) {
            if (s.kind === 'click') {
              await sendToContentScript(tab.id, 'CLICK', { selector: s.selector, text: s.label });
            } else if (s.kind === 'fill') {
              await sendToContentScript(tab.id, 'TYPE', { selector: s.selector, text: s.value || '', clearFirst: true });
            } else if (s.kind === 'select') {
              await sendToContentScript(tab.id, 'SELECT_OPTION', { selector: s.selector, value: s.value });
            } else if (s.kind === 'check') {
              await sendToContentScript(tab.id, 'FILL_FORM', {
                fields: [{ selector: s.selector, checked: Boolean(s.checked) }]
              });
            } else if (s.kind === 'press') {
              await sendToContentScript(tab.id, 'PRESS_KEY', { selector: s.selector, key: s.key || 'Enter' });
            }
            executed++;
            await new Promise((r) => setTimeout(r, 120));
          }
          await appendActionLog('macro_recorder', `Replayed ${executed} macro steps`);
          return { ok: true, result: { replayed: true, executedCount: executed } };
        }

        if (action === 'clear') {
          await chrome.storage.session.remove('macroSession');
          await updateActionBadge();
          await broadcastStateToViews();
          return { ok: true, result: { cleared: true } };
        }

        return {
          ok: true,
          result: {
            recording: Boolean(current.active),
            stepCount: current.steps?.length || 0,
            startUrl: current.startUrl || tab.url,
            steps: current.steps || []
          }
        };
      }

      case 'chrome_watch_page': {
        const tab = await resolveTargetTab(params.tabId);
        const action = params.action || 'check';
        const watchKey = `${tab.id}::${params.selector || params.ref || 'body'}`;
        const sess = await chrome.storage.session.get('watchBaselines');
        const baselines = sess?.watchBaselines || {};

        if (action === 'clear') {
          delete baselines[watchKey];
          await chrome.storage.session.set({ watchBaselines: baselines });
          return { ok: true, result: { tabId: tab.id, cleared: true } };
        }

        const snap = await sendToContentScript(tab.id, 'WATCH_SNAPSHOT', params);
        const prev = baselines[watchKey];

        if (action === 'baseline' || !prev) {
          baselines[watchKey] = snap;
          await chrome.storage.session.set({ watchBaselines: baselines });
          await appendActionLog('watch_page', `Baseline captured (${snap.lineCount} lines)`);
          return {
            ok: true,
            result: {
              tabId: tab.id,
              baselineCreated: true,
              changed: false,
              selector: snap.selector,
              lineCount: snap.lineCount,
              timestamp: snap.timestamp
            }
          };
        }

        const diff = computeLineDiff(prev.text, snap.text);
        baselines[watchKey] = snap;
        await chrome.storage.session.set({ watchBaselines: baselines });
        await appendActionLog('watch_page', diff.changed ? `Changed (+${diff.addedCount}/-${diff.removedCount} lines)` : 'No changes');
        return {
          ok: true,
          result: {
            tabId: tab.id,
            baselineCreated: false,
            previousTimestamp: prev.timestamp,
            currentTimestamp: snap.timestamp,
            selector: snap.selector,
            ...diff
          }
        };
      }

      case 'chrome_fill_form': {
        const tab = await resolveTargetTab(params.tabId);
        const guard = checkDomainGuardrail(tab.url, method, state);
        if (!guard.allowed) throw new Error(guard.reason);

        await updateBridgeState({ controlledTabId: tab.id });
        const fillResult = await sendToContentScript(tab.id, 'FILL_FORM', params);
        await appendActionLog('fill_form', `Filled ${fillResult.filledCount} fields`);
        await maybeRecordGifFrame(tab, `Fill ${fillResult.filledCount} form fields`);
        return { ok: true, result: { tabId: tab.id, ...fillResult } };
      }

      case 'chrome_press_key': {
        const tab = await resolveTargetTab(params.tabId);
        const guard = checkDomainGuardrail(tab.url, method, state);
        if (!guard.allowed) throw new Error(guard.reason);

        await updateBridgeState({ controlledTabId: tab.id });
        const keyResult = params.useCdp
          ? await cdpPressKey(tab.id, params.key)
          : await sendToContentScript(tab.id, 'PRESS_KEY', params);
        await appendActionLog('press_key', `Key "${params.key}"`);
        return { ok: true, result: { tabId: tab.id, ...keyResult } };
      }

      case 'chrome_scroll': {
        const tab = await resolveTargetTab(params.tabId);
        await updateBridgeState({ controlledTabId: tab.id });
        let scrollResult;
        if (params.useCdp) {
          const amt = Number(params.amount) || 500;
          const dir = (params.direction || 'down').toLowerCase();
          const dy = dir === 'up' ? -amt : dir === 'down' ? amt : 0;
          const dx = dir === 'left' ? -amt : dir === 'right' ? amt : 0;
          scrollResult = await cdpScroll(tab.id, params.x || 400, params.y || 400, dx, dy);
        } else {
          scrollResult = await sendToContentScript(tab.id, 'SCROLL', params);
        }
        await appendActionLog('scroll', `Scroll ${params.direction || 'down'}`);
        await maybeRecordGifFrame(tab, `Scroll ${params.direction || 'down'}`);
        return { ok: true, result: { tabId: tab.id, ...scrollResult } };
      }

      case 'chrome_wait_for': {
        const tab = await resolveTargetTab(params.tabId);
        const waitResult = await sendToContentScript(tab.id, 'WAIT_FOR', params);
        return { ok: true, result: { tabId: tab.id, ...waitResult } };
      }

      case 'chrome_handle_dialog': {
        const tab = await resolveTargetTab(params.tabId);
        const dlgRes = await cdpHandleDialog(tab.id, params);
        await appendActionLog('handle_dialog', `${params.accept !== false ? 'Accepted' : 'Dismissed'} JS dialog`);
        return { ok: true, result: { tabId: tab.id, ...dlgRes } };
      }

      case 'chrome_resize_viewport': {
        const tab = await resolveTargetTab(params.tabId);
        const vpRes = await cdpResizeViewport(tab.id, params);
        await appendActionLog('resize_viewport', vpRes.reset ? 'Reset viewport' : `${vpRes.width}x${vpRes.height}`);
        return { ok: true, result: { tabId: tab.id, ...vpRes } };
      }

      case 'chrome_screenshot': {
        const tab = await resolveTargetTab(params.tabId);
        await updateBridgeState({ controlledTabId: tab.id });

        let somMetadata = null;
        if (params.annotateElements) {
          try {
            somMetadata = await sendToContentScript(tab.id, 'SHOW_SOM_OVERLAY', {});
            await new Promise((r) => setTimeout(r, 50));
          } catch (_e) {}
        }

        let base64Data = null;
        const format = params.format === 'jpeg' ? 'jpeg' : 'png';

        try {
          if (params.fullPage) {
            const shot = await cdpSend(tab.id, 'Page.captureScreenshot', {
              format,
              captureBeyondViewport: true
            });
            base64Data = shot.data;
          } else {
            const dataUrl = await captureTabImageDataUrl(tab, format, 85);

            if (params.clip && params.clip.width > 0 && params.clip.height > 0) {
              const cropped = await callOffscreen('CROP_IMAGE', {
                dataUrl,
                rect: params.clip,
                dpr: params.clip.dpr || 1,
                format
              });
              base64Data = cropped.base64;
            } else if (params.ref) {
              const inspected = await sendToContentScript(tab.id, 'INSPECT_ELEMENT', { ref: params.ref });
              const cropped = await callOffscreen('CROP_IMAGE', {
                dataUrl,
                rect: inspected.rect,
                dpr: inspected.rect.dpr || 1,
                format
              });
              base64Data = cropped.base64;
            } else {
              base64Data = dataUrl.replace(/^data:image\/\w+;base64,/, '');
            }
          }
        } finally {
          if (params.annotateElements) {
            try {
              await sendToContentScript(tab.id, 'HIDE_SOM_OVERLAY', {});
            } catch (_e) {}
          }
        }

        await appendActionLog('screenshot', `Captured ${params.annotateElements ? 'annotated ' : ''}screenshot`);
        return {
          ok: true,
          result: {
            tabId: tab.id,
            url: tab.url,
            title: tab.title,
            format,
            base64: base64Data,
            annotatedElementCount: somMetadata?.count || 0,
            annotatedElements: somMetadata?.elements || undefined
          }
        };
      }

      case 'chrome_gif_recorder': {
        const action = params.action || 'status';
        const tab = await resolveTargetTab(params.tabId);
        const sess = await chrome.storage.session.get('gifRecording');
        const current = sess?.gifRecording || { active: false, frames: [] };

        if (action === 'start') {
          const next = { active: true, tabId: tab.id, startedAt: Date.now(), frames: [] };
          await chrome.storage.session.set({ gifRecording: next });
          await updateActionBadge();
          await broadcastStateToViews();
          await maybeRecordGifFrame(tab, params.caption || 'Start session');
          await appendActionLog('gif_recorder', 'Started GIF session recording');
          return { ok: true, result: { recording: true, frameCount: 1 } };
        }

        if (action === 'capture_frame') {
          if (!current.active) {
            current.active = true;
            await chrome.storage.session.set({ gifRecording: current });
          }
          await maybeRecordGifFrame(tab, params.caption || '');
          const updated = (await chrome.storage.session.get('gifRecording'))?.gifRecording;
          return { ok: true, result: { recording: true, frameCount: updated?.frames?.length || 0 } };
        }

        if (action === 'stop') {
          if (current.frames.length === 0) {
            await maybeRecordGifFrame(tab, 'Snapshot');
          }
          const finalState = (await chrome.storage.session.get('gifRecording'))?.gifRecording || current;
          await chrome.storage.session.set({ gifRecording: { active: false, frames: [] } });
          await updateActionBadge();
          await broadcastStateToViews();

          if (!finalState.frames.length) {
            throw new Error('No frames were captured during GIF recording.');
          }

          const encoded = await callOffscreen('ENCODE_GIF', {
            frames: finalState.frames,
            maxWidth: params.maxWidth || 800,
            defaultDelayMs: params.delayMs || 750
          });
          await appendActionLog('gif_recorder', `Encoded ${encoded.frameCount}-frame GIF (${Math.round(encoded.byteLength / 1024)} KB)`);
          return {
            ok: true,
            result: {
              recording: false,
              frameCount: encoded.frameCount,
              width: encoded.width,
              height: encoded.height,
              byteLength: encoded.byteLength,
              base64: encoded.base64,
              dataUrl: params.includeDataUrl ? encoded.dataUrl : undefined
            }
          };
        }

        return {
          ok: true,
          result: {
            recording: Boolean(current.active),
            frameCount: current.frames?.length || 0
          }
        };
      }

      case 'chrome_evaluate': {
        const tab = await resolveTargetTab(params.tabId);
        const guard = checkDomainGuardrail(tab.url, method, state);
        if (!guard.allowed) throw new Error(guard.reason);

        await updateBridgeState({ controlledTabId: tab.id });
        const expression = params.expression || params.script;
        if (!expression) throw new Error('Parameter "expression" is required.');

        const value = await cdpEvaluate(tab.id, expression, params.awaitPromise !== false);
        await appendActionLog('evaluate', `Evaluated JS on tab ${tab.id}`);
        return { ok: true, result: { tabId: tab.id, value } };
      }

      case 'chrome_get_console_logs': {
        const tab = await resolveTargetTab(params.tabId);
        let contentLogs = [];
        try {
          const res = await sendToContentScript(tab.id, 'GET_CONSOLE_LOGS', params);
          contentLogs = res.logs || [];
        } catch (_e) {}
        const cdpLogs = getCdpTelemetry(tab.id).consoleLogs;
        if (params.clear) clearCdpConsole(tab.id);

        let merged = [...contentLogs, ...cdpLogs];
        if (params.onlyErrors) {
          merged = merged.filter((l) => ['error', 'exception', 'assert'].includes(l.level));
        }
        if (params.pattern) {
          const re = new RegExp(params.pattern, 'i');
          merged = merged.filter((l) => re.test(l.message || ''));
        }
        return {
          ok: true,
          result: {
            tabId: tab.id,
            logs: merged.slice(-(params.limit || 100))
          }
        };
      }

      case 'chrome_get_network_logs': {
        const tab = await resolveTargetTab(params.tabId);
        let perfRequests = [];
        try {
          const res = await sendToContentScript(tab.id, 'GET_NETWORK_LOGS', params);
          perfRequests = res.requests || [];
        } catch (_e) {}
        let cdpNet = getCdpTelemetry(tab.id).networkLogs;
        if (params.clear) clearCdpNetwork(tab.id);

        if (params.urlPattern) {
          const re = new RegExp(params.urlPattern, 'i');
          perfRequests = perfRequests.filter((r) => re.test(r.name || ''));
          cdpNet = cdpNet.filter((r) => re.test(r.url || ''));
        }

        if (params.requestId && params.includeBody) {
          const bodyData = await cdpGetResponseBody(tab.id, params.requestId);
          return {
            ok: true,
            result: {
              tabId: tab.id,
              requestId: params.requestId,
              responseBody: bodyData
            }
          };
        }

        return {
          ok: true,
          result: {
            tabId: tab.id,
            performanceResources: perfRequests.slice(-(params.limit || 80)),
            cdpNetworkEvents: cdpNet.slice(-(params.limit || 80))
          }
        };
      }

      case 'chrome_manage_tabs': {
        const action = params.action || 'activate';
        const tab = await resolveTargetTab(params.tabId);

        if (action === 'activate') {
          await chrome.tabs.update(tab.id, { active: true });
          await chrome.windows.update(tab.windowId, { focused: true });
          await updateBridgeState({ controlledTabId: tab.id });
        } else if (action === 'close') {
          await detachDebugger(tab.id);
          await chrome.tabs.remove(tab.id);
        } else if (action === 'duplicate') {
          const dup = await chrome.tabs.duplicate(tab.id);
          return { ok: true, result: { tabId: dup?.id || tab.id, action } };
        } else if (action === 'pin' || action === 'unpin') {
          await chrome.tabs.update(tab.id, { pinned: action === 'pin' });
        } else if (action === 'mute' || action === 'unmute') {
          await chrome.tabs.update(tab.id, { muted: action === 'mute' });
        } else if (action === 'reload') {
          await chrome.tabs.reload(tab.id);
          await waitForTabComplete(tab.id);
        } else if (action === 'go_back') {
          await chrome.tabs.goBack(tab.id);
          await waitForTabComplete(tab.id);
        } else if (action === 'go_forward') {
          await chrome.tabs.goForward(tab.id);
          await waitForTabComplete(tab.id);
        } else if (action === 'group') {
          await addTabToAntigravityGroup(tab.id, tab.windowId);
        } else if (action === 'ungroup') {
          await chrome.tabs.ungroup(tab.id);
        } else if (action === 'detach_debugger') {
          await detachDebugger(tab.id);
        }

        await appendActionLog('manage_tabs', `${action} on tab ${tab.id}`);
        return { ok: true, result: { tabId: tab.id, action } };
      }

      default:
        return { ok: false, error: `Unsupported RPC method: ${method}` };
    }
  } catch (err) {
    await appendActionLog(method, err?.message || String(err), 'error');
    return { ok: false, error: err?.message || String(err) };
  }
}

// --- Send Prompt + Multi-Tab / Picked Element / Screenshot Context to Antigravity ---
async function sendPromptToAntigravity(payload) {
  await ensureWebSocketConnection();
  if (!wsConnection || wsConnection.readyState !== WebSocket.OPEN) {
    throw new Error('Not connected to local Antigravity Bridge. Ensure Antigravity or the local bridge is running.');
  }

  const data = await chrome.storage.local.get('agy_active_convo_id');
  const conversationId = payload.conversationId ?? data.agy_active_convo_id ?? null;

  let pageContext = null;
  if (payload.includePageContext !== false) {
    try {
      const tab = await resolveTargetTab(payload.tabId);
      pageContext = await sendToContentScript(tab.id, 'READ_PAGE', { maxElements: 90, maxTextLength: 6000 });
      if (pageContext?.isPdfEmbed && !pageContext.visibleText) {
        pageContext.visibleText = await extractPdfTextFromUrl(tab.url, 8000);
      }
    } catch (_err) {
      try {
        const [activeTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        if (activeTab) {
          pageContext = {
            url: activeTab.url || 'chrome://unknown',
            title: activeTab.title || 'Browser Internal Page',
            formattedTree: '(Browser internal page — Chrome restricts DOM scripting on chrome:// and Web Store URLs; switch to an http/https webpage to inspect DOM elements.)',
            visibleText: ''
          };
        }
      } catch (_e2) {}
    }
  }

  // Gather any @mentioned tabs
  const extraTabsContext = [];
  if (Array.isArray(payload.mentionedTabIds) && payload.mentionedTabIds.length > 0) {
    for (const mTabId of payload.mentionedTabIds.slice(0, 5)) {
      try {
        const mTab = await chrome.tabs.get(Number(mTabId));
        const md = await sendToContentScript(mTab.id, 'GET_PAGE_TEXT', { maxLength: 4500 });
        if (md.isPdfEmbed && !md.markdown) {
          md.markdown = await extractPdfTextFromUrl(mTab.url, 4500);
        }
        extraTabsContext.push({
          tabId: mTab.id,
          title: mTab.title,
          url: mTab.url,
          markdown: md.markdown || ''
        });
      } catch (_e) {}
    }
  }

  const requestId = payload.requestId || `req-${Date.now()}`;
  wsConnection.send(
    JSON.stringify({
      type: 'USER_PROMPT_FROM_CHROME',
      requestId,
      prompt: payload.prompt,
      model: payload.model || (await getBridgeState()).preferredModel || undefined,
      conversationId,
      pageContext,
      extraTabsContext,
      pickedElement: payload.pickedElement || null,
      screenshot: payload.screenshot || null,
      timestamp: new Date().toISOString()
    })
  );

  await appendActionLog('prompt', `${String(payload.prompt).slice(0, 90)}`);
  return { sent: true, requestId };
}

// --- Scheduled Tasks Sync (chrome.alarms) ---
async function syncScheduleAlarms() {
  const allAlarms = await chrome.alarms.getAll();
  for (const a of allAlarms) {
    if (a.name.startsWith(SCHED_ALARM_PREFIX)) {
      await chrome.alarms.clear(a.name);
    }
  }
  const { schedules = [] } = await chrome.storage.local.get('schedules');
  for (const item of schedules) {
    if (item.enabled !== false && item.intervalMinutes >= 1) {
      await chrome.alarms.create(`${SCHED_ALARM_PREFIX}${item.id}`, {
        periodInMinutes: Number(item.intervalMinutes)
      });
    }
  }
}

// --- Context Menus ---
function setupContextMenus() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'agy-open-sidepanel',
      title: 'Open Antigravity Side Panel',
      contexts: ['all']
    });
    chrome.contextMenus.create({
      id: 'agy-pick-element',
      title: 'Inspect Element with Antigravity',
      contexts: ['page', 'selection', 'link', 'image']
    });
    chrome.contextMenus.create({
      id: 'agy-send-selection',
      title: 'Send Selection to Antigravity',
      contexts: ['selection']
    });
    chrome.contextMenus.create({
      id: 'agy-group-tab',
      title: 'Attach Tab to Antigravity Group',
      contexts: ['page']
    });
  });
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (!tab?.id) return;

  if (info.menuItemId === 'agy-open-sidepanel') {
    await chrome.sidePanel.open({ windowId: tab.windowId });
    return;
  }

  if (info.menuItemId === 'agy-pick-element') {
    await chrome.sidePanel.open({ windowId: tab.windowId });
    try {
      await sendToContentScript(tab.id, 'START_ELEMENT_PICKER', {});
    } catch (_e) {}
    return;
  }

  if (info.menuItemId === 'agy-group-tab') {
    await addTabToAntigravityGroup(tab.id, tab.windowId);
    await updateBridgeState({ controlledTabId: tab.id });
    try {
      await sendToContentScript(tab.id, 'SHOW_TOAST', { message: 'Attached to Antigravity' });
    } catch (_e) {}
    return;
  }

  if (info.menuItemId === 'agy-send-selection') {
    try {
      await sendPromptToAntigravity({
        prompt: `Analyze this selected text from ${tab.url}:\n\n"${info.selectionText}"`,
        tabId: tab.id,
        includePageContext: true
      });
      await sendToContentScript(tab.id, 'SHOW_TOAST', { message: 'Sent to Antigravity' });
    } catch (err) {
      await chrome.notifications.create({
        type: 'basic',
        iconUrl: 'icons/icon-128.png',
        title: 'Antigravity',
        message: err?.message || 'Bridge offline.'
      });
    }
  }
});

// --- Keyboard Shortcuts ---
chrome.commands.onCommand.addListener(async (command) => {
  if (command === 'open-side-panel') {
    const lastWindow = await chrome.windows.getLastFocused({ populate: false });
    if (lastWindow?.id) {
      await chrome.sidePanel.open({ windowId: lastWindow.id });
    }
  } else if (command === 'toggle-pause-control') {
    const { paused } = await getBridgeState();
    const nextPaused = !paused;
    await updateBridgeState({ paused: nextPaused });
    try {
      const tab = await resolveTargetTab();
      await sendToContentScript(tab.id, 'SET_PAUSE_STATE', { paused: nextPaused });
    } catch (_e) {}
  } else if (command === 'pick-page-element') {
    try {
      const tab = await resolveTargetTab();
      await sendToContentScript(tab.id, 'START_ELEMENT_PICKER', {});
    } catch (_e) {}
  }
});

// --- Internal Extension Messages ---
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.offscreenTarget) return false;

  (async () => {
    try {
      switch (message?.type) {
        case 'OFFSCREEN_HEARTBEAT': {
          const ok = await ensureWebSocketConnection();
          sendResponse({ ok: true, connected: ok });
          break;
        }

        case 'GET_STATE': {
          await ensureWebSocketConnection();
          const state = await getBridgeState();
          const tabs = await listBrowserTabs({ currentWindowOnly: false });
          sendResponse({ ok: true, state, tabs });
          break;
        }

        case 'RECONNECT_BRIDGE': {
          if (wsConnection) {
            try {
              wsConnection.close();
            } catch (_e) {}
            wsConnection = null;
          }
          const ok = await ensureWebSocketConnection();
          const state = await getBridgeState();
          sendResponse({ ok, state });
          break;
        }

        case 'USER_TOGGLED_PAUSE':
        case 'SET_PAUSE': {
          const paused = Boolean(message.paused);
          await updateBridgeState({ paused });
          try {
            const tab = await resolveTargetTab();
            await chrome.tabs.sendMessage(tab.id, { type: 'SET_PAUSE_STATE', paused });
          } catch (_e) {}
          sendResponse({ ok: true, paused });
          break;
        }

        case 'SET_AUTONOMY_MODE': {
          const mode = message.mode === 'ask' ? 'ask' : 'auto';
          await updateBridgeState({ autonomyMode: mode });
          sendResponse({ ok: true, autonomyMode: mode });
          break;
        }

        case 'UPDATE_DOMAIN_RULES': {
          const domainRules = {
            allow: Array.isArray(message.allow) ? message.allow : [],
            block: Array.isArray(message.block) ? message.block : []
          };
          await updateBridgeState({ domainRules });
          sendResponse({ ok: true, domainRules });
          break;
        }

        case 'ALLOW_DOMAIN_QUICK': {
          const state = await getBridgeState();
          const host = String(message.hostname || '').trim().toLowerCase();
          if (host) {
            const allow = Array.from(new Set([...(state.domainRules.allow || []), host]));
            const block = (state.domainRules.block || []).filter((h) => h !== host);
            await updateBridgeState({ domainRules: { allow, block } });
          }
          sendResponse({ ok: true });
          break;
        }

        case 'SAVE_SHORTCUTS': {
          const shortcuts = Array.isArray(message.shortcuts) ? message.shortcuts : DEFAULT_SHORTCUTS;
          await updateBridgeState({ shortcuts });
          sendResponse({ ok: true, shortcuts });
          break;
        }

        case 'SAVE_SCHEDULES': {
          const schedules = Array.isArray(message.schedules) ? message.schedules : [];
          await updateBridgeState({ schedules });
          await syncScheduleAlarms();
          sendResponse({ ok: true, schedules });
          break;
        }

        case 'SET_THEME_PREFERENCE': {
          await updateBridgeState({ themePreference: message.theme || 'system' });
          sendResponse({ ok: true });
          break;
        }

        case 'SET_PREFERRED_MODEL': {
          await updateBridgeState({ preferredModel: message.model || 'auto' });
          sendResponse({ ok: true });
          break;
        }

        case 'MACRO_STEP_RECORDED': {
          const sess = await chrome.storage.session.get('macroSession');
          const cur = sess?.macroSession;
          if (cur?.active && message.step) {
            cur.steps.push(message.step);
            await chrome.storage.session.set({ macroSession: cur });
            await broadcastStateToViews();
          }
          sendResponse({ ok: true });
          break;
        }

        case 'TOGGLE_MACRO_RECORDING': {
          const state = await getBridgeState();
          const rpcRes = await handleBridgeRpc({
            method: 'chrome_macro_recorder',
            params: { action: state.macroRecording ? 'stop' : 'start', tabId: message.tabId }
          });
          sendResponse(rpcRes);
          break;
        }

        case 'RUN_QUICK_AUDIT': {
          const rpcRes = await handleBridgeRpc({
            method: 'chrome_audit_page',
            params: { tabId: message.tabId }
          });
          sendResponse(rpcRes);
          break;
        }

        case 'RESET_CONVERSATION': {
          await chrome.storage.local.remove(['agy_active_convo_id', STORAGE_CHAT_KEY]);
          sendResponse({ ok: true });
          break;
        }

        case 'CLEAR_LOGS': {
          await chrome.storage.local.set({ actionLogs: [] });
          await broadcastStateToViews();
          sendResponse({ ok: true });
          break;
        }

        case 'GROUP_CURRENT_TAB': {
          const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
          if (tab?.id) {
            await addTabToAntigravityGroup(tab.id, tab.windowId);
            await updateBridgeState({ controlledTabId: tab.id });
          }
          sendResponse({ ok: true, tabId: tab?.id || null });
          break;
        }

        case 'CAPTURE_TAB_SCREENSHOT': {
          const tab = await resolveTargetTab(message.tabId);
          const dataUrl = await captureTabImageDataUrl(tab, 'jpeg', 88);
          sendResponse({ ok: true, dataUrl, tabId: tab.id });
          break;
        }

        case 'TRIGGER_ELEMENT_PICKER': {
          const tab = await resolveTargetTab(message.tabId);
          await sendToContentScript(tab.id, 'START_ELEMENT_PICKER', {});
          sendResponse({ ok: true });
          break;
        }

        case 'TRIGGER_REGION_SNIP': {
          const tab = await resolveTargetTab(message.tabId);
          await sendToContentScript(tab.id, 'START_REGION_SNIP', {});
          sendResponse({ ok: true });
          break;
        }

        case 'ELEMENT_PICKED': {
          await broadcastToViews({
            type: 'COMPOSER_ELEMENT_ATTACHED',
            element: message.element,
            url: message.url,
            title: message.title
          });
          sendResponse({ ok: true });
          break;
        }

        case 'REGION_SNIPPED': {
          const tab = sender?.tab || (await resolveTargetTab());
          const fullDataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
          const cropped = await callOffscreen('CROP_IMAGE', {
            dataUrl: fullDataUrl,
            rect: message.rect,
            dpr: message.dpr || 1,
            format: 'png'
          });
          await broadcastToViews({
            type: 'COMPOSER_IMAGE_ATTACHED',
            dataUrl: cropped.dataUrl,
            label: `Region ${cropped.width}×${cropped.height}`
          });
          sendResponse({ ok: true });
          break;
        }

        case 'TOGGLE_GIF_RECORDING': {
          const state = await getBridgeState();
          if (state.gifRecording) {
            const rpcRes = await handleBridgeRpc({
              method: 'chrome_gif_recorder',
              params: { action: 'stop', includeDataUrl: true }
            });
            sendResponse(rpcRes);
          } else {
            const rpcRes = await handleBridgeRpc({
              method: 'chrome_gif_recorder',
              params: { action: 'start' }
            });
            sendResponse(rpcRes);
          }
          break;
        }

        case 'SEND_PROMPT_TO_ANTIGRAVITY': {
          const res = await sendPromptToAntigravity(message);
          sendResponse({ ok: true, ...res });
          break;
        }

        default:
          sendResponse({ ok: false, error: `Unhandled message type: ${message?.type}` });
      }
    } catch (err) {
      sendResponse({ ok: false, error: err?.message || String(err) });
    }
  })();
  return true;
});

// --- Lifecycle & Alarms ---
chrome.runtime.onInstalled.addListener(async () => {
  await configureSidePanelBehavior();
  setupContextMenus();
  await chrome.alarms.create(ALARM_RECONNECT, { periodInMinutes: 0.5 });
  await syncScheduleAlarms();
  await updateActionBadge();
  await ensureOffscreenDocument();
  await ensureWebSocketConnection();
});

chrome.runtime.onStartup.addListener(async () => {
  await configureSidePanelBehavior();
  setupContextMenus();
  await chrome.alarms.create(ALARM_RECONNECT, { periodInMinutes: 0.5 });
  await syncScheduleAlarms();
  await updateActionBadge();
  await ensureOffscreenDocument();
  await ensureWebSocketConnection();
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === ALARM_RECONNECT) {
    await ensureOffscreenDocument();
    await ensureWebSocketConnection();
    return;
  }

  if (alarm.name.startsWith(SCHED_ALARM_PREFIX)) {
    const schedId = alarm.name.slice(SCHED_ALARM_PREFIX.length);
    const { schedules = [], paused } = await chrome.storage.local.get(['schedules', 'paused']);
    if (paused) return;
    const task = schedules.find((s) => s.id === schedId && s.enabled !== false);
    if (!task) return;

    try {
      let targetTabId = null;
      if (task.url) {
        const opened = await handleBridgeRpc({
          method: 'chrome_open_url',
          params: { url: task.url, newTab: true, active: false }
        });
        targetTabId = opened?.result?.tabId || null;
      }
      await sendPromptToAntigravity({
        prompt: `[Scheduled Browser Workflow: ${task.name || 'Task'}]\n${task.prompt}`,
        tabId: targetTabId,
        includePageContext: true
      });
    } catch (err) {
      await appendActionLog('schedule.error', `${task.name}: ${err.message}`, 'error');
    }
  }
});

// Boot immediately
(async () => {
  await configureSidePanelBehavior();
  await updateActionBadge();
  tryConnectNativeHost();
  await ensureOffscreenDocument();
  await ensureWebSocketConnection();
})();
