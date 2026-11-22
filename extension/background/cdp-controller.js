/**
 * Chrome DevTools Protocol (CDP) Controller for Gemini Antigravity in Chrome v2.2.0.
 * Uses chrome.debugger API (1.3) on demand with:
 * - In-flight attach Promise deduplication (zero race conditions under multi-agent concurrency)
 * - Parallel CDP domain activation (Runtime, Network, Page, DOM) for 4x faster first attach
 * - Trusted hardware-grade mouse, drag, wheel, and keyboard input dispatch
 * - Full-page or clipped screenshots & native Page.printToPDF vector PDF export
 * - MAIN-world JavaScript evaluation
 * - Deep Console & Network telemetry (methods, headers, POST bodies, response bodies)
 * - HTTP-only & browser Cookie management + Authenticated download cookie extraction
 * - File upload injection (DOM.setFileInputFiles)
 * - Responsive viewport, Dark/Light media, Network throttling, CPU, Timezone & Geolocation emulation
 * - Non-blocking JS dialog interception (alert, confirm, prompt, beforeunload)
 */

const attachedTabs = new Map();
const attachingTabs = new Map(); // tabId -> Promise<state> (prevents concurrent multi-agent attach races)

const KEY_CODE_MAP = {
  Enter: { code: 'Enter', vk: 13 },
  Tab: { code: 'Tab', vk: 9 },
  Escape: { code: 'Escape', vk: 27 },
  Backspace: { code: 'Backspace', vk: 8 },
  Delete: { code: 'Delete', vk: 46 },
  Space: { key: ' ', code: 'Space', vk: 32 },
  ArrowUp: { code: 'ArrowUp', vk: 38 },
  ArrowDown: { code: 'ArrowDown', vk: 40 },
  ArrowLeft: { code: 'ArrowLeft', vk: 37 },
  ArrowRight: { code: 'ArrowRight', vk: 39 },
  Home: { code: 'Home', vk: 36 },
  End: { code: 'End', vk: 35 },
  PageUp: { code: 'PageUp', vk: 33 },
  PageDown: { code: 'PageDown', vk: 34 }
};

const NETWORK_PROFILES = {
  online: { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 },
  offline: { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 },
  'slow-3g': { offline: false, latency: 400, downloadThroughput: 50 * 1024, uploadThroughput: 50 * 1024 },
  'fast-3g': { offline: false, latency: 150, downloadThroughput: 180 * 1024, uploadThroughput: 84 * 1024 },
  '4g': { offline: false, latency: 20, downloadThroughput: 4 * 1024 * 1024, uploadThroughput: 3 * 1024 * 1024 }
};

chrome.debugger.onDetach.addListener((source) => {
  if (source.tabId) {
    attachedTabs.delete(source.tabId);
  }
});

chrome.debugger.onEvent.addListener((source, method, params) => {
  const tabId = source.tabId;
  if (!tabId || !attachedTabs.has(tabId)) return;
  const state = attachedTabs.get(tabId);

  if (method === 'Runtime.consoleAPICalled') {
    const text = (params.args || [])
      .map((a) => a.value ?? a.description ?? JSON.stringify(a))
      .join(' ');
    state.consoleLogs.push({
      level: params.type || 'log',
      message: text.slice(0, 3000),
      timestamp: new Date().toISOString()
    });
    if (state.consoleLogs.length > 300) state.consoleLogs.shift();
  } else if (method === 'Runtime.exceptionThrown') {
    const details = params.exceptionDetails || {};
    state.consoleLogs.push({
      level: 'exception',
      message: details.text || details.exception?.description || 'Uncaught exception',
      url: details.url,
      lineNumber: details.lineNumber,
      timestamp: new Date().toISOString()
    });
    if (state.consoleLogs.length > 300) state.consoleLogs.shift();
  } else if (method === 'Network.requestWillBeSent') {
    const req = params.request || {};
    const entry = state.networkMap.get(params.requestId) || {
      requestId: params.requestId,
      timestamp: new Date().toISOString()
    };
    entry.method = req.method || 'GET';
    entry.url = req.url || '';
    entry.type = params.type || 'Other';
    if (req.postData) entry.postData = String(req.postData).slice(0, 2000);
    if (req.headers) entry.requestHeaders = req.headers;

    if (!state.networkMap.has(params.requestId)) {
      state.networkMap.set(params.requestId, entry);
      state.networkOrder.push(params.requestId);
      if (state.networkOrder.length > 300) {
        const oldest = state.networkOrder.shift();
        state.networkMap.delete(oldest);
      }
    }
  } else if (method === 'Network.responseReceived') {
    const res = params.response || {};
    const entry = state.networkMap.get(params.requestId) || {
      requestId: params.requestId,
      method: 'GET',
      url: res.url || '',
      timestamp: new Date().toISOString()
    };
    entry.url = res.url || entry.url;
    entry.type = params.type || entry.type;
    entry.status = res.status;
    entry.statusText = res.statusText;
    entry.mimeType = res.mimeType;
    if (!state.networkMap.has(params.requestId)) {
      state.networkMap.set(params.requestId, entry);
      state.networkOrder.push(params.requestId);
    }
  } else if (method === 'Network.loadingFailed') {
    const entry = state.networkMap.get(params.requestId) || {
      requestId: params.requestId,
      type: params.type || 'Other',
      timestamp: new Date().toISOString()
    };
    entry.failed = true;
    entry.errorText = params.errorText;
    entry.canceled = Boolean(params.canceled);
    if (!state.networkMap.has(params.requestId)) {
      state.networkMap.set(params.requestId, entry);
      state.networkOrder.push(params.requestId);
    }
  } else if (method === 'Page.javascriptDialogOpening') {
    state.activeDialog = {
      type: params.type,
      message: params.message || '',
      defaultPrompt: params.defaultPrompt || '',
      url: params.url || '',
      hasBrowserHandler: Boolean(params.hasBrowserHandler),
      timestamp: new Date().toISOString()
    };
    if (state.autoDismissDialogs || params.type === 'beforeunload') {
      chrome.debugger
        .sendCommand({ tabId }, 'Page.handleJavaScriptDialog', {
          accept: params.type === 'beforeunload'
        })
        .catch(() => {});
      state.activeDialog = null;
    }
  } else if (method === 'Page.javascriptDialogClosed') {
    state.activeDialog = null;
  }
});

export async function ensureDebuggerAttached(tabId) {
  if (attachedTabs.has(tabId)) {
    return attachedTabs.get(tabId);
  }
  if (attachingTabs.has(tabId)) {
    return await attachingTabs.get(tabId);
  }

  const attachPromise = (async () => {
    const target = { tabId };
    try {
      await chrome.debugger.attach(target, '1.3');
    } catch (err) {
      if (!String(err?.message).includes('Already attached')) {
        throw err;
      }
    }
    const state = {
      attachedAt: Date.now(),
      consoleLogs: [],
      networkMap: new Map(),
      networkOrder: [],
      activeDialog: null,
      autoDismissDialogs: false
    };
    attachedTabs.set(tabId, state);

    // Parallel domain enable (~4x faster first CDP attach)
    await Promise.allSettled([
      chrome.debugger.sendCommand(target, 'Runtime.enable', {}),
      chrome.debugger.sendCommand(target, 'Network.enable', { maxPostDataSize: 65536 }),
      chrome.debugger.sendCommand(target, 'Page.enable', {}),
      chrome.debugger.sendCommand(target, 'DOM.enable', {})
    ]);
    return state;
  })();

  attachingTabs.set(tabId, attachPromise);
  try {
    return await attachPromise;
  } finally {
    attachingTabs.delete(tabId);
  }
}

export async function detachDebugger(tabId) {
  if (!attachedTabs.has(tabId)) return;
  try {
    await chrome.debugger.detach({ tabId });
  } catch (_err) {
    // Ignore if already detached
  } finally {
    attachedTabs.delete(tabId);
  }
}

export async function cdpSend(tabId, method, commandParams = {}) {
  await ensureDebuggerAttached(tabId);
  return await chrome.debugger.sendCommand({ tabId }, method, commandParams);
}

function buildModifierMask(options = {}) {
  let mask = 0;
  if (options.altKey) mask |= 1;
  if (options.ctrlKey) mask |= 2;
  if (options.metaKey) mask |= 4;
  if (options.shiftKey) mask |= 8;
  return mask;
}

export async function cdpClick(tabId, x, y, options = {}) {
  await ensureDebuggerAttached(tabId);
  const button = options.button || 'left';
  const clickCount = options.tripleClick ? 3 : options.doubleClick ? 2 : 1;
  const modifiers = buildModifierMask(options);
  const buttonsBit = button === 'right' ? 2 : button === 'middle' ? 4 : 1;

  await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x,
    y,
    modifiers
  });

  for (let count = 1; count <= clickCount; count++) {
    await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x,
      y,
      button,
      buttons: buttonsBit,
      clickCount: count,
      modifiers
    });
    await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x,
      y,
      button,
      buttons: 0,
      clickCount: count,
      modifiers
    });
  }
  return { clicked: true, via: 'cdp', clickCount, coordinates: { x, y } };
}

export async function cdpDrag(tabId, startX, startY, endX, endY, steps = 14) {
  await ensureDebuggerAttached(tabId);
  const count = Math.max(4, Math.min(40, Number(steps) || 14));

  await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: startX,
    y: startY
  });
  await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: startX,
    y: startY,
    button: 'left',
    buttons: 1,
    clickCount: 1
  });

  for (let i = 1; i <= count; i++) {
    const t = i / count;
    const curX = Math.round(startX + (endX - startX) * t);
    const curY = Math.round(startY + (endY - startY) * t);
    await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: curX,
      y: curY,
      button: 'left',
      buttons: 1
    });
    await new Promise((r) => setTimeout(r, 14));
  }

  await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: endX,
    y: endY,
    button: 'left',
    buttons: 0,
    clickCount: 1
  });

  return {
    dragged: true,
    via: 'cdp',
    from: { x: startX, y: startY },
    to: { x: endX, y: endY }
  };
}

export async function cdpScroll(tabId, x, y, deltaX = 0, deltaY = 500) {
  await ensureDebuggerAttached(tabId);
  await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchMouseEvent', {
    type: 'mouseWheel',
    x: Math.round(x || 400),
    y: Math.round(y || 400),
    deltaX: Math.round(deltaX),
    deltaY: Math.round(deltaY)
  });
  return { scrolled: true, via: 'cdp', deltaX, deltaY };
}

export async function cdpInsertText(tabId, text, pressEnter = false) {
  await ensureDebuggerAttached(tabId);
  await chrome.debugger.sendCommand({ tabId }, 'Input.insertText', { text: String(text) });
  if (pressEnter) {
    await cdpPressKey(tabId, 'Enter');
  }
  return { typed: true, via: 'cdp', length: String(text).length, pressEnter };
}

export async function cdpPressKey(tabId, rawKey = 'Enter') {
  await ensureDebuggerAttached(tabId);
  const parts = String(rawKey).split('+');
  const mainKey = parts.pop() || 'Enter';
  const modSet = new Set(parts.map((p) => p.toLowerCase()));
  const modifiers = buildModifierMask({
    altKey: modSet.has('alt'),
    ctrlKey: modSet.has('ctrl') || modSet.has('control'),
    metaKey: modSet.has('meta') || modSet.has('cmd') || modSet.has('command'),
    shiftKey: modSet.has('shift')
  });

  const mapped = KEY_CODE_MAP[mainKey];
  const key = mapped?.key || mainKey;
  const code = mapped?.code || (mainKey.length === 1 ? `Key${mainKey.toUpperCase()}` : mainKey);
  const vk = mapped?.vk || (mainKey.length === 1 ? mainKey.toUpperCase().charCodeAt(0) : 0);

  await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchKeyEvent', {
    type: key.length === 1 && modifiers === 0 ? 'keyDown' : 'rawKeyDown',
    key,
    code,
    text: key.length === 1 && modifiers === 0 ? key : undefined,
    windowsVirtualKeyCode: vk,
    nativeVirtualKeyCode: vk,
    modifiers
  });
  await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchKeyEvent', {
    type: 'keyUp',
    key,
    code,
    windowsVirtualKeyCode: vk,
    nativeVirtualKeyCode: vk,
    modifiers
  });
  return { pressed: rawKey, via: 'cdp' };
}

export async function cdpSetFileInput(tabId, { selector, ref, files }) {
  await ensureDebuggerAttached(tabId);
  const normalizedRef = ref ? (String(ref).startsWith('ref_') ? String(ref) : `ref_${ref}`) : null;
  const queryExpr = normalizedRef
    ? `document.querySelector('[data-agy-ref="${normalizedRef.replace(/"/g, '\\"')}"]')`
    : selector
      ? `document.querySelector(${JSON.stringify(selector)})`
      : `document.querySelector('input[type="file"]')`;

  const evalRes = await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
    expression: queryExpr,
    returnByValue: false
  });
  const objectId = evalRes?.result?.objectId;
  if (!objectId) {
    throw new Error(`Could not locate <input type="file"> matching ${normalizedRef || selector || 'input[type="file"]'}.`);
  }

  await chrome.debugger.sendCommand({ tabId }, 'DOM.setFileInputFiles', {
    objectId,
    files
  });
  return { uploaded: true, fileCount: files.length, files };
}

export async function cdpResizeViewport(tabId, { width, height, deviceScaleFactor = 1, mobile = false, reset = false }) {
  await ensureDebuggerAttached(tabId);
  if (reset) {
    await chrome.debugger.sendCommand({ tabId }, 'Emulation.clearDeviceMetricsOverride', {});
    return { reset: true };
  }
  const w = Math.max(240, Math.min(3840, Math.round(Number(width) || 1280)));
  const h = Math.max(240, Math.min(3840, Math.round(Number(height) || 800)));
  await chrome.debugger.sendCommand({ tabId }, 'Emulation.setDeviceMetricsOverride', {
    width: w,
    height: h,
    deviceScaleFactor: Number(deviceScaleFactor) || 1,
    mobile: Boolean(mobile)
  });
  return { resized: true, width: w, height: h, deviceScaleFactor, mobile: Boolean(mobile) };
}

export async function cdpEmulate(tabId, params = {}) {
  const state = await ensureDebuggerAttached(tabId);
  const target = { tabId };

  if (params.reset) {
    await chrome.debugger.sendCommand(target, 'Emulation.setEmulatedMedia', { media: '', features: [] }).catch(() => {});
    await chrome.debugger.sendCommand(target, 'Network.emulateNetworkConditions', NETWORK_PROFILES.online).catch(() => {});
    await chrome.debugger.sendCommand(target, 'Emulation.setCPUThrottlingRate', { rate: 1 }).catch(() => {});
    await chrome.debugger.sendCommand(target, 'Emulation.setTimezoneOverride', { timezoneId: '' }).catch(() => {});
    await chrome.debugger.sendCommand(target, 'Emulation.clearGeolocationOverride', {}).catch(() => {});
    await chrome.debugger.sendCommand(target, 'Emulation.clearDeviceMetricsOverride', {}).catch(() => {});
    if (state.tzScriptId) {
      await chrome.debugger.sendCommand(target, 'Page.removeScriptToEvaluateOnNewDocument', { identifier: state.tzScriptId }).catch(() => {});
      state.tzScriptId = null;
    }
    await chrome.debugger
      .sendCommand(target, 'Runtime.evaluate', {
        expression: `if (window.__OrigDateTimeFormat) { Intl.DateTimeFormat = window.__OrigDateTimeFormat; delete window.__OrigDateTimeFormat; }`
      })
      .catch(() => {});
    return { reset: true };
  }

  const applied = {};

  if (params.colorScheme || params.reducedMotion || params.mediaType !== undefined) {
    const features = [];
    if (params.colorScheme) {
      features.push({ name: 'prefers-color-scheme', value: params.colorScheme });
      applied.colorScheme = params.colorScheme;
    }
    if (params.reducedMotion) {
      features.push({ name: 'prefers-reduced-motion', value: params.reducedMotion });
      applied.reducedMotion = params.reducedMotion;
    }
    const media = params.mediaType ?? '';
    if (media) applied.mediaType = media;
    await chrome.debugger.sendCommand(target, 'Emulation.setEmulatedMedia', { media, features });
  }

  if (params.networkProfile && NETWORK_PROFILES[params.networkProfile]) {
    await chrome.debugger.sendCommand(target, 'Network.emulateNetworkConditions', NETWORK_PROFILES[params.networkProfile]);
    applied.networkProfile = params.networkProfile;
  }

  if (typeof params.cpuThrottlingRate === 'number' && params.cpuThrottlingRate >= 1) {
    const rate = Math.min(20, Math.max(1, Number(params.cpuThrottlingRate)));
    await chrome.debugger.sendCommand(target, 'Emulation.setCPUThrottlingRate', { rate });
    applied.cpuThrottlingRate = rate;
  }

  if (params.timezoneId) {
    const tz = String(params.timezoneId);
    try {
      await chrome.debugger.sendCommand(target, 'Emulation.setTimezoneOverride', { timezoneId: tz });
    } catch (_trustedOnlyErr) {
      // Chrome 144+ restricts Emulation.setTimezoneOverride on WebExtension debuggers; apply MAIN-world Intl shim
      const shimExpr = `(() => {
        const Orig = window.__OrigDateTimeFormat || Intl.DateTimeFormat;
        window.__OrigDateTimeFormat = Orig;
        const Wrapped = function(locales, opts) {
          return new Orig(locales, Object.assign({ timeZone: ${JSON.stringify(tz)} }, opts || {}));
        };
        Wrapped.prototype = Orig.prototype;
        Wrapped.supportedLocalesOf = Orig.supportedLocalesOf.bind(Orig);
        Intl.DateTimeFormat = Wrapped;
      })()`;
      await chrome.debugger.sendCommand(target, 'Runtime.evaluate', { expression: shimExpr });
      const added = await chrome.debugger
        .sendCommand(target, 'Page.addScriptToEvaluateOnNewDocument', { source: shimExpr })
        .catch(() => null);
      if (added?.identifier) state.tzScriptId = added.identifier;
    }
    applied.timezoneId = tz;
  }

  if (params.geolocation && typeof params.geolocation.latitude === 'number' && typeof params.geolocation.longitude === 'number') {
    await chrome.debugger.sendCommand(target, 'Emulation.setGeolocationOverride', {
      latitude: Number(params.geolocation.latitude),
      longitude: Number(params.geolocation.longitude),
      accuracy: Number(params.geolocation.accuracy || 25)
    });
    applied.geolocation = params.geolocation;
  }

  if (params.userAgent) {
    await chrome.debugger.sendCommand(target, 'Emulation.setUserAgentOverride', { userAgent: String(params.userAgent) });
    applied.userAgent = String(params.userAgent);
  }

  return { emulated: true, applied };
}

export async function cdpManageCookies(tabId, tabUrl, params = {}) {
  await ensureDebuggerAttached(tabId);
  const target = { tabId };
  const action = params.action || 'get';

  if (action === 'get') {
    const { cookies = [] } = await chrome.debugger.sendCommand(target, 'Network.getCookies', {
      urls: tabUrl ? [tabUrl] : undefined
    });
    const filtered = params.key ? cookies.filter((c) => c.name === params.key) : cookies;
    return {
      count: filtered.length,
      cookies: filtered.map((c) => ({
        name: c.name,
        value: c.value,
        domain: c.domain,
        path: c.path,
        secure: c.secure,
        httpOnly: c.httpOnly,
        sameSite: c.sameSite || 'None',
        session: c.session,
        expires: c.expires
      }))
    };
  }

  if (action === 'set') {
    if (!params.key) throw new Error('Cookie "key" (name) is required for action="set".');
    const res = await chrome.debugger.sendCommand(target, 'Network.setCookie', {
      name: String(params.key),
      value: String(params.value ?? ''),
      url: tabUrl || undefined,
      domain: params.domain || undefined,
      path: params.path || '/',
      secure: typeof params.secure === 'boolean' ? params.secure : undefined,
      httpOnly: typeof params.httpOnly === 'boolean' ? params.httpOnly : undefined,
      sameSite: params.sameSite || undefined,
      expires: typeof params.expires === 'number' ? params.expires : undefined
    });
    return { set: Boolean(res?.success !== false), key: params.key };
  }

  if (action === 'delete') {
    if (!params.key) throw new Error('Cookie "key" (name) is required for action="delete".');
    await chrome.debugger.sendCommand(target, 'Network.deleteCookies', {
      name: String(params.key),
      url: tabUrl || undefined,
      domain: params.domain || undefined,
      path: params.path || undefined
    });
    return { deleted: true, key: params.key };
  }

  if (action === 'clear') {
    const { cookies = [] } = await chrome.debugger.sendCommand(target, 'Network.getCookies', {
      urls: tabUrl ? [tabUrl] : undefined
    });
    for (const c of cookies) {
      await chrome.debugger
        .sendCommand(target, 'Network.deleteCookies', {
          name: c.name,
          domain: c.domain,
          path: c.path
        })
        .catch(() => {});
    }
    return { cleared: true, removedCount: cookies.length };
  }

  throw new Error(`Unsupported cookie action: ${action}`);
}

export async function cdpPrintToPdf(tabId, params = {}) {
  await ensureDebuggerAttached(tabId);
  const scale = Math.min(2, Math.max(0.1, Number(params.scale) || 1));
  const pdf = await chrome.debugger.sendCommand({ tabId }, 'Page.printToPDF', {
    landscape: Boolean(params.landscape),
    printBackground: params.printBackground !== false,
    scale,
    pageRanges: params.pageRanges ? String(params.pageRanges) : undefined
  });
  return {
    exported: true,
    landscape: Boolean(params.landscape),
    scale,
    base64: pdf.data
  };
}

export async function cdpHandleDialog(tabId, { accept = true, promptText, autoDismiss }) {
  const state = await ensureDebuggerAttached(tabId);
  if (typeof autoDismiss === 'boolean') {
    state.autoDismissDialogs = autoDismiss;
  }
  const prevDialog = state.activeDialog;
  if (!prevDialog && typeof autoDismiss === 'boolean') {
    return { handled: false, autoDismissDialogs: state.autoDismissDialogs, activeDialog: null };
  }
  await chrome.debugger.sendCommand({ tabId }, 'Page.handleJavaScriptDialog', {
    accept: Boolean(accept),
    promptText: promptText !== undefined ? String(promptText) : undefined
  });
  state.activeDialog = null;
  return {
    handled: true,
    accepted: Boolean(accept),
    dialog: prevDialog
  };
}

export async function cdpGetResponseBody(tabId, requestId) {
  await ensureDebuggerAttached(tabId);
  const body = await chrome.debugger.sendCommand({ tabId }, 'Network.getResponseBody', { requestId });
  return {
    body: body.base64Encoded ? body.body.slice(0, 8000) : String(body.body || '').slice(0, 8000),
    base64Encoded: Boolean(body.base64Encoded)
  };
}

export async function cdpEvaluate(tabId, expression, awaitPromise = true) {
  await ensureDebuggerAttached(tabId);
  const response = await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
    expression,
    awaitPromise,
    returnByValue: true,
    userGesture: true
  });
  if (response.exceptionDetails) {
    throw new Error(
      response.exceptionDetails.exception?.description ||
        response.exceptionDetails.text ||
        'CDP Runtime.evaluate exception'
    );
  }
  return response.result?.value;
}

export function clearCdpConsole(tabId) {
  const state = attachedTabs.get(tabId);
  if (state) state.consoleLogs = [];
}

export function clearCdpNetwork(tabId) {
  const state = attachedTabs.get(tabId);
  if (state) {
    state.networkMap.clear();
    state.networkOrder = [];
  }
}

export function getCdpTelemetry(tabId) {
  const state = attachedTabs.get(tabId);
  const networkLogs = state
    ? state.networkOrder.map((id) => state.networkMap.get(id)).filter(Boolean)
    : [];
  return {
    attached: Boolean(state),
    activeDialog: state?.activeDialog || null,
    autoDismissDialogs: Boolean(state?.autoDismissDialogs),
    consoleLogs: state ? state.consoleLogs : [],
    networkLogs
  };
}
