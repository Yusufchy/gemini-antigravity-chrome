/**
 * Gemini Antigravity in Chrome v2.0 - Content Script
 *
 * Capabilities:
 * 1. Deep Accessibility & DOM Tree Snapshot with Shadow DOM + same-origin <iframe> piercing
 * 2. Clean Structured Markdown Extraction (GET_PAGE_TEXT) + PDF Embed Detection
 * 3. Fast Semantic Element Search (FIND_ELEMENTS) & Deep Computed CSS Inspector (INSPECT_ELEMENT)
 * 4. Interactive Element Picker (Codex App-Shot style) & Region Snip Crop Selector
 * 5. Human-like Actuation: Click (1x/2x/3x), Type, Fill Form, Drag & Drop, File Drop, Key Chords, Scroll, Wait
 * 6. Safety Boundary Detection (Password, 2FA/OTP, CAPTCHA, Payment Checkout)
 * 7. Minimalist Monochrome Agent HUD & Set-of-Marks (SoM) Overlay
 */

(() => {
  if (globalThis.__AGY_CONTENT_SCRIPT_V2_2__) {
    return;
  }
  globalThis.__AGY_CONTENT_SCRIPT_V2_2__ = true;
  globalThis.__AGY_CONTENT_SCRIPT_V2_1__ = true;

  const refMap = new Map(); // refId -> { ref: WeakRef<Element>, offsetX: number, offsetY: number }
  const consoleLogs = [];
  const MAX_CONSOLE_LOGS = 250;
  let isPausedByUser = false;
  let hudElements = null;
  let hudHideTimer = null;
  let activeHighlightBox = null;
  let lastCursorX = 0;
  let lastCursorY = 0;

  // --- Capture Page Errors & Rejections ---
  window.addEventListener('error', (event) => {
    pushConsoleLog('error', event.message || 'Uncaught Error', {
      filename: event.filename,
      lineno: event.lineno,
      colno: event.colno
    });
  });

  window.addEventListener('unhandledrejection', (event) => {
    pushConsoleLog('error', `Unhandled Promise Rejection: ${String(event.reason)}`);
  });

  function pushConsoleLog(level, message, extra = {}) {
    consoleLogs.push({
      level,
      message: String(message).slice(0, 2500),
      url: location.href,
      timestamp: new Date().toISOString(),
      ...extra
    });
    if (consoleLogs.length > MAX_CONSOLE_LOGS) {
      consoleLogs.shift();
    }
  }

  // --- Minimalist HUD ---
  function ensureHud() {
    if (hudElements && document.body?.contains(hudElements.root)) {
      return hudElements;
    }
    if (!document.body) return null;

    const existing = document.getElementById('agy-chrome-hud-root');
    if (existing) existing.remove();

    const root = document.createElement('div');
    root.id = 'agy-chrome-hud-root';

    const frame = document.createElement('div');
    frame.id = 'agy-chrome-viewport-frame';

    const pill = document.createElement('div');
    pill.id = 'agy-chrome-status-pill';

    const dot = document.createElement('span');
    dot.className = 'agy-pulse-dot';

    const statusText = document.createElement('span');
    statusText.id = 'agy-chrome-status-text';
    statusText.textContent = 'Antigravity active';

    const pauseBtn = document.createElement('button');
    pauseBtn.id = 'agy-chrome-pause-btn';
    pauseBtn.type = 'button';
    pauseBtn.textContent = 'Pause';
    pauseBtn.addEventListener('click', async () => {
      isPausedByUser = !isPausedByUser;
      updateHudPauseState();
      try {
        await chrome.runtime.sendMessage({
          type: 'USER_TOGGLED_PAUSE',
          paused: isPausedByUser,
          url: location.href
        });
      } catch (_err) {}
    });

    pill.append(dot, statusText, pauseBtn);

    const cursor = document.createElement('div');
    cursor.id = 'agy-chrome-cursor';
    cursor.innerHTML = `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M4 3L11.2 20L13.9 13.4L20.5 10.7L4 3Z" fill="#09090B" stroke="#FAFAFA" stroke-width="1.8" stroke-linejoin="round"/>
    </svg>`;

    const toast = document.createElement('div');
    toast.id = 'agy-chrome-toast';

    const somContainer = document.createElement('div');
    somContainer.id = 'agy-chrome-som-container';

    root.append(frame, pill, cursor, toast, somContainer);
    document.body.appendChild(root);

    hudElements = { root, frame, pill, dot, statusText, pauseBtn, cursor, toast, somContainer };
    return hudElements;
  }

  function updateHudPauseState() {
    const hud = ensureHud();
    if (!hud) return;
    if (isPausedByUser) {
      hud.frame.classList.add('agy-paused');
      hud.dot.classList.add('agy-paused');
      hud.statusText.textContent = 'Paused';
      hud.pauseBtn.textContent = 'Resume';
    } else {
      hud.frame.classList.remove('agy-paused');
      hud.dot.classList.remove('agy-paused');
      hud.statusText.textContent = 'Antigravity active';
      hud.pauseBtn.textContent = 'Pause';
    }
  }

  function showHudStatus(message, autoHideMs = 3500) {
    const hud = ensureHud();
    if (!hud) return;
    hud.frame.classList.add('agy-active');
    hud.pill.classList.add('agy-visible');
    if (!isPausedByUser) {
      hud.statusText.textContent = message;
    }
    if (hudHideTimer) clearTimeout(hudHideTimer);
    if (autoHideMs > 0 && !isPausedByUser) {
      hudHideTimer = setTimeout(() => {
        hud.pill.classList.remove('agy-visible');
        hud.frame.classList.remove('agy-active');
        hud.cursor.classList.remove('agy-visible');
      }, autoHideMs);
    }
  }

  function showToast(message, durationMs = 2600) {
    const hud = ensureHud();
    if (!hud) return;
    hud.toast.textContent = message;
    hud.toast.classList.add('agy-show');
    setTimeout(() => hud.toast.classList.remove('agy-show'), durationMs);
  }

  function smoothGlideCursor(fromX, fromY, toX, toY, durationMs = 240) {
    const hud = ensureHud();
    // CRITICAL: requestAnimationFrame is suspended by Chromium in background (document.hidden) tabs!
    if (!hud || document.hidden) {
      lastCursorX = toX;
      lastCursorY = toY;
      return Promise.resolve();
    }

    return new Promise((resolve) => {
      let settled = false;
      const done = () => {
        if (!settled) {
          settled = true;
          lastCursorX = toX;
          lastCursorY = toY;
          resolve();
        }
      };

      const deltaX = toX - fromX;
      const deltaY = toY - fromY;
      const dist = Math.hypot(deltaX, deltaY);

      if (dist < 10) {
        hud.cursor.style.transform = `translate(${Math.round(toX)}px, ${Math.round(toY)}px)`;
        return done();
      }

      const cp1X = fromX + deltaX * 0.25 - deltaY * 0.12;
      const cp1Y = fromY + deltaY * 0.25 + deltaX * 0.12;
      const cp2X = fromX + deltaX * 0.75;
      const cp2Y = fromY + deltaY * 0.75;

      const startTime = performance.now();
      const duration = Math.min(Math.max(durationMs, 140), 420);
      // Safety timer in case user switches away mid-animation
      const safetyTimer = setTimeout(done, duration + 120);

      function step(now) {
        if (settled || document.hidden) {
          clearTimeout(safetyTimer);
          return done();
        }
        const t = Math.min(1, (now - startTime) / duration);
        const easeT = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
        const u = 1 - easeT;
        const curX = u * u * u * fromX + 3 * u * u * easeT * cp1X + 3 * u * easeT * easeT * cp2X + easeT * easeT * easeT * toX;
        const curY = u * u * u * fromY + 3 * u * u * easeT * cp1Y + 3 * u * easeT * easeT * cp2Y + easeT * easeT * easeT * toY;

        hud.cursor.style.transform = `translate(${Math.round(curX)}px, ${Math.round(curY)}px)`;
        if (t < 1) {
          requestAnimationFrame(step);
        } else {
          clearTimeout(safetyTimer);
          done();
        }
      }
      requestAnimationFrame(step);
    });
  }

  async function animateAgentAction(targetEl, x, y, label, isClick = false, fast = false) {
    if (fast || document.hidden) {
      if (typeof x === 'number' && typeof y === 'number') {
        lastCursorX = x;
        lastCursorY = y;
      }
      if (!document.hidden && label) showHudStatus(label, 1800);
      return;
    }
    const hud = ensureHud();
    if (!hud) return;
    showHudStatus(label || 'Acting on page...', 3800);

    if (typeof x === 'number' && typeof y === 'number') {
      hud.cursor.classList.add('agy-visible');
      await smoothGlideCursor(lastCursorX || x, lastCursorY || y, x, y, 220);

      if (isClick) {
        hud.cursor.classList.add('agy-clicking');
        setTimeout(() => hud.cursor.classList.remove('agy-clicking'), 180);

        const ripple = document.createElement('div');
        ripple.className = 'agy-click-ripple';
        ripple.style.left = `${Math.round(x)}px`;
        ripple.style.top = `${Math.round(y)}px`;
        ripple.style.width = '28px';
        ripple.style.height = '28px';
        hud.root.appendChild(ripple);
        setTimeout(() => ripple.remove(), 550);
      }
    }

    if (targetEl && targetEl.getBoundingClientRect) {
      const rect = targetEl.getBoundingClientRect();
      const box = document.createElement('div');
      box.className = 'agy-highlight-box';
      box.style.left = `${Math.round(rect.left - 3)}px`;
      box.style.top = `${Math.round(rect.top - 3)}px`;
      box.style.width = `${Math.round(rect.width + 6)}px`;
      box.style.height = `${Math.round(rect.height + 6)}px`;
      hud.root.appendChild(box);
      setTimeout(() => box.remove(), 1100);
    }
  }

  // --- Deep DOM + Shadow DOM + Same-Origin Iframe Traversal ---
  function collectDeepCandidates(rootNode = document, offsetX = 0, offsetY = 0, depth = 0, maxDepth = 5, out = [], crossOriginFrames = []) {
    if (!rootNode || depth > maxDepth) return out;
    const walkerRoot = rootNode.body || rootNode.documentElement || rootNode;
    if (!walkerRoot) return out;

    const elements = rootNode.querySelectorAll ? rootNode.querySelectorAll('*') : [];
    for (const el of elements) {
      if (el.id === 'agy-chrome-hud-root' || el.closest?.('#agy-chrome-hud-root')) continue;
      out.push({ el, offsetX, offsetY });

      if (el.shadowRoot) {
        collectDeepCandidates(el.shadowRoot, offsetX, offsetY, depth + 1, maxDepth, out, crossOriginFrames);
      }

      if (el.tagName === 'IFRAME') {
        try {
          const doc = el.contentDocument;
          if (doc) {
            const r = el.getBoundingClientRect();
            collectDeepCandidates(doc, offsetX + r.left, offsetY + r.top, depth + 1, maxDepth, out, crossOriginFrames);
          } else if (el.src) {
            crossOriginFrames.push(el.src.slice(0, 160));
          }
        } catch (_crossOriginErr) {
          if (el.src) crossOriginFrames.push(el.src.slice(0, 160));
        }
      }
    }
    return out;
  }

  function buildPlaywrightLocator(el) {
    if (!el || el.nodeType !== 1) return "page.locator('body')";
    const testId = el.getAttribute('data-testid') || el.getAttribute('data-test') || el.getAttribute('data-qa');
    if (testId) return `page.getByTestId(${JSON.stringify(testId)})`;

    const role = inferRole(el);
    const name = getAccessibleName(el);
    const playwrightRoles = new Set(['button', 'link', 'textbox', 'searchbox', 'combobox', 'checkbox', 'radio', 'switch', 'tab', 'menuitem']);
    if (playwrightRoles.has(role) && name && name.length <= 60) {
      return `page.getByRole(${JSON.stringify(role)}, { name: ${JSON.stringify(name)} })`;
    }
    const placeholder = el.getAttribute('placeholder');
    if (placeholder) return `page.getByPlaceholder(${JSON.stringify(placeholder)})`;
    if (el.id) return `page.locator(${JSON.stringify('#' + CSS.escape(el.id))})`;
    return `page.locator(${JSON.stringify(buildSelectorPath(el) || el.tagName.toLowerCase())})`;
  }

  function parseRgba(colorStr) {
    const m = String(colorStr || '').match(/rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,/\s]+([\d.]+))?\s*\)/i);
    if (!m) return null;
    return {
      r: Number(m[1]),
      g: Number(m[2]),
      b: Number(m[3]),
      a: m[4] !== undefined ? Number(m[4]) : 1
    };
  }

  function relativeLuminance({ r, g, b }) {
    const chan = (c) => {
      const s = c / 255;
      return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * chan(r) + 0.7152 * chan(g) + 0.0722 * chan(b);
  }

  function getEffectiveBackground(el) {
    let cur = el;
    const win = el.ownerDocument?.defaultView || window;
    while (cur && cur.nodeType === 1) {
      const bg = parseRgba(win.getComputedStyle(cur).backgroundColor);
      if (bg && bg.a >= 0.85) return bg;
      cur = cur.parentElement;
    }
    return { r: 255, g: 255, b: 255, a: 1 };
  }

  function computeElementContrastRatio(el) {
    try {
      const win = el.ownerDocument?.defaultView || window;
      const fg = parseRgba(win.getComputedStyle(el).color);
      if (!fg || fg.a < 0.2) return null;
      const bg = getEffectiveBackground(el);
      const l1 = relativeLuminance(fg);
      const l2 = relativeLuminance(bg);
      const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
      return Math.round(ratio * 100) / 100;
    } catch (_e) {
      return null;
    }
  }

  function isElementVisible(el) {
    if (!el || !el.getBoundingClientRect) return false;
    if (el.id === 'agy-chrome-hud-root' || el.closest?.('#agy-chrome-hud-root')) return false;
    const win = el.ownerDocument?.defaultView || window;
    const style = win.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || parseFloat(style.opacity) === 0) {
      return false;
    }
    const rect = el.getBoundingClientRect();
    return rect.width > 1 && rect.height > 1;
  }

  function isInteractiveElement(el) {
    const tag = el.tagName.toLowerCase();
    if (['a', 'button', 'input', 'textarea', 'select', 'summary', 'option'].includes(tag)) {
      if (tag === 'input' && el.type === 'hidden') return false;
      return true;
    }
    const role = (el.getAttribute('role') || '').toLowerCase();
    if ([
      'button', 'link', 'textbox', 'searchbox', 'combobox', 'listbox', 'option',
      'checkbox', 'radio', 'switch', 'tab', 'menuitem', 'menuitemcheckbox',
      'menuitemradio', 'slider', 'spinbutton', 'treeitem'
    ].includes(role)) {
      return true;
    }
    if (el.isContentEditable || el.getAttribute('contenteditable') === 'true') return true;
    if (el.hasAttribute('onclick') || (el.hasAttribute('tabindex') && parseInt(el.getAttribute('tabindex'), 10) >= 0)) {
      return true;
    }
    const win = el.ownerDocument?.defaultView || window;
    const style = win.getComputedStyle(el);
    if (style.cursor === 'pointer') {
      const txt = (el.innerText || '').trim();
      if (txt.length > 0 && txt.length < 90) return true;
    }
    return false;
  }

  function getAccessibleName(el) {
    const doc = el.ownerDocument || document;
    const ariaLabel = el.getAttribute('aria-label');
    if (ariaLabel && ariaLabel.trim()) return ariaLabel.trim();

    const labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) {
      const labelText = labelledBy
        .split(/\s+/)
        .map((id) => doc.getElementById(id)?.innerText?.trim())
        .filter(Boolean)
        .join(' ');
      if (labelText) return labelText;
    }

    if (el.id) {
      try {
        const assocLabel = doc.querySelector(`label[for="${CSS.escape(el.id)}"]`);
        if (assocLabel?.innerText) return assocLabel.innerText.trim();
      } catch (_e) {}
    }

    const parentLabel = el.closest?.('label');
    if (parentLabel?.innerText) {
      return parentLabel.innerText.trim().slice(0, 120);
    }

    const placeholder = el.getAttribute('placeholder');
    if (placeholder && placeholder.trim()) return placeholder.trim();

    const title = el.getAttribute('title') || el.getAttribute('alt');
    if (title && title.trim()) return title.trim();

    const innerText = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
    if (innerText) return innerText.slice(0, 140);

    if (el.value && typeof el.value === 'string' && el.type !== 'password') {
      return el.value.slice(0, 100);
    }
    return '';
  }

  function inferRole(el) {
    const explicitRole = el.getAttribute('role');
    if (explicitRole) return explicitRole.toLowerCase();
    const tag = el.tagName.toLowerCase();
    if (tag === 'a') return 'link';
    if (tag === 'button') return 'button';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'select') return 'combobox';
    if (tag === 'input') {
      const type = (el.type || 'text').toLowerCase();
      if (['button', 'submit', 'reset'].includes(type)) return 'button';
      if (type === 'checkbox') return 'checkbox';
      if (type === 'radio') return 'radio';
      if (type === 'search') return 'searchbox';
      if (type === 'file') return 'file_input';
      return `input[${type}]`;
    }
    if (el.isContentEditable) return 'textbox';
    return tag;
  }

  function buildSelectorPath(el) {
    if (!el || el.nodeType !== 1) return '';
    if (el.id) return `#${CSS.escape(el.id)}`;
    const parts = [];
    let cur = el;
    while (cur && cur.nodeType === 1 && parts.length < 4) {
      let part = cur.tagName.toLowerCase();
      if (cur.id) {
        parts.unshift(`#${CSS.escape(cur.id)}`);
        break;
      }
      const cls = Array.from(cur.classList || [])
        .filter((c) => c && !c.startsWith('agy-'))
        .slice(0, 2);
      if (cls.length) {
        part += `.${cls.map((c) => CSS.escape(c)).join('.')}`;
      }
      parts.unshift(part);
      cur = cur.parentElement;
    }
    return parts.join(' > ');
  }

  function isPdfDocument() {
    if (document.contentType === 'application/pdf') return true;
    if (/\.pdf($|\?|#)/i.test(location.pathname)) return true;
    if (document.querySelector('embed[type="application/x-google-chrome-pdf"], embed[type="application/pdf"]')) {
      return true;
    }
    return false;
  }

  // --- Safety Gate Detection ---
  function detectSafetyGates() {
    const gates = [];
    const passwordInputs = Array.from(document.querySelectorAll('input[type="password"]')).filter(isElementVisible);
    if (passwordInputs.length > 0) {
      gates.push({
        type: 'AUTHENTICATION_PASSWORD',
        message: 'Visible password field detected. Ask the user to sign in rather than entering credentials.'
      });
    }

    const otpInputs = Array.from(
      document.querySelectorAll('input[autocomplete="one-time-code"], input[name*="otp" i], input[name*="2fa" i], input[name*="mfa" i], input[id*="otp" i]')
    ).filter(isElementVisible);
    if (otpInputs.length > 0) {
      gates.push({
        type: 'MFA_CHALLENGE',
        message: 'Multi-factor authentication (2FA/OTP) input detected. Hand control to the user.'
      });
    }

    const captchaFrames = Array.from(
      document.querySelectorAll('iframe[src*="recaptcha" i], iframe[src*="hcaptcha" i], iframe[src*="turnstile" i], iframe[title*="captcha" i], .g-recaptcha, .cf-turnstile')
    ).filter(isElementVisible);
    if (captchaFrames.length > 0) {
      gates.push({
        type: 'CAPTCHA_CHALLENGE',
        message: 'CAPTCHA / bot verification challenge detected. Stop and ask the user to complete it.'
      });
    }

    const paymentInputs = Array.from(
      document.querySelectorAll('input[autocomplete^="cc-"], input[name*="cardnumber" i], iframe[name*="stripe" i]')
    ).filter(isElementVisible);
    if (paymentInputs.length > 0) {
      gates.push({
        type: 'PAYMENT_CHECKOUT',
        message: 'Payment checkout fields detected. Confirm with the user before submitting.'
      });
    }

    return gates;
  }

  // --- Snapshot Builder (with Shadow DOM + Iframe + Subtree Scoping) ---
  function buildPageSnapshot(options = {}) {
    const maxElements = options.maxElements || 250;
    const includeText = options.includeText !== false;
    const viewportOnly = options.viewportOnly === true;

    let rootTarget = document;
    let baseOffsetX = 0;
    let baseOffsetY = 0;
    if (options.refId) {
      const scoped = resolveElementWithOffset({ ref: options.refId });
      if (scoped?.el) {
        rootTarget = scoped.el;
        baseOffsetX = scoped.offsetX;
        baseOffsetY = scoped.offsetY;
      }
    }

    refMap.clear();
    const interactiveElements = [];
    const crossOriginFrames = [];
    const candidates = collectDeepCandidates(rootTarget, baseOffsetX, baseOffsetY, 0, options.maxDepth || 5, [], crossOriginFrames);

    // Phase 1: Batch all DOM geometry & style READS without mutating attributes (prevents layout thrashing)
    const pendingRefs = [];
    let counter = 1;
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    for (const { el, offsetX, offsetY } of candidates) {
      if (counter > maxElements) break;
      if (!isElementVisible(el)) continue;

      const isHeading = /^H[1-3]$/.test(el.tagName);
      const interactive = isInteractiveElement(el);
      if (!interactive && !isHeading) continue;

      const rawRect = el.getBoundingClientRect();
      const left = Math.round(rawRect.left + offsetX);
      const top = Math.round(rawRect.top + offsetY);
      const width = Math.round(rawRect.width);
      const height = Math.round(rawRect.height);
      const inViewport = top + height >= 0 && left + width >= 0 && top <= vh && left <= vw;
      if (viewportOnly && !inViewport) continue;

      const ref = `ref_${counter++}`;
      pendingRefs.push({ el, ref, offsetX, offsetY });

      const name = getAccessibleName(el);
      const role = inferRole(el);
      const item = {
        ref,
        role,
        tag: el.tagName.toLowerCase(),
        name,
        inViewport,
        rect: {
          x: Math.round(left + width / 2),
          y: Math.round(top + height / 2),
          left,
          top,
          width,
          height
        }
      };

      if (el.id) item.id = el.id;
      if (el.getAttribute('name')) item.attrName = el.getAttribute('name');
      if (el.getAttribute('href')) item.href = el.getAttribute('href');
      if (el.getAttribute('placeholder')) item.placeholder = el.getAttribute('placeholder');
      if (el.getAttribute('aria-expanded')) item.expanded = el.getAttribute('aria-expanded') === 'true';
      if (el.disabled) item.disabled = true;
      if (typeof el.checked === 'boolean' && (el.type === 'checkbox' || el.type === 'radio')) {
        item.checked = el.checked;
      }
      if (typeof el.value === 'string' && el.type !== 'password' && el.value.length > 0) {
        item.value = el.value.slice(0, 120);
      }

      interactiveElements.push(item);
    }

    // Phase 2: Batch all DOM attribute WRITES
    for (const { el, ref, offsetX, offsetY } of pendingRefs) {
      el.setAttribute('data-agy-ref', ref);
      refMap.set(ref, { ref: new WeakRef(el), offsetX, offsetY });
    }

    const treeLines = interactiveElements.map((item) => {
      const attrs = [];
      if (item.name) attrs.push(`"${item.name}"`);
      if (item.placeholder && item.placeholder !== item.name) attrs.push(`placeholder="${item.placeholder}"`);
      if (item.value) attrs.push(`value="${item.value}"`);
      if (typeof item.checked === 'boolean') attrs.push(`checked=${item.checked}`);
      if (typeof item.expanded === 'boolean') attrs.push(`expanded=${item.expanded}`);
      if (item.disabled) attrs.push('disabled');
      if (item.href) attrs.push(`href="${item.href.slice(0, 80)}"`);
      if (!item.inViewport) attrs.push('offscreen');
      return `[${item.ref}] ${item.role} ${attrs.join(' ')} @(${item.rect.x},${item.rect.y})`.trim();
    });

    const pdfEmbed = isPdfDocument();
    let visibleText = '';
    if (includeText && document.body && !pdfEmbed) {
      visibleText = (document.body.innerText || '')
        .replace(/\n{3,}/g, '\n\n')
        .trim()
        .slice(0, options.maxTextLength || 12000);
    }

    return {
      url: location.href,
      title: document.title,
      isPdfEmbed: pdfEmbed,
      crossOriginFrameCount: crossOriginFrames.length,
      crossOriginFrames: crossOriginFrames.slice(0, 10),
      pausedByUser: isPausedByUser,
      viewport: {
        width: vw,
        height: vh,
        dpr: window.devicePixelRatio || 1,
        scrollX: Math.round(window.scrollX),
        scrollY: Math.round(window.scrollY),
        scrollHeight: document.documentElement?.scrollHeight || 0
      },
      safetyGates: detectSafetyGates(),
      elementCount: interactiveElements.length,
      elements: interactiveElements,
      formattedTree: treeLines.join('\n'),
      visibleText,
      selection: window.getSelection()?.toString()?.trim() || ''
    };
  }

  // --- Clean Structured Markdown Extraction (Claude get_page_text equivalent) ---
  function extractStructuredMarkdown(options = {}) {
    if (isPdfDocument()) {
      return {
        url: location.href,
        title: document.title,
        isPdfEmbed: true,
        markdown: ''
      };
    }

    const root =
      document.querySelector('article, [role="main"], main') ||
      document.body;
    if (!root) {
      return { url: location.href, title: document.title, isPdfEmbed: false, markdown: '' };
    }

    const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'SVG', 'NAV', 'FOOTER', 'ASIDE']);
    const lines = [];

    function walk(node) {
      if (!node) return;
      if (node.nodeType === Node.TEXT_NODE) return;
      if (node.nodeType !== Node.ELEMENT_NODE) return;

      const el = node;
      if (el.id === 'agy-chrome-hud-root' || SKIP_TAGS.has(el.tagName)) return;
      if (el.getAttribute('aria-hidden') === 'true') return;
      if (!isElementVisible(el)) return;

      const tag = el.tagName;
      if (/^H[1-6]$/.test(tag)) {
        const level = Number(tag[1]);
        const txt = (el.innerText || '').replace(/\s+/g, ' ').trim();
        if (txt) lines.push(`\n${'#'.repeat(level)} ${txt}\n`);
        return;
      }
      if (tag === 'PRE') {
        const code = (el.innerText || '').trim();
        if (code) lines.push(`\n\`\`\`\n${code}\n\`\`\`\n`);
        return;
      }
      if (tag === 'TABLE') {
        const rows = Array.from(el.querySelectorAll('tr'));
        rows.slice(0, 60).forEach((tr, idx) => {
          const cells = Array.from(tr.querySelectorAll('th, td')).map((c) =>
            (c.innerText || '').replace(/\s+/g, ' ').replace(/\|/g, '\\|').trim()
          );
          if (cells.length) {
            lines.push(`| ${cells.join(' | ')} |`);
            if (idx === 0) {
              lines.push(`| ${cells.map(() => '---').join(' | ')} |`);
            }
          }
        });
        lines.push('');
        return;
      }
      if (tag === 'LI') {
        const txt = (el.innerText || '').replace(/\s+/g, ' ').trim();
        if (txt) lines.push(`- ${txt}`);
        return;
      }
      if (tag === 'P' || tag === 'BLOCKQUOTE') {
        const txt = (el.innerText || '').replace(/\s+/g, ' ').trim();
        if (txt) lines.push(tag === 'BLOCKQUOTE' ? `> ${txt}\n` : `${txt}\n`);
        return;
      }

      // Emit leaf text blocks inside modern React/Tailwind <div>, <section>, <output>, <span>, <dd>, <dt>, etc.
      const BLOCK_TAGS = new Set(['DIV', 'SECTION', 'ARTICLE', 'MAIN', 'HEADER', 'FORM', 'UL', 'OL', 'TABLE', 'PRE', 'P', 'BLOCKQUOTE', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'LI', 'TR', 'FIELDSET']);
      const hasStructuralChild = Array.from(el.children).some((ch) => BLOCK_TAGS.has(ch.tagName));
      if (!hasStructuralChild && !['BUTTON', 'SELECT', 'OPTION', 'INPUT', 'TEXTAREA'].includes(tag)) {
        const txt = (el.innerText || '').replace(/\s+/g, ' ').trim();
        if (txt) {
          lines.push(txt);
          return;
        }
      }

      for (const child of el.children) {
        walk(child);
      }
    }

    walk(root);
    let markdown = lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
    if (!markdown && document.body) {
      markdown = (document.body.innerText || '').replace(/\n{3,}/g, '\n\n').trim();
    }

    const maxChars = options.maxLength || 20000;
    return {
      url: location.href,
      title: document.title,
      isPdfEmbed: false,
      selection: window.getSelection()?.toString()?.trim() || '',
      markdown: markdown.slice(0, maxChars)
    };
  }

  // --- Fast Semantic Element Search (Claude `find` equivalent) ---
  function findElementsByQuery(params = {}) {
    const query = String(params.query || '').trim();
    const roleFilter = params.role ? String(params.role).toLowerCase() : null;
    const limit = Math.min(Number(params.limit) || 25, 80);

    if (!query && !roleFilter) {
      throw new Error('Provide a "query" or "role" parameter to search elements.');
    }

    const candidates = collectDeepCandidates(document, 0, 0, 0, 5);
    const matches = [];
    const qLower = query.toLowerCase();

    let selectorMatches = new Set();
    if (query) {
      try {
        document.querySelectorAll(query).forEach((el) => selectorMatches.add(el));
      } catch (_notValidCss) {}
    }

    let nextRefNum = refMap.size + 1;

    for (const { el, offsetX, offsetY } of candidates) {
      if (matches.length >= limit) break;
      if (!isElementVisible(el)) continue;

      const role = inferRole(el);
      if (roleFilter && role !== roleFilter) continue;

      const name = getAccessibleName(el);
      const idStr = el.id || '';
      const placeholder = el.getAttribute('placeholder') || '';
      const aria = el.getAttribute('aria-label') || '';
      const haystack = `${name} ${idStr} ${placeholder} ${aria} ${role} ${el.tagName.toLowerCase()}`.toLowerCase();

      if (!query || selectorMatches.has(el) || haystack.includes(qLower)) {
        let ref = el.getAttribute('data-agy-ref');
        if (!ref) {
          ref = `ref_${nextRefNum++}`;
          el.setAttribute('data-agy-ref', ref);
        }
        refMap.set(ref, { ref: new WeakRef(el), offsetX, offsetY });

        const rawRect = el.getBoundingClientRect();
        const left = Math.round(rawRect.left + offsetX);
        const top = Math.round(rawRect.top + offsetY);
        const width = Math.round(rawRect.width);
        const height = Math.round(rawRect.height);

        matches.push({
          ref,
          role,
          tag: el.tagName.toLowerCase(),
          name: name.slice(0, 140),
          selector: buildSelectorPath(el),
          playwrightLocator: buildPlaywrightLocator(el),
          coordinates: {
            x: Math.round(left + width / 2),
            y: Math.round(top + height / 2)
          },
          rect: { left, top, width, height }
        });
      }
    }

    return {
      query,
      count: matches.length,
      matches
    };
  }

  // --- Deep Computed Style & DOM Inspector (Codex Inspector equivalent) ---
  function inspectElementDeep(params = {}) {
    const resolved = resolveElementWithOffset(params);
    if (!resolved?.el) {
      throw new Error(`Element not found for inspection: ${JSON.stringify(params)}`);
    }
    const { el, offsetX, offsetY } = resolved;
    const win = el.ownerDocument?.defaultView || window;
    const cs = win.getComputedStyle(el);
    const rawRect = el.getBoundingClientRect();

    let ref = el.getAttribute('data-agy-ref');
    if (!ref) {
      ref = `ref_${refMap.size + 1}`;
      el.setAttribute('data-agy-ref', ref);
      refMap.set(ref, { ref: new WeakRef(el), offsetX, offsetY });
    }

    const attributes = {};
    for (const attr of Array.from(el.attributes || [])) {
      if (attr.name !== 'data-agy-ref') {
        attributes[attr.name] = String(attr.value).slice(0, 200);
      }
    }

    return {
      ref,
      tag: el.tagName.toLowerCase(),
      id: el.id || null,
      classes: Array.from(el.classList || []),
      selector: buildSelectorPath(el),
      playwrightLocator: buildPlaywrightLocator(el),
      role: inferRole(el),
      accessibleName: getAccessibleName(el),
      contrastRatio: computeElementContrastRatio(el),
      rect: {
        x: Math.round(rawRect.left + offsetX),
        y: Math.round(rawRect.top + offsetY),
        width: Math.round(rawRect.width),
        height: Math.round(rawRect.height),
        dpr: window.devicePixelRatio || 1
      },
      attributes,
      computedStyles: {
        display: cs.display,
        position: cs.position,
        width: cs.width,
        height: cs.height,
        padding: cs.padding,
        margin: cs.margin,
        color: cs.color,
        backgroundColor: cs.backgroundColor,
        border: cs.border,
        borderRadius: cs.borderRadius,
        fontFamily: cs.fontFamily,
        fontSize: cs.fontSize,
        fontWeight: cs.fontWeight,
        lineHeight: cs.lineHeight,
        flexDirection: cs.flexDirection,
        justifyContent: cs.justifyContent,
        alignItems: cs.alignItems,
        gap: cs.gap,
        zIndex: cs.zIndex,
        opacity: cs.opacity
      },
      outerHTMLPreview: (el.outerHTML || '').slice(0, 1200)
    };
  }

  // --- Set-of-Marks (SoM) Batched Rendering ---
  async function renderSomOverlay() {
    const hud = ensureHud();
    if (!hud) return { count: 0 };
    hud.somContainer.innerHTML = '';

    const snapshot = buildPageSnapshot({ viewportOnly: true, includeText: false, maxElements: 120 });
    const items = snapshot.elements.filter((e) => e.inViewport && !['h1', 'h2', 'h3'].includes(e.role));

    const BATCH_SIZE = 20;
    const runFrame = (cb) =>
      document.hidden
        ? Promise.resolve().then(cb)
        : new Promise((resolve) => {
            const t = setTimeout(() => { cb(); resolve(); }, 60);
            requestAnimationFrame(() => { clearTimeout(t); cb(); resolve(); });
          });

    for (let i = 0; i < items.length; i += BATCH_SIZE) {
      await runFrame(() => {
        for (const item of items.slice(i, i + BATCH_SIZE)) {
          const num = item.ref.replace('ref_', '');
          const outline = document.createElement('div');
          outline.className = 'agy-som-outline';
          outline.style.left = `${item.rect.left}px`;
          outline.style.top = `${item.rect.top}px`;
          outline.style.width = `${item.rect.width}px`;
          outline.style.height = `${item.rect.height}px`;

          const badge = document.createElement('div');
          badge.className = 'agy-som-badge';
          badge.textContent = num;
          badge.style.left = `${Math.max(0, item.rect.left - 1)}px`;
          badge.style.top = `${Math.max(0, item.rect.top - 15)}px`;

          hud.somContainer.append(outline, badge);
        }
      });
      if (globalThis.scheduler?.yield) {
        await globalThis.scheduler.yield();
      }
    }

    return { count: items.length, elements: items };
  }

  function clearSomOverlay() {
    if (hudElements?.somContainer) {
      hudElements.somContainer.innerHTML = '';
    }
    return { cleared: true };
  }

  // --- Element Resolution across Light + Shadow DOM + Iframes ---
  function resolveElementWithOffset(target = {}) {
    if (target.ref) {
      const normalizedRef = String(target.ref).startsWith('ref_')
        ? String(target.ref)
        : `ref_${target.ref}`;
      const entry = refMap.get(normalizedRef);
      const fromMap = entry?.ref?.deref();
      if (fromMap && fromMap.isConnected) {
        return { el: fromMap, offsetX: entry.offsetX || 0, offsetY: entry.offsetY || 0 };
      }
      const deep = collectDeepCandidates(document, 0, 0, 0, 5);
      const found = deep.find((item) => item.el.getAttribute?.('data-agy-ref') === normalizedRef);
      if (found) return found;
    }

    if (target.selector) {
      try {
        const direct = document.querySelector(target.selector);
        if (direct) return { el: direct, offsetX: 0, offsetY: 0 };
        const deep = collectDeepCandidates(document, 0, 0, 0, 5);
        const match = deep.find((item) => {
          try {
            return item.el.matches?.(target.selector);
          } catch (_e) {
            return false;
          }
        });
        if (match) return match;
      } catch (_e) {}
    }

    if (target.text) {
      const needle = String(target.text).toLowerCase().trim();
      const deep = collectDeepCandidates(document, 0, 0, 0, 5).filter(
        (item) => isInteractiveElement(item.el) && isElementVisible(item.el)
      );
      const exact = deep.find((item) => getAccessibleName(item.el).toLowerCase() === needle);
      if (exact) return exact;
      const partial = deep.find((item) => getAccessibleName(item.el).toLowerCase().includes(needle));
      if (partial) return partial;
    }

    if (typeof target.x === 'number' && typeof target.y === 'number') {
      const el = document.elementFromPoint(target.x, target.y);
      if (el) return { el, offsetX: 0, offsetY: 0 };
    }

    return null;
  }

  function resolveElement(target = {}) {
    return resolveElementWithOffset(target)?.el || null;
  }

  function setNativeValue(element, value) {
    const win = element.ownerDocument?.defaultView || window;
    const tag = element.tagName.toLowerCase();
    const proto =
      tag === 'textarea'
        ? win.HTMLTextAreaElement.prototype
        : tag === 'select'
          ? win.HTMLSelectElement.prototype
          : win.HTMLInputElement.prototype;
    const descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
    if (descriptor?.set) {
      descriptor.set.call(element, value);
    } else {
      element.value = value;
    }
  }

  // --- Actuation Handlers ---
  async function performClick(params = {}) {
    if (isPausedByUser) {
      throw new Error('Action blocked: User has paused Antigravity control on this tab.');
    }

    const resolved = resolveElementWithOffset(params);
    const el = resolved?.el || null;
    if (!el && (typeof params.x !== 'number' || typeof params.y !== 'number')) {
      throw new Error(`Target element not found for ${JSON.stringify({ ref: params.ref, selector: params.selector, text: params.text })}. Call chrome_read_page first.`);
    }

    let clickX = params.x;
    let clickY = params.y;

    const fastMode = Boolean(params.fast || document.hidden);
    if (el) {
      el.scrollIntoView({ behavior: 'instant', block: 'center', inline: 'center' });
      if (!fastMode) await new Promise((r) => setTimeout(r, 30));
      const rect = el.getBoundingClientRect();
      clickX = Math.round(rect.left + (resolved?.offsetX || 0) + rect.width / 2);
      clickY = Math.round(rect.top + (resolved?.offsetY || 0) + rect.height / 2);
    }

    const targetEl = el || document.elementFromPoint(clickX, clickY) || document.body;
    const label = getAccessibleName(targetEl) || targetEl.tagName.toLowerCase();
    await animateAgentAction(targetEl, clickX, clickY, `Click "${label.slice(0, 40)}"`, true, fastMode);

    const buttonMap = { left: 0, middle: 1, right: 2 };
    const button = buttonMap[params.button || 'left'] ?? 0;
    const eventInit = {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: targetEl.ownerDocument?.defaultView || window,
      clientX: clickX - (resolved?.offsetX || 0),
      clientY: clickY - (resolved?.offsetY || 0),
      button,
      buttons: button === 2 ? 2 : 1,
      ctrlKey: Boolean(params.ctrlKey),
      shiftKey: Boolean(params.shiftKey),
      altKey: Boolean(params.altKey),
      metaKey: Boolean(params.metaKey)
    };

    targetEl.dispatchEvent(new PointerEvent('pointerover', eventInit));
    targetEl.dispatchEvent(new MouseEvent('mouseover', eventInit));
    targetEl.dispatchEvent(new PointerEvent('pointerdown', eventInit));
    targetEl.dispatchEvent(new MouseEvent('mousedown', eventInit));
    if (typeof targetEl.focus === 'function') {
      targetEl.focus({ preventScroll: true });
    }
    targetEl.dispatchEvent(new PointerEvent('pointerup', eventInit));
    targetEl.dispatchEvent(new MouseEvent('mouseup', eventInit));
    targetEl.dispatchEvent(new MouseEvent('click', eventInit));

    if (params.doubleClick || params.tripleClick) {
      targetEl.dispatchEvent(new MouseEvent('dblclick', { ...eventInit, detail: 2 }));
    }
    if (params.tripleClick) {
      targetEl.dispatchEvent(new MouseEvent('click', { ...eventInit, detail: 3 }));
    }
    if (button === 2) {
      targetEl.dispatchEvent(new MouseEvent('contextmenu', eventInit));
    }

    return {
      clicked: true,
      ref: params.ref || targetEl.getAttribute?.('data-agy-ref') || null,
      tag: targetEl.tagName.toLowerCase(),
      name: label,
      coordinates: { x: clickX, y: clickY }
    };
  }

  async function performHover(params = {}) {
    const resolved = resolveElementWithOffset(params);
    const el = resolved?.el || null;
    let hX = Number(params.x);
    let hY = Number(params.y);

    const fastMode = Boolean(params.fast || document.hidden);
    if (el) {
      el.scrollIntoView({ behavior: 'instant', block: 'center', inline: 'center' });
      if (!fastMode) await new Promise((r) => setTimeout(r, 30));
      const rect = el.getBoundingClientRect();
      hX = Math.round(rect.left + (resolved?.offsetX || 0) + rect.width / 2);
      hY = Math.round(rect.top + (resolved?.offsetY || 0) + rect.height / 2);
    }

    const targetEl = el || document.elementFromPoint(hX, hY) || document.body;
    const label = params.label || getAccessibleName(targetEl) || targetEl.tagName.toLowerCase();
    await animateAgentAction(targetEl, hX, hY, `Hover "${label.slice(0, 42)}"`, false, fastMode);

    const eventInit = {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: targetEl.ownerDocument?.defaultView || window,
      clientX: hX - (resolved?.offsetX || 0),
      clientY: hY - (resolved?.offsetY || 0)
    };
    targetEl.dispatchEvent(new PointerEvent('pointermove', eventInit));
    targetEl.dispatchEvent(new MouseEvent('mousemove', eventInit));
    targetEl.dispatchEvent(new MouseEvent('mouseenter', eventInit));

    const dwellMs = fastMode ? Math.min(Number(params.dwellMs) || 30, 500) : Math.min(Number(params.dwellMs) || 400, 4000);
    if (dwellMs > 0) await new Promise((r) => setTimeout(r, dwellMs));

    return {
      hovered: true,
      ref: params.ref || targetEl.getAttribute?.('data-agy-ref') || null,
      name: label,
      coordinates: { x: hX, y: hY }
    };
  }

  async function performHighlight(params = {}) {
    const hud = ensureHud();
    if (!hud) return { highlighted: false };

    if (params.clear) {
      if (activeHighlightBox) {
        activeHighlightBox.remove();
        activeHighlightBox = null;
      }
      return { cleared: true };
    }

    const resolved = resolveElementWithOffset(params);
    if (!resolved?.el) {
      throw new Error(`Element not found for highlight: ${JSON.stringify({ ref: params.ref, selector: params.selector })}`);
    }
    const { el, offsetX, offsetY } = resolved;
    el.scrollIntoView({ behavior: 'instant', block: 'center', inline: 'center' });
    await new Promise((r) => setTimeout(r, 40));
    const rect = el.getBoundingClientRect();
    const left = Math.round(rect.left + offsetX);
    const top = Math.round(rect.top + offsetY);

    if (activeHighlightBox) activeHighlightBox.remove();
    activeHighlightBox = document.createElement('div');
    activeHighlightBox.className = 'agy-highlight-box';
    activeHighlightBox.style.left = `${left - 3}px`;
    activeHighlightBox.style.top = `${top - 3}px`;
    activeHighlightBox.style.width = `${Math.round(rect.width + 6)}px`;
    activeHighlightBox.style.height = `${Math.round(rect.height + 6)}px`;
    hud.root.appendChild(activeHighlightBox);

    const label = params.label || getAccessibleName(el) || el.tagName.toLowerCase();
    const hX = Math.round(left + rect.width / 2);
    const hY = Math.round(top + rect.height / 2);
    await animateAgentAction(el, hX, hY, label.slice(0, 45), false);

    const durationMs = Math.min(Number(params.durationMs) || 3000, 10000);
    setTimeout(() => {
      if (activeHighlightBox) {
        activeHighlightBox.remove();
        activeHighlightBox = null;
      }
    }, durationMs);

    return {
      highlighted: true,
      ref: params.ref || el.getAttribute('data-agy-ref') || null,
      name: label,
      coordinates: { x: hX, y: hY }
    };
  }

  async function performDragAndDrop(params = {}) {
    if (isPausedByUser) {
      throw new Error('Action blocked: User has paused Antigravity control on this tab.');
    }

    const srcResolved = resolveElementWithOffset({
      ref: params.sourceRef,
      selector: params.sourceSelector,
      x: params.startX,
      y: params.startY
    });
    const dstResolved = resolveElementWithOffset({
      ref: params.targetRef,
      selector: params.targetSelector,
      x: params.endX,
      y: params.endY
    });

    const srcEl = srcResolved?.el || document.elementFromPoint(params.startX || 0, params.startY || 0);
    const dstEl = dstResolved?.el || document.elementFromPoint(params.endX || 0, params.endY || 0);

    let sx = Number(params.startX);
    let sy = Number(params.startY);
    if (srcEl && (Number.isNaN(sx) || Number.isNaN(sy))) {
      srcEl.scrollIntoView({ behavior: 'instant', block: 'center' });
      const r = srcEl.getBoundingClientRect();
      sx = Math.round(r.left + (srcResolved?.offsetX || 0) + r.width / 2);
      sy = Math.round(r.top + (srcResolved?.offsetY || 0) + r.height / 2);
    }

    let ex = Number(params.endX);
    let ey = Number(params.endY);
    if (dstEl && (Number.isNaN(ex) || Number.isNaN(ey))) {
      dstEl.scrollIntoView({ behavior: 'instant', block: 'center' });
      const r = dstEl.getBoundingClientRect();
      ex = Math.round(r.left + (dstResolved?.offsetX || 0) + r.width / 2);
      ey = Math.round(r.top + (dstResolved?.offsetY || 0) + r.height / 2);
    }

    if (Number.isNaN(sx) || Number.isNaN(sy) || Number.isNaN(ex) || Number.isNaN(ey)) {
      throw new Error('Could not determine source and target coordinates for drag_and_drop.');
    }

    showHudStatus('Dragging element...', 3500);
    const hud = ensureHud();
    if (hud) {
      hud.cursor.classList.add('agy-visible');
      await smoothGlideCursor(lastCursorX || sx, lastCursorY || sy, sx, sy, 160);
    }

    const dt = new DataTransfer();
    if (srcEl) {
      srcEl.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: sx, clientY: sy, buttons: 1 }));
      srcEl.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: sx, clientY: sy, buttons: 1 }));
      srcEl.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, clientX: sx, clientY: sy, dataTransfer: dt }));
    }

    if (hud) {
      await smoothGlideCursor(sx, sy, ex, ey, 280);
    }

    const dropTarget = dstEl || document.elementFromPoint(ex, ey) || document.body;
    dropTarget.dispatchEvent(new DragEvent('dragenter', { bubbles: true, cancelable: true, clientX: ex, clientY: ey, dataTransfer: dt }));
    dropTarget.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, clientX: ex, clientY: ey, dataTransfer: dt }));
    dropTarget.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: ex, clientY: ey, buttons: 1 }));
    dropTarget.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: ex, clientY: ey, buttons: 1 }));
    dropTarget.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, clientX: ex, clientY: ey, dataTransfer: dt }));

    if (srcEl) {
      srcEl.dispatchEvent(new DragEvent('dragend', { bubbles: true, cancelable: true, clientX: ex, clientY: ey, dataTransfer: dt }));
    }
    dropTarget.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: ex, clientY: ey, buttons: 0 }));
    dropTarget.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: ex, clientY: ey, buttons: 0 }));

    return {
      dragged: true,
      from: { x: sx, y: sy },
      to: { x: ex, y: ey }
    };
  }

  async function performUploadFileData(params = {}) {
    if (isPausedByUser) {
      throw new Error('Action blocked: User has paused Antigravity control on this tab.');
    }
    const el =
      resolveElement({ ref: params.ref, selector: params.selector }) ||
      document.querySelector('input[type="file"]');
    if (!el) {
      throw new Error('Target element or <input type="file"> not found for file upload.');
    }

    const binary = atob(params.base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    const file = new File([bytes], params.fileName || 'upload.bin', {
      type: params.mimeType || 'application/octet-stream'
    });
    const dt = new DataTransfer();
    dt.items.add(file);

    if (el.tagName === 'INPUT' && el.type === 'file') {
      el.files = dt.files;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return { uploaded: true, via: 'input.files', fileName: file.name, size: file.size };
    }

    const rect = el.getBoundingClientRect();
    const cx = Math.round(rect.left + rect.width / 2);
    const cy = Math.round(rect.top + rect.height / 2);
    el.dispatchEvent(new DragEvent('dragenter', { bubbles: true, cancelable: true, clientX: cx, clientY: cy, dataTransfer: dt }));
    el.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, clientX: cx, clientY: cy, dataTransfer: dt }));
    el.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, clientX: cx, clientY: cy, dataTransfer: dt }));
    return { uploaded: true, via: 'dropzone', fileName: file.name, size: file.size };
  }

  async function performType(params = {}) {
    if (isPausedByUser) {
      throw new Error('Action blocked: User has paused Antigravity control on this tab.');
    }

    const resolved = resolveElementWithOffset({ ref: params.ref, selector: params.selector, x: params.x, y: params.y });
    const el = resolved?.el || document.activeElement;
    if (!el || el === document.body) {
      throw new Error(`Editable element not found for ${JSON.stringify({ ref: params.ref, selector: params.selector })}`);
    }

    const fastMode = Boolean(params.fast || document.hidden);
    el.scrollIntoView({ behavior: 'instant', block: 'center', inline: 'center' });
    if (!fastMode) await new Promise((r) => setTimeout(r, 25));
    const rect = el.getBoundingClientRect();
    const label = getAccessibleName(el) || el.tagName.toLowerCase();
    animateAgentAction(
      el,
      rect.left + (resolved?.offsetX || 0) + rect.width / 2,
      rect.top + (resolved?.offsetY || 0) + rect.height / 2,
      `Type into "${label.slice(0, 35)}"`,
      false,
      fastMode
    );

    el.focus({ preventScroll: true });

    const text = String(params.text ?? '');
    const clearFirst = params.clearFirst !== false;
    const humanSpeed = params.humanSpeed === true;

    if (el.isContentEditable || el.getAttribute('contenteditable') === 'true') {
      if (clearFirst) el.innerText = '';
      el.innerText = (clearFirst ? '' : el.innerText) + text;
      el.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, data: text, inputType: 'insertText' }));
    } else if (el.tagName.toLowerCase() === 'select') {
      const option = Array.from(el.options).find(
        (opt) => opt.value === text || opt.text.trim().toLowerCase() === text.toLowerCase()
      );
      setNativeValue(el, option ? option.value : text);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    } else {
      if (clearFirst) setNativeValue(el, '');
      if (humanSpeed && text.length < 80) {
        for (const char of text) {
          setNativeValue(el, (el.value || '') + char);
          el.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, data: char, inputType: 'insertText' }));
          await new Promise((r) => setTimeout(r, 18));
        }
      } else {
        setNativeValue(el, clearFirst ? text : (el.value || '') + text);
        el.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, data: text, inputType: 'insertText' }));
      }
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }

    if (params.pressEnter) {
      const enterInit = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true };
      el.dispatchEvent(new KeyboardEvent('keydown', enterInit));
      el.dispatchEvent(new KeyboardEvent('keypress', enterInit));
      el.dispatchEvent(new KeyboardEvent('keyup', enterInit));
      if (el.form && typeof el.form.requestSubmit === 'function') {
        try {
          el.form.requestSubmit();
        } catch (_err) {}
      }
    }

    return {
      typed: true,
      ref: params.ref || el.getAttribute('data-agy-ref') || null,
      tag: el.tagName.toLowerCase(),
      name: label,
      pressedEnter: Boolean(params.pressEnter)
    };
  }

  async function performFillForm(params = {}) {
    const fields = Array.isArray(params.fields) ? params.fields : [];
    const results = [];
    for (const field of fields) {
      if (field.type === 'checkbox' || typeof field.checked === 'boolean') {
        const el = resolveElement(field);
        if (el && Boolean(el.checked) !== Boolean(field.checked)) {
          await performClick(field);
        }
        results.push({ ref: field.ref, selector: field.selector, updated: Boolean(el) });
      } else {
        const res = await performType({
          ref: field.ref,
          selector: field.selector,
          text: field.value ?? field.text ?? '',
          clearFirst: true,
          pressEnter: false
        });
        results.push(res);
      }
    }
    return { filledCount: results.length, results };
  }

  async function performPressKey(params = {}) {
    if (isPausedByUser) {
      throw new Error('Action blocked: User has paused Antigravity control on this tab.');
    }

    const rawKey = String(params.key || 'Enter');
    const parts = rawKey.split('+');
    const mainKey = parts.pop() || 'Enter';
    const modifiers = new Set(parts.map((p) => p.toLowerCase()));

    const target = resolveElement(params) || document.activeElement || document.body;
    showHudStatus(`Key "${rawKey}"`);

    const keyInit = {
      key: mainKey,
      code: mainKey.length === 1 ? `Key${mainKey.toUpperCase()}` : mainKey,
      bubbles: true,
      cancelable: true,
      composed: true,
      ctrlKey: modifiers.has('control') || modifiers.has('ctrl'),
      shiftKey: modifiers.has('shift'),
      altKey: modifiers.has('alt'),
      metaKey: modifiers.has('meta') || modifiers.has('cmd') || modifiers.has('command')
    };

    target.dispatchEvent(new KeyboardEvent('keydown', keyInit));
    target.dispatchEvent(new KeyboardEvent('keyup', keyInit));

    return { pressed: rawKey, targetTag: target.tagName.toLowerCase() };
  }

  async function performScroll(params = {}) {
    const direction = (params.direction || 'down').toLowerCase();
    const amount = Number(params.amount) || Math.round(window.innerHeight * 0.75);
    const el = resolveElement(params);

    showHudStatus(`Scroll ${direction}`);

    if (el && el !== document.body && el !== document.documentElement) {
      if (params.toElement) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      } else {
        const dx = direction === 'left' ? -amount : direction === 'right' ? amount : 0;
        const dy = direction === 'up' ? -amount : direction === 'down' ? amount : 0;
        el.scrollBy({ left: dx, top: dy, behavior: 'instant' });
      }
    } else if (direction === 'top') {
      window.scrollTo({ top: 0, behavior: 'instant' });
    } else if (direction === 'bottom') {
      window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'instant' });
    } else {
      const dx = direction === 'left' ? -amount : direction === 'right' ? amount : 0;
      const dy = direction === 'up' ? -amount : direction === 'down' ? amount : 0;
      window.scrollBy({ left: dx, top: dy, behavior: 'instant' });
    }

    if (!params.fast && !document.hidden) {
      await new Promise((r) => setTimeout(r, 40));
    }
    return {
      scrolled: true,
      direction,
      scrollX: Math.round(window.scrollX),
      scrollY: Math.round(window.scrollY),
      scrollHeight: document.documentElement.scrollHeight
    };
  }

  async function performWaitFor(params = {}) {
    const timeoutMs = Math.min(Number(params.timeoutMs) || 10000, 30000);
    const start = Date.now();

    while (Date.now() - start < timeoutMs) {
      if (params.urlIncludes) {
        if (location.href.includes(String(params.urlIncludes))) {
          return { matched: true, url: location.href, elapsedMs: Date.now() - start };
        }
      } else if (params.selector) {
        const el = resolveElement({ selector: params.selector });
        if (params.state === 'hidden') {
          if (!el || !isElementVisible(el)) return { matched: true, elapsedMs: Date.now() - start };
        } else if (el && isElementVisible(el)) {
          return { matched: true, elapsedMs: Date.now() - start };
        }
      } else if (params.text) {
        const bodyText = (document.body?.innerText || '').toLowerCase();
        const found = bodyText.includes(String(params.text).toLowerCase());
        if (params.state === 'hidden' ? !found : found) {
          return { matched: true, elapsedMs: Date.now() - start };
        }
      } else {
        await new Promise((r) => setTimeout(r, Math.min(timeoutMs, 1000)));
        return { matched: true, elapsedMs: Date.now() - start };
      }
      await new Promise((r) => setTimeout(r, 150));
    }

    throw new Error(`Timed out after ${timeoutMs}ms waiting for condition.`);
  }

  function collectPerformanceNetworkLogs() {
    try {
      const entries = performance.getEntriesByType('resource') || [];
      return entries.slice(-120).map((e) => ({
        name: e.name,
        initiatorType: e.initiatorType,
        durationMs: Math.round(e.duration),
        transferSize: e.transferSize || 0,
        responseStatus: e.responseStatus || null,
        startTimeMs: Math.round(e.startTime)
      }));
    } catch (_err) {
      return [];
    }
  }

  // --- Interactive Element Picker (Codex App-Shot / Inspector) ---
  function startInteractiveElementPicker() {
    const existing = document.getElementById('agy-picker-shield');
    if (existing) existing.remove();

    const shield = document.createElement('div');
    shield.id = 'agy-picker-shield';

    const box = document.createElement('div');
    box.id = 'agy-picker-box';
    box.style.display = 'none';

    const label = document.createElement('div');
    label.id = 'agy-picker-label';
    label.textContent = 'Click an element to attach · Esc to cancel';
    label.style.top = '12px';
    label.style.left = '12px';

    shield.append(box, label);
    document.body.appendChild(shield);

    let hoveredTarget = null;

    function cleanup() {
      window.removeEventListener('keydown', onKeyDown, true);
      shield.remove();
    }

    function onKeyDown(e) {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        cleanup();
      }
    }

    shield.addEventListener('mousemove', (e) => {
      shield.style.pointerEvents = 'none';
      const el = document.elementFromPoint(e.clientX, e.clientY);
      shield.style.pointerEvents = 'auto';

      if (!el || el === document.body || el === document.documentElement || el.closest('#agy-chrome-hud-root')) {
        hoveredTarget = null;
        box.style.display = 'none';
        return;
      }

      hoveredTarget = el;
      const r = el.getBoundingClientRect();
      box.style.display = 'block';
      box.style.left = `${Math.round(r.left)}px`;
      box.style.top = `${Math.round(r.top)}px`;
      box.style.width = `${Math.round(r.width)}px`;
      box.style.height = `${Math.round(r.height)}px`;

      const tag = el.tagName.toLowerCase();
      const idPart = el.id ? `#${el.id}` : '';
      const clsPart = el.classList?.[0] ? `.${el.classList[0]}` : '';
      label.textContent = `${tag}${idPart}${clsPart} · ${Math.round(r.width)}×${Math.round(r.height)}`;
      label.style.left = `${Math.min(window.innerWidth - 220, Math.max(8, Math.round(r.left)))}px`;
      label.style.top = `${r.top > 32 ? Math.round(r.top - 28) : Math.round(r.bottom + 6)}px`;
    });

    shield.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const target = hoveredTarget;
      cleanup();
      if (!target) return;

      let ref = target.getAttribute('data-agy-ref');
      if (!ref) {
        ref = `ref_${refMap.size + 1}`;
        target.setAttribute('data-agy-ref', ref);
      }
      refMap.set(ref, { ref: new WeakRef(target), offsetX: 0, offsetY: 0 });
      const info = inspectElementDeep({ ref });
      showToast(`Attached <${info.tag}>`);
      chrome.runtime.sendMessage({
        type: 'ELEMENT_PICKED',
        element: info,
        url: location.href,
        title: document.title
      }).catch(() => {});
    });

    window.addEventListener('keydown', onKeyDown, true);
  }

  // --- Interactive Region Snip Selector (Codex Visual App-Shot) ---
  function startSnipSelection() {
    const existing = document.getElementById('agy-picker-shield');
    if (existing) existing.remove();

    const shield = document.createElement('div');
    shield.id = 'agy-picker-shield';
    shield.className = 'agy-snip-mode';

    const box = document.createElement('div');
    box.id = 'agy-picker-box';
    box.style.display = 'none';

    const label = document.createElement('div');
    label.id = 'agy-picker-label';
    label.textContent = 'Drag to capture region · Esc to cancel';
    label.style.top = '14px';
    label.style.left = '50%';
    label.style.transform = 'translateX(-50%)';

    shield.append(box, label);
    document.body.appendChild(shield);

    let startX = null;
    let startY = null;

    function cleanup() {
      window.removeEventListener('keydown', onKeyDown, true);
      shield.remove();
    }

    function onKeyDown(e) {
      if (e.key === 'Escape') {
        e.preventDefault();
        cleanup();
      }
    }

    shield.addEventListener('mousedown', (e) => {
      startX = e.clientX;
      startY = e.clientY;
      box.style.display = 'block';
      box.style.left = `${startX}px`;
      box.style.top = `${startY}px`;
      box.style.width = '0px';
      box.style.height = '0px';
    });

    shield.addEventListener('mousemove', (e) => {
      if (startX === null) return;
      const x = Math.min(startX, e.clientX);
      const y = Math.min(startY, e.clientY);
      const w = Math.abs(e.clientX - startX);
      const h = Math.abs(e.clientY - startY);
      box.style.left = `${x}px`;
      box.style.top = `${y}px`;
      box.style.width = `${w}px`;
      box.style.height = `${h}px`;
    });

    shield.addEventListener('mouseup', (e) => {
      if (startX === null) return;
      const x = Math.min(startX, e.clientX);
      const y = Math.min(startY, e.clientY);
      const width = Math.abs(e.clientX - startX);
      const height = Math.abs(e.clientY - startY);
      cleanup();

      if (width < 8 || height < 8) return;
      // Wait 1 frame so the overlay is completely gone before capturing
      requestAnimationFrame(() => {
        setTimeout(() => {
          chrome.runtime.sendMessage({
            type: 'REGION_SNIPPED',
            rect: { x, y, width, height },
            dpr: window.devicePixelRatio || 1,
            url: location.href
          }).catch(() => {});
        }, 40);
      });
    });

    window.addEventListener('keydown', onKeyDown, true);
  }

  // --- Native <select> + Custom ARIA Combobox Selection (chrome_select_option) ---
  async function performSelectOption(params = {}) {
    if (isPausedByUser) {
      throw new Error('Action blocked: User has paused Antigravity control on this tab.');
    }

    const resolved = resolveElementWithOffset(params);
    const el = resolved?.el || null;
    if (!el) {
      throw new Error(`Dropdown element not found for ${JSON.stringify({ ref: params.ref, selector: params.selector, text: params.text })}`);
    }

    const fastMode = Boolean(params.fast || document.hidden);
    el.scrollIntoView({ behavior: 'instant', block: 'center', inline: 'center' });
    if (!fastMode) await new Promise((r) => setTimeout(r, 25));
    const rect = el.getBoundingClientRect();
    const label = getAccessibleName(el) || el.tagName.toLowerCase();
    await animateAgentAction(
      el,
      Math.round(rect.left + (resolved?.offsetX || 0) + rect.width / 2),
      Math.round(rect.top + (resolved?.offsetY || 0) + rect.height / 2),
      `Select "${label.slice(0, 35)}"`,
      false,
      fastMode
    );

    const targets = Array.isArray(params.values) && params.values.length > 0
      ? params.values.map(String)
      : params.label !== undefined
        ? [String(params.label)]
        : params.value !== undefined
          ? [String(params.value)]
          : [];

    if (el.tagName.toLowerCase() === 'select') {
      const options = Array.from(el.options || []);
      const selectedValues = [];
      const selectedLabels = [];

      if (typeof params.index === 'number' && options[params.index]) {
        const opt = options[params.index];
        if (el.multiple) {
          opt.selected = true;
        } else {
          setNativeValue(el, opt.value);
        }
        selectedValues.push(opt.value);
        selectedLabels.push(opt.text.trim());
      } else {
        if (el.multiple) {
          for (const opt of options) {
            const matched = targets.some(
              (t) => opt.value === t || opt.text.trim().toLowerCase() === t.toLowerCase()
            );
            opt.selected = matched;
            if (matched) {
              selectedValues.push(opt.value);
              selectedLabels.push(opt.text.trim());
            }
          }
        } else {
          const t = targets[0] || '';
          const match =
            options.find((o) => o.value === t) ||
            options.find((o) => o.text.trim().toLowerCase() === t.toLowerCase()) ||
            options.find((o) => o.text.trim().toLowerCase().includes(t.toLowerCase()));
          if (!match) {
            throw new Error(
              `Option "${t}" not found in <select>. Available: ${options.slice(0, 12).map((o) => o.text.trim() || o.value).join(', ')}`
            );
          }
          setNativeValue(el, match.value);
          selectedValues.push(match.value);
          selectedLabels.push(match.text.trim());
        }
      }

      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return {
        selected: true,
        via: 'native-select',
        values: selectedValues,
        labels: selectedLabels
      };
    }

    // Custom ARIA [role="combobox"] / [role="listbox"] / custom trigger
    el.click();
    await new Promise((r) => setTimeout(r, 260));
    const want = (targets[0] || '').toLowerCase().trim();
    const optionEls = Array.from(
      document.querySelectorAll('[role="option"], [role="menuitem"], [role="menuitemradio"], li[data-value]')
    ).filter(isElementVisible);

    let chosen = null;
    if (typeof params.index === 'number' && optionEls[params.index]) {
      chosen = optionEls[params.index];
    } else if (want) {
      chosen =
        optionEls.find((o) => (o.innerText || o.getAttribute('aria-label') || '').trim().toLowerCase() === want) ||
        optionEls.find((o) => (o.getAttribute('data-value') || '').toLowerCase() === want) ||
        optionEls.find((o) => (o.innerText || '').trim().toLowerCase().includes(want));
    }

    if (!chosen) {
      throw new Error(
        `ARIA option "${targets[0] ?? params.index}" not found. Visible options: ${optionEls.slice(0, 12).map((o) => o.innerText.trim()).join(', ')}`
      );
    }

    const chosenLabel = (chosen.innerText || chosen.getAttribute('aria-label') || '').trim();
    chosen.scrollIntoView({ block: 'nearest' });
    chosen.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    chosen.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    chosen.click();

    return {
      selected: true,
      via: 'aria-combobox',
      values: [chosen.getAttribute('data-value') || chosenLabel],
      labels: [chosenLabel]
    };
  }

  // --- Web Storage Inspector & Manager (localStorage / sessionStorage) ---
  function performStorageOp(params = {}) {
    const action = params.action || 'get';
    const type = params.storageType || 'all';

    function readStore(store) {
      const entries = {};
      for (let i = 0; i < store.length; i++) {
        const k = store.key(i);
        if (k === null) continue;
        if (params.key && k !== params.key) continue;
        entries[k] = String(store.getItem(k) ?? '').slice(0, 2000);
      }
      return entries;
    }

    if (action === 'get') {
      const out = { origin: location.origin };
      if (type === 'localStorage' || type === 'all') {
        out.localStorage = readStore(window.localStorage);
      }
      if (type === 'sessionStorage' || type === 'all') {
        out.sessionStorage = readStore(window.sessionStorage);
      }
      return out;
    }

    const targetStore = type === 'sessionStorage' ? window.sessionStorage : window.localStorage;
    if (action === 'set') {
      if (!params.key) throw new Error('Parameter "key" is required for storage set.');
      targetStore.setItem(String(params.key), String(params.value ?? ''));
      return { set: true, storageType: type, key: params.key };
    }
    if (action === 'delete') {
      if (!params.key) throw new Error('Parameter "key" is required for storage delete.');
      targetStore.removeItem(String(params.key));
      return { deleted: true, storageType: type, key: params.key };
    }
    if (action === 'clear') {
      const prevCount = targetStore.length;
      targetStore.clear();
      return { cleared: true, storageType: type, removedCount: prevCount };
    }
    throw new Error(`Unsupported storage action: ${action}`);
  }

  // --- Live Core Web Vitals + WCAG 2.2 AA Accessibility + SEO Audit (chrome_audit_page) ---
  async function performAuditPage(params = {}) {
    const categories = new Set(params.categories || ['performance', 'accessibility', 'seo']);
    const report = { url: location.href, title: document.title, timestamp: new Date().toISOString() };

    if (categories.has('performance')) {
      const nav = performance.getEntriesByType('navigation')[0] || {};
      const paints = performance.getEntriesByType('paint') || [];
      const fcpEntry = paints.find((p) => p.name === 'first-contentful-paint');

      // Read buffered LCP and CLS entries via PerformanceObserver
      const { lcpMs, lcpElement, clsScore } = await new Promise((resolve) => {
        let latestLcp = null;
        let lcpTag = null;
        let cls = 0;
        try {
          const lcpObs = new PerformanceObserver((list) => {
            const entries = list.getEntries();
            if (entries.length) {
              const last = entries[entries.length - 1];
              latestLcp = Math.round(last.startTime);
              if (last.element) lcpTag = buildSelectorPath(last.element);
            }
          });
          lcpObs.observe({ type: 'largest-contentful-paint', buffered: true });

          const clsObs = new PerformanceObserver((list) => {
            for (const entry of list.getEntries()) {
              if (!entry.hadRecentInput) cls += entry.value || 0;
            }
          });
          clsObs.observe({ type: 'layout-shift', buffered: true });

          setTimeout(() => {
            try { lcpObs.disconnect(); } catch (_e) {}
            try { clsObs.disconnect(); } catch (_e) {}
            resolve({ lcpMs: latestLcp, lcpElement: lcpTag, clsScore: Math.round(cls * 1000) / 1000 });
          }, 80);
        } catch (_e) {
          resolve({ lcpMs: null, lcpElement: null, clsScore: 0 });
        }
      });

      const ttfbMs = nav.responseStart ? Math.round(nav.responseStart - nav.requestStart) : null;
      const domContentLoadedMs = nav.domContentLoadedEventEnd ? Math.round(nav.domContentLoadedEventEnd) : null;
      const loadMs = nav.loadEventEnd ? Math.round(nav.loadEventEnd) : null;
      const domNodeCount = document.getElementsByTagName('*').length;

      const perfIssues = [];
      let perfScore = 100;

      // Check render-blocking scripts in <head>
      const blockingHeadScripts = Array.from(document.head?.querySelectorAll('script[src]') || []).filter(
        (s) => !s.defer && !s.async && s.type !== 'module'
      );
      if (blockingHeadScripts.length > 0) {
        perfScore -= Math.min(15, blockingHeadScripts.length * 5);
        perfIssues.push(`${blockingHeadScripts.length} render-blocking <script> tag(s) in <head> without defer/async/module.`);
      }

      // Check above-the-fold lazy-loaded images (LCP anti-pattern)
      const vh = window.innerHeight;
      const aboveFoldLazyImgs = Array.from(document.querySelectorAll('img[loading="lazy"]')).filter((img) => {
        const r = img.getBoundingClientRect();
        return r.width > 80 && r.height > 80 && r.top >= 0 && r.top < vh;
      });
      if (aboveFoldLazyImgs.length > 0) {
        perfScore -= 12;
        perfIssues.push(`${aboveFoldLazyImgs.length} above-the-fold image(s) use loading="lazy", delaying LCP. Use fetchpriority="high" instead.`);
      }

      // Check images missing explicit width/height (CLS risk)
      const unsizedImgs = Array.from(document.querySelectorAll('img')).filter(
        (img) => isElementVisible(img) && !img.getAttribute('width') && !img.getAttribute('height') && !img.style.aspectRatio
      );
      if (unsizedImgs.length > 0) {
        perfScore -= Math.min(10, unsizedImgs.length * 2);
        perfIssues.push(`${unsizedImgs.length} visible <img> element(s) lack explicit width/height attributes (CLS layout shift risk).`);
      }

      if (lcpMs && lcpMs > 2500) {
        perfScore -= lcpMs > 4000 ? 25 : 12;
        perfIssues.push(`LCP is ${lcpMs}ms (target <= 2500ms).`);
      }
      if (clsScore > 0.1) {
        perfScore -= clsScore > 0.25 ? 20 : 10;
        perfIssues.push(`CLS is ${clsScore} (target <= 0.1).`);
      }
      if (domNodeCount > 1500) {
        perfScore -= 8;
        perfIssues.push(`Large DOM size: ${domNodeCount} elements (consider content-visibility: auto for off-screen sections).`);
      }

      report.performance = {
        score: Math.max(0, perfScore),
        metrics: {
          ttfbMs,
          fcpMs: fcpEntry ? Math.round(fcpEntry.startTime) : null,
          lcpMs,
          lcpElement,
          cls: clsScore,
          domContentLoadedMs,
          loadMs,
          domNodeCount,
          resourceCount: performance.getEntriesByType('resource').length
        },
        issues: perfIssues
      };
    }

    if (categories.has('accessibility')) {
      const a11yIssues = [];
      let a11yScore = 100;

      if (!document.documentElement.getAttribute('lang')) {
        a11yScore -= 8;
        a11yIssues.push('<html> element is missing a valid [lang] attribute.');
      }

      const unlabeledControls = [];
      const smallTapTargets = [];
      const lowContrastItems = [];

      const interactiveEls = Array.from(
        document.querySelectorAll('button, a[href], input:not([type="hidden"]), select, textarea, [role="button"]')
      ).filter(isElementVisible);

      for (const el of interactiveEls.slice(0, 150)) {
        const name = getAccessibleName(el);
        if (!name) {
          unlabeledControls.push(buildSelectorPath(el));
        }
        const r = el.getBoundingClientRect();
        if (r.width < 24 || r.height < 24) {
          smallTapTargets.push(`${buildSelectorPath(el)} (${Math.round(r.width)}x${Math.round(r.height)}px)`);
        }
      }

      const textEls = Array.from(document.querySelectorAll('p, span, a, button, label, li, h1, h2, h3, h4')).filter(
        (el) => isElementVisible(el) && (el.innerText || '').trim().length > 0
      );
      for (const el of textEls.slice(0, 100)) {
        const ratio = computeElementContrastRatio(el);
        if (ratio !== null) {
          const fs = parseFloat(window.getComputedStyle(el).fontSize) || 14;
          const minRatio = fs >= 18.66 ? 3.0 : 4.5;
          if (ratio < minRatio) {
            lowContrastItems.push({
              selector: buildSelectorPath(el),
              contrastRatio: ratio,
              required: minRatio,
              sample: (el.innerText || '').trim().slice(0, 40)
            });
          }
        }
      }

      const missingAltImgs = Array.from(document.querySelectorAll('img')).filter(
        (img) => isElementVisible(img) && !img.hasAttribute('alt')
      );

      // Heading hierarchy check
      const headings = Array.from(document.querySelectorAll('h1, h2, h3, h4, h5, h6'))
        .filter(isElementVisible)
        .map((h) => Number(h.tagName[1]));
      let headingSkipped = false;
      for (let i = 1; i < headings.length; i++) {
        if (headings[i] > headings[i - 1] + 1) {
          headingSkipped = true;
          break;
        }
      }

      if (unlabeledControls.length > 0) {
        a11yScore -= Math.min(25, unlabeledControls.length * 5);
        a11yIssues.push(`${unlabeledControls.length} interactive control(s) lack an accessible name: ${unlabeledControls.slice(0, 5).join(', ')}`);
      }
      if (missingAltImgs.length > 0) {
        a11yScore -= Math.min(15, missingAltImgs.length * 4);
        a11yIssues.push(`${missingAltImgs.length} <img> element(s) are missing an [alt] attribute.`);
      }
      if (lowContrastItems.length > 0) {
        a11yScore -= Math.min(20, lowContrastItems.length * 3);
        a11yIssues.push(`${lowContrastItems.length} text element(s) fail WCAG 2.2 AA contrast ratio.`);
      }
      if (smallTapTargets.length > 0) {
        a11yScore -= Math.min(10, smallTapTargets.length * 2);
        a11yIssues.push(`${smallTapTargets.length} interactive target(s) are smaller than WCAG 2.2's 24x24px minimum.`);
      }
      if (headingSkipped) {
        a11yScore -= 6;
        a11yIssues.push(`Skipped heading hierarchy levels detected (${headings.map((n) => 'h' + n).join(' -> ')}).`);
      }

      report.accessibility = {
        score: Math.max(0, a11yScore),
        unlabeledCount: unlabeledControls.length,
        lowContrastCount: lowContrastItems.length,
        lowContrastSamples: lowContrastItems.slice(0, 6),
        smallTapTargetCount: smallTapTargets.length,
        missingAltCount: missingAltImgs.length,
        issues: a11yIssues
      };
    }

    if (categories.has('seo')) {
      let seoScore = 100;
      const seoIssues = [];
      const title = document.title.trim();
      const metaDesc = document.querySelector('meta[name="description"]')?.getAttribute('content')?.trim() || '';
      const canonical = document.querySelector('link[rel="canonical"]')?.getAttribute('href') || null;
      const ogTitle = document.querySelector('meta[property="og:title"]')?.getAttribute('content') || null;
      const ogImage = document.querySelector('meta[property="og:image"]')?.getAttribute('content') || null;
      const h1Count = document.querySelectorAll('h1').length;
      const jsonLdCount = document.querySelectorAll('script[type="application/ld+json"]').length;

      if (!title) {
        seoScore -= 20;
        seoIssues.push('Missing <title> tag.');
      }
      if (!metaDesc) {
        seoScore -= 15;
        seoIssues.push('Missing <meta name="description">.');
      }
      if (h1Count === 0) {
        seoScore -= 12;
        seoIssues.push('Page has no <h1> heading.');
      } else if (h1Count > 1) {
        seoScore -= 5;
        seoIssues.push(`Page has ${h1Count} <h1> headings (prefer a single primary <h1>).`);
      }
      if (!canonical) {
        seoScore -= 8;
        seoIssues.push('Missing <link rel="canonical">.');
      }

      report.seo = {
        score: Math.max(0, seoScore),
        metadata: {
          title,
          titleLength: title.length,
          description: metaDesc.slice(0, 300),
          descriptionLength: metaDesc.length,
          canonical,
          ogTitle,
          ogImage,
          h1Count,
          jsonLdSchemaCount: jsonLdCount
        },
        issues: seoIssues
      };
    }

    return report;
  }

  // --- Deterministic Zero-Token Structured Scraper (chrome_extract_data) ---
  function performExtractData(params = {}) {
    const mode = params.mode || 'auto';
    const limit = Math.min(Number(params.limit) || 100, 500);
    const scopeRoot = params.selector ? document.querySelector(params.selector) || document : document;
    const out = { url: location.href, title: document.title };

    if (mode === 'auto' || mode === 'tables') {
      const tables = Array.from(scopeRoot.querySelectorAll('table')).slice(0, 15).map((tbl, idx) => {
        const trs = Array.from(tbl.querySelectorAll('tr')).slice(0, limit + 1);
        const rawRows = trs.map((tr) =>
          Array.from(tr.querySelectorAll('th, td')).map((c) => (c.innerText || '').replace(/\s+/g, ' ').trim())
        ).filter((r) => r.length > 0);
        const headers = rawRows[0] || [];
        const dataRows = rawRows.slice(1);
        const objects = dataRows.map((row) => {
          const obj = {};
          headers.forEach((h, i) => {
            obj[h || `col_${i + 1}`] = row[i] ?? '';
          });
          return obj;
        });
        return { index: idx, rowCount: dataRows.length, headers, objects };
      });
      out.tables = tables;
    }

    if (mode === 'auto' || mode === 'lists') {
      const lists = Array.from(scopeRoot.querySelectorAll('ul, ol'))
        .filter((l) => isElementVisible(l) && l.children.length >= 2)
        .slice(0, 12)
        .map((l) => ({
          selector: buildSelectorPath(l),
          items: Array.from(l.children)
            .slice(0, limit)
            .map((li) => (li.innerText || '').replace(/\s+/g, ' ').trim())
            .filter(Boolean)
        }))
        .filter((l) => l.items.length >= 2);
      out.lists = lists;
    }

    if (mode === 'auto' || mode === 'links') {
      out.links = Array.from(scopeRoot.querySelectorAll('a[href]'))
        .filter(isElementVisible)
        .slice(0, limit)
        .map((a) => ({
          text: (a.innerText || a.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim().slice(0, 140),
          href: a.href
        }));
    }

    if (mode === 'auto' || mode === 'metadata') {
      const meta = {};
      document.querySelectorAll('meta[name], meta[property]').forEach((m) => {
        const k = m.getAttribute('name') || m.getAttribute('property');
        const v = m.getAttribute('content');
        if (k && v) meta[k] = v.slice(0, 400);
      });
      out.metadata = meta;
    }

    if (mode === 'auto' || mode === 'schema') {
      const schemas = [];
      document.querySelectorAll('script[type="application/ld+json"]').forEach((s) => {
        try {
          schemas.push(JSON.parse(s.textContent || 'null'));
        } catch (_e) {}
      });
      out.schemas = schemas;
    }

    return out;
  }

  // --- Page Monitor Snapshot (chrome_watch_page) ---
  function performWatchSnapshot(params = {}) {
    const targetEl =
      (params.ref || params.selector ? resolveElement({ ref: params.ref, selector: params.selector }) : null) ||
      document.querySelector('main, article, [role="main"]') ||
      document.body;
    const text = (targetEl?.innerText || '')
      .split('\n')
      .map((l) => l.replace(/\s+/g, ' ').trim())
      .filter(Boolean)
      .slice(0, 400)
      .join('\n');
    return {
      url: location.href,
      title: document.title,
      selector: params.selector || (targetEl && targetEl !== document.body ? buildSelectorPath(targetEl) : 'body'),
      text,
      lineCount: text ? text.split('\n').length : 0,
      timestamp: new Date().toISOString()
    };
  }

  // --- Human Workflow Macro Recorder (chrome_macro_recorder) ---
  let macroRecordingActive = false;
  let macroListenersAttached = false;

  function isSensitiveField(el) {
    if (!el || el.nodeType !== 1) return false;
    const type = (el.type || '').toLowerCase();
    if (type === 'password') return true;
    const auto = (el.getAttribute('autocomplete') || '').toLowerCase();
    if (auto.includes('password') || auto.includes('cc-') || auto === 'one-time-code') return true;
    return false;
  }

  function emitMacroStep(step) {
    if (!macroRecordingActive) return;
    chrome.runtime.sendMessage({
      type: 'MACRO_STEP_RECORDED',
      step: {
        ...step,
        url: location.href,
        timestamp: Date.now()
      }
    }).catch(() => {});
  }

  function ensureMacroListeners() {
    if (macroListenersAttached) return;
    macroListenersAttached = true;

    document.addEventListener(
      'click',
      (e) => {
        if (!macroRecordingActive || !e.isTrusted) return;
        const el = e.target?.closest?.('button, a, input, select, textarea, [role="button"], [role="option"], [role="tab"]') || e.target;
        if (!el || el.closest?.('#agy-chrome-hud-root')) return;
        if (isSensitiveField(el)) return;
        if (['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName) && !['checkbox', 'radio', 'submit', 'button'].includes(el.type)) {
          return; // Handled on change to avoid noisy focus clicks
        }
        emitMacroStep({
          kind: 'click',
          selector: buildSelectorPath(el),
          playwrightLocator: buildPlaywrightLocator(el),
          label: getAccessibleName(el).slice(0, 80)
        });
      },
      true
    );

    document.addEventListener(
      'change',
      (e) => {
        if (!macroRecordingActive || !e.isTrusted) return;
        const el = e.target;
        if (!el || el.closest?.('#agy-chrome-hud-root') || isSensitiveField(el)) return;
        const tag = el.tagName.toLowerCase();
        if (tag === 'select') {
          emitMacroStep({
            kind: 'select',
            selector: buildSelectorPath(el),
            playwrightLocator: buildPlaywrightLocator(el),
            value: el.value,
            label: getAccessibleName(el).slice(0, 80)
          });
        } else if (el.type === 'checkbox' || el.type === 'radio') {
          emitMacroStep({
            kind: 'check',
            selector: buildSelectorPath(el),
            playwrightLocator: buildPlaywrightLocator(el),
            checked: Boolean(el.checked),
            label: getAccessibleName(el).slice(0, 80)
          });
        } else if (typeof el.value === 'string') {
          emitMacroStep({
            kind: 'fill',
            selector: buildSelectorPath(el),
            playwrightLocator: buildPlaywrightLocator(el),
            value: el.value.slice(0, 500),
            label: getAccessibleName(el).slice(0, 80)
          });
        }
      },
      true
    );

    document.addEventListener(
      'keydown',
      (e) => {
        if (!macroRecordingActive || !e.isTrusted) return;
        if (e.key === 'Enter' && e.target && !isSensitiveField(e.target) && e.target.tagName !== 'TEXTAREA') {
          emitMacroStep({
            kind: 'press',
            key: 'Enter',
            selector: buildSelectorPath(e.target),
            playwrightLocator: buildPlaywrightLocator(e.target)
          });
        }
      },
      true
    );
  }

  function setMacroRecordingState(active) {
    macroRecordingActive = Boolean(active);
    if (macroRecordingActive) {
      ensureMacroListeners();
      showHudStatus('Recording macro steps...', 4500);
    } else {
      showToast('Macro recording stopped');
    }
    return { macroRecording: macroRecordingActive };
  }

  // --- v2.2.0: FNV-1a Hash, Single-Pass Deep Read + Delta Diffing, Downloadable Asset Scanner, DOM Batch & In-Page Blob Fetcher ---
  let lastDeepState = null;

  function fnv1aHash(str) {
    let h = 0x811c9dc5;
    const s = String(str || '');
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(16).padStart(8, '0');
  }

  function scanDownloadableAssets(limit = 60) {
    const FILE_EXT_RE = /\.(pdf|csv|tsv|xlsx?|docx?|pptx?|zip|tar|gz|tgz|7z|rar|json|jsonl|xml|txt|md|png|jpe?g|webp|gif|svg|mp4|webm|mp3|wav|m4a|exe|msi|dmg|pkg|deb|apk)(\?|#|$)/i;
    const seen = new Set();
    const assets = [];

    function pushAsset(url, kind, label, suggestedName, ref = null) {
      if (!url || seen.has(url) || assets.length >= limit) return;
      if (/^javascript:|^mailto:|^tel:|^#/i.test(url)) return;
      seen.add(url);
      assets.push({
        url,
        kind,
        label: String(label || '').replace(/\s+/g, ' ').trim().slice(0, 120),
        suggestedName: suggestedName || null,
        ref
      });
    }

    document.querySelectorAll('a[href]').forEach((a) => {
      if (assets.length >= limit) return;
      const href = a.href || '';
      const hasDownloadAttr = a.hasAttribute('download');
      const dlAttr = a.getAttribute('download') || null;
      if (hasDownloadAttr || FILE_EXT_RE.test(href) || /^blob:|^data:/i.test(href)) {
        pushAsset(
          href,
          hasDownloadAttr ? 'download_link' : 'file_link',
          a.innerText || a.getAttribute('aria-label') || a.title || dlAttr || href,
          dlAttr || null,
          a.getAttribute('data-agy-ref') || null
        );
      }
    });

    document.querySelectorAll('video[src], audio[src], source[src], embed[src], object[data]').forEach((el) => {
      if (assets.length >= limit) return;
      const src = el.src || el.getAttribute('data') || '';
      if (src) pushAsset(src, el.tagName.toLowerCase(), el.title || el.getAttribute('aria-label') || el.tagName.toLowerCase(), null);
    });

    document.querySelectorAll('img[src]').forEach((img) => {
      if (assets.length >= limit) return;
      const r = img.getBoundingClientRect();
      if (r.width >= 160 && r.height >= 120 && img.src && !img.src.startsWith('data:image/svg')) {
        pushAsset(img.src, 'image', img.alt || 'image', null);
      }
    });

    return assets;
  }

  function scanFormsSummary(limit = 15) {
    return Array.from(document.querySelectorAll('form'))
      .slice(0, limit)
      .map((form, idx) => {
        const inputs = Array.from(form.querySelectorAll('input, select, textarea'))
          .filter((el) => el.type !== 'hidden')
          .slice(0, 30)
          .map((el) => ({
            ref: el.getAttribute('data-agy-ref') || null,
            tag: el.tagName.toLowerCase(),
            type: el.type || null,
            name: el.name || el.id || null,
            label: getAccessibleName(el).slice(0, 80),
            required: Boolean(el.required)
          }));
        return {
          index: idx,
          id: form.id || null,
          action: form.action || null,
          method: (form.method || 'GET').toUpperCase(),
          fieldCount: inputs.length,
          fields: inputs
        };
      });
  }

  function performDeepRead(params = {}) {
    const started = performance.now();
    const snapshot = buildPageSnapshot({
      viewportOnly: Boolean(params.viewportOnly),
      includeText: true,
      maxElements: Number(params.maxElements) || 220,
      maxTextLength: Number(params.maxTextLength) || 18000,
      maxDepth: Number(params.maxDepth) || 5
    });

    const includeMarkdown = params.includeMarkdown !== false;
    const includeStructured = params.includeStructured !== false;
    const includeAssets = params.includeAssets !== false;

    const markdownObj = includeMarkdown
      ? extractStructuredMarkdown({ maxLength: Number(params.maxTextLength) || 18000 })
      : null;
    const structured = includeStructured ? performExtractData({ mode: 'auto', limit: 60 }) : null;
    const forms = includeStructured ? scanFormsSummary(12) : [];
    const downloadableAssets = includeAssets ? scanDownloadableAssets(60) : [];

    const nav = performance.getEntriesByType('navigation')[0] || {};
    const perfSummary = {
      ttfbMs: nav.responseStart ? Math.round(nav.responseStart - nav.requestStart) : null,
      domContentLoadedMs: nav.domContentLoadedEventEnd ? Math.round(nav.domContentLoadedEventEnd) : null,
      loadMs: nav.loadEventEnd ? Math.round(nav.loadEventEnd) : null,
      resourceCount: performance.getEntriesByType('resource').length
    };

    const elementSigMap = new Map();
    for (const el of snapshot.elements || []) {
      const sig = `${el.role}|${el.name}|${el.value || ''}|${el.checked ?? ''}|${el.disabled ? 1 : 0}|${el.href || ''}`;
      elementSigMap.set(el.ref, { sig, el });
    }
    const textLines = (markdownObj?.markdown || snapshot.visibleText || '')
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    const stateHash = fnv1aHash(`${location.href}\n${snapshot.formattedTree}\n${textLines.join('\n')}`);

    const prev = lastDeepState;
    const canDelta =
      Boolean(params.deltaOnly) &&
      prev &&
      prev.url === location.href &&
      (!params.sinceHash || params.sinceHash === prev.stateHash);

    const nextState = {
      url: location.href,
      stateHash,
      elementSigMap,
      textLineSet: new Set(textLines),
      timestamp: Date.now()
    };
    lastDeepState = nextState;

    const contentErrors = consoleLogs.filter((l) => ['error', 'exception'].includes(l.level)).slice(-30);

    if (canDelta) {
      if (stateHash === prev.stateHash) {
        return {
          delta: true,
          unchanged: true,
          stateHash,
          previousHash: prev.stateHash,
          url: location.href,
          title: document.title,
          elementCount: snapshot.elementCount,
          safetyGates: snapshot.safetyGates,
          contentConsoleErrors: contentErrors,
          readDurationMs: Math.round(performance.now() - started)
        };
      }

      const addedElements = [];
      const changedElements = [];
      const removedRefs = [];

      for (const [ref, cur] of elementSigMap.entries()) {
        const old = prev.elementSigMap.get(ref);
        if (!old) addedElements.push(cur.el);
        else if (old.sig !== cur.sig) changedElements.push(cur.el);
      }
      for (const ref of prev.elementSigMap.keys()) {
        if (!elementSigMap.has(ref)) removedRefs.push(ref);
      }

      const addedTextLines = textLines.filter((l) => !prev.textLineSet.has(l)).slice(0, 80);
      const removedTextLines = Array.from(prev.textLineSet).filter((l) => !nextState.textLineSet.has(l)).slice(0, 80);

      return {
        delta: true,
        unchanged: false,
        stateHash,
        previousHash: prev.stateHash,
        url: location.href,
        title: document.title,
        elementCount: snapshot.elementCount,
        addedElements: addedElements.slice(0, 60),
        changedElements: changedElements.slice(0, 60),
        removedRefs: removedRefs.slice(0, 60),
        addedTextLines,
        removedTextLines,
        downloadableAssets,
        safetyGates: snapshot.safetyGates,
        contentConsoleErrors: contentErrors,
        readDurationMs: Math.round(performance.now() - started)
      };
    }

    return {
      delta: false,
      unchanged: false,
      stateHash,
      url: snapshot.url,
      title: snapshot.title,
      isPdfEmbed: snapshot.isPdfEmbed,
      crossOriginFrameCount: snapshot.crossOriginFrameCount,
      crossOriginFrames: snapshot.crossOriginFrames,
      pausedByUser: snapshot.pausedByUser,
      viewport: snapshot.viewport,
      safetyGates: snapshot.safetyGates,
      elementCount: snapshot.elementCount,
      formattedTree: snapshot.formattedTree,
      markdown: markdownObj?.markdown || snapshot.visibleText || '',
      structured: structured
        ? {
            tables: structured.tables || [],
            lists: structured.lists || [],
            metadata: structured.metadata || {},
            schemas: structured.schemas || [],
            forms
          }
        : undefined,
      downloadableAssets,
      performance: perfSummary,
      contentConsoleErrors: contentErrors,
      readDurationMs: Math.round(performance.now() - started)
    };
  }

  async function performDomBatch(params = {}) {
    if (isPausedByUser) {
      throw new Error('Action blocked: User has paused Antigravity control on this tab.');
    }
    const steps = Array.isArray(params.steps) ? params.steps : [];
    const stopOnError = params.stopOnError !== false;
    const fastMode = params.fast !== false;
    const results = [];
    let stoppedEarly = false;
    const tStart = performance.now();

    for (let i = 0; i < steps.length; i++) {
      const step = steps[i] || {};
      const action = step.action;
      const p = { ...(step.params || {}), fast: step.params?.fast ?? fastMode };
      const s0 = performance.now();
      try {
        let res;
        switch (action) {
          case 'click':
            res = await performClick(p);
            break;
          case 'type':
            res = await performType(p);
            break;
          case 'select_option':
            res = await performSelectOption(p);
            break;
          case 'fill_form':
            res = await performFillForm(p);
            break;
          case 'press_key':
            res = await performPressKey(p);
            break;
          case 'scroll':
            res = await performScroll(p);
            break;
          case 'hover':
            res = await performHover(p);
            break;
          case 'wait_for':
            res = await performWaitFor(p);
            break;
          case 'extract_data':
            res = performExtractData(p);
            break;
          case 'read_page':
            res = buildPageSnapshot(p);
            break;
          case 'deep_read':
            res = performDeepRead(p);
            break;
          case 'get_page_text':
            res = extractStructuredMarkdown(p);
            break;
          case 'sleep': {
            const ms = Math.max(0, Math.min(15000, Number(p.ms ?? p.durationMs) || 200));
            await new Promise((r) => setTimeout(r, ms));
            res = { sleptMs: ms };
            break;
          }
          default:
            throw new Error(`Unsupported DOM batch step action: ${action}`);
        }
        results.push({ stepIndex: i, action, ok: true, durationMs: Math.round(performance.now() - s0), result: res });
      } catch (err) {
        results.push({ stepIndex: i, action, ok: false, durationMs: Math.round(performance.now() - s0), error: err?.message || String(err) });
        if (stopOnError) {
          stoppedEarly = true;
          break;
        }
      }
    }

    return {
      executedSteps: results.length,
      stoppedEarly,
      durationMs: Math.round(performance.now() - tStart),
      results
    };
  }

  function bytesToBase64Chunked(bytes) {
    const CHUNK = 0x8000;
    const parts = [];
    for (let i = 0; i < bytes.length; i += CHUNK) {
      parts.push(String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK)));
    }
    return btoa(parts.join(''));
  }

  async function fetchResourceInPage(params = {}) {
    const url = String(params.url || '').trim();
    if (!url) throw new Error('Parameter "url" is required.');

    if (url.startsWith('data:')) {
      const m = url.match(/^data:([^;,]+)?(?:;charset=[^;,]+)?(;base64)?,([\s\S]*)$/i);
      if (!m) throw new Error('Malformed data: URL.');
      const mimeType = m[1] || 'application/octet-stream';
      const isB64 = Boolean(m[2]);
      const payload = m[3] || '';
      const base64 = isB64 ? payload : bytesToBase64Chunked(new TextEncoder().encode(decodeURIComponent(payload)));
      return {
        base64,
        mimeType,
        filename: params.filename || null,
        sizeBytes: Math.floor((base64.length * 3) / 4)
      };
    }

    const resp = await fetch(url, { credentials: 'include' });
    if (!resp.ok) {
      throw new Error(`In-page fetch failed with HTTP ${resp.status} ${resp.statusText}`);
    }
    const buf = await resp.arrayBuffer();
    if (buf.byteLength > 36 * 1024 * 1024) {
      throw new Error(`Resource exceeds 36 MB in-page transfer cap (${buf.byteLength} bytes); use strategy="node_stream".`);
    }
    const mimeType = (resp.headers.get('content-type') || '').split(';')[0].trim().toLowerCase() || 'application/octet-stream';
    const cd = resp.headers.get('content-disposition') || '';
    let filename = params.filename || null;
    if (!filename && cd) {
      const m = cd.match(/filename\*?=(?:UTF-8''|utf-8'')?["']?([^"';\r\n]+)["']?/i);
      if (m) {
        try {
          filename = decodeURIComponent(m[1]);
        } catch (_e) {
          filename = m[1];
        }
      }
    }
    const bytes = new Uint8Array(buf);
    return {
      base64: bytesToBase64Chunked(bytes),
      mimeType,
      filename,
      sizeBytes: bytes.byteLength
    };
  }

  // --- Message Listener ---
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    (async () => {
      try {
        switch (message?.type) {
          case 'PING_CONTENT':
            sendResponse({ ok: true, url: location.href, title: document.title, paused: isPausedByUser });
            break;

          case 'READ_PAGE':
            showHudStatus('Reading page...', 2000);
            sendResponse({ ok: true, result: buildPageSnapshot(message.params || {}) });
            break;

          case 'DEEP_READ':
            sendResponse({ ok: true, result: performDeepRead(message.params || {}) });
            break;

          case 'RUN_DOM_BATCH':
            sendResponse({ ok: true, result: await performDomBatch(message.params || {}) });
            break;

          case 'FETCH_RESOURCE_IN_PAGE':
            sendResponse({ ok: true, result: await fetchResourceInPage(message.params || {}) });
            break;

          case 'INSPECT_DOWNLOAD_LINK': {
            const el = resolveElement(message.params || {});
            const a = el?.tagName === 'A' ? el : el?.closest?.('a[href]');
            sendResponse({
              ok: true,
              result: a
                ? {
                    href: a.href || '',
                    hasDownloadAttr: a.hasAttribute('download'),
                    suggestedFilename: a.getAttribute('download') || null,
                    name: getAccessibleName(a)
                  }
                : null
            });
            break;
          }

          case 'GET_PAGE_TEXT':
            sendResponse({ ok: true, result: extractStructuredMarkdown(message.params || {}) });
            break;

          case 'FIND_ELEMENTS':
            sendResponse({ ok: true, result: findElementsByQuery(message.params || {}) });
            break;

          case 'INSPECT_ELEMENT':
            sendResponse({ ok: true, result: inspectElementDeep(message.params || {}) });
            break;

          case 'CLICK':
            sendResponse({ ok: true, result: await performClick(message.params || {}) });
            break;

          case 'HOVER':
            sendResponse({ ok: true, result: await performHover(message.params || {}) });
            break;

          case 'HIGHLIGHT':
            sendResponse({ ok: true, result: await performHighlight(message.params || {}) });
            break;

          case 'DRAG_AND_DROP':
            sendResponse({ ok: true, result: await performDragAndDrop(message.params || {}) });
            break;

          case 'UPLOAD_FILE_DATA':
            sendResponse({ ok: true, result: await performUploadFileData(message.params || {}) });
            break;

          case 'TYPE':
            sendResponse({ ok: true, result: await performType(message.params || {}) });
            break;

          case 'SELECT_OPTION':
            sendResponse({ ok: true, result: await performSelectOption(message.params || {}) });
            break;

          case 'STORAGE_OP':
            sendResponse({ ok: true, result: performStorageOp(message.params || {}) });
            break;

          case 'AUDIT_PAGE':
            showHudStatus('Auditing Core Web Vitals & Accessibility...', 2500);
            sendResponse({ ok: true, result: await performAuditPage(message.params || {}) });
            break;

          case 'EXTRACT_DATA':
            sendResponse({ ok: true, result: performExtractData(message.params || {}) });
            break;

          case 'WATCH_SNAPSHOT':
            sendResponse({ ok: true, result: performWatchSnapshot(message.params || {}) });
            break;

          case 'SET_MACRO_RECORDING':
            sendResponse({ ok: true, result: setMacroRecordingState(message.params?.active) });
            break;

          case 'FILL_FORM':
            sendResponse({ ok: true, result: await performFillForm(message.params || {}) });
            break;

          case 'PRESS_KEY':
            sendResponse({ ok: true, result: await performPressKey(message.params || {}) });
            break;

          case 'SCROLL':
            sendResponse({ ok: true, result: await performScroll(message.params || {}) });
            break;

          case 'WAIT_FOR':
            sendResponse({ ok: true, result: await performWaitFor(message.params || {}) });
            break;

          case 'SHOW_SOM_OVERLAY':
            sendResponse({ ok: true, result: await renderSomOverlay() });
            break;

          case 'HIDE_SOM_OVERLAY':
            sendResponse({ ok: true, result: clearSomOverlay() });
            break;

          case 'GET_CONSOLE_LOGS': {
            if (message.params?.clear) consoleLogs.length = 0;
            sendResponse({ ok: true, result: { logs: consoleLogs.slice(-(message.params?.limit || 100)) } });
            break;
          }

          case 'GET_NETWORK_LOGS':
            sendResponse({ ok: true, result: { requests: collectPerformanceNetworkLogs() } });
            break;

          case 'SET_PAUSE_STATE':
            isPausedByUser = Boolean(message.paused);
            updateHudPauseState();
            showHudStatus(isPausedByUser ? 'Paused' : 'Resumed', 2800);
            sendResponse({ ok: true, paused: isPausedByUser });
            break;

          case 'SHOW_TOAST':
            showToast(message.message || 'Done');
            sendResponse({ ok: true });
            break;

          case 'START_ELEMENT_PICKER':
            startInteractiveElementPicker();
            sendResponse({ ok: true });
            break;

          case 'START_REGION_SNIP':
            startSnipSelection();
            sendResponse({ ok: true });
            break;

          default:
            sendResponse({ ok: false, error: `Unknown content script action: ${message?.type}` });
        }
      } catch (err) {
        sendResponse({ ok: false, error: err?.message || String(err) });
      }
    })();
    return true;
  });
})();
