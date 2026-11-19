/**
 * Gemini Antigravity in Chrome v2.0 - Minimalist Side Panel Controller
 *
 * Features:
 * - Bidirectional streaming & real Antigravity agent response rendering (safe Markdown)
 * - Live autonomous browser tool trace accordion
 * - `/` Slash Shortcuts & `@` Multi-Tab Mention Palette
 * - Interactive Page Element Picker & Region Snip ("App-Shot") attachments
 * - Animated GIF Session Recorder with inline preview & download
 * - Autonomy Mode ('auto' | 'ask'), Per-Domain Guardrails & Scheduled Tasks
 * - IME-safe Enter-to-submit + CSS field-sizing fallback
 */

const STORAGE_CHAT_KEY = 'agy_sidepanel_chat_history';

// Elements
const statusTrigger = document.getElementById('status-trigger');
const connDot = document.getElementById('conn-dot');
const quickAuditBtn = document.getElementById('quick-audit-btn');
const gifBtn = document.getElementById('gif-btn');
const workflowsBtn = document.getElementById('workflows-btn');
const pauseBtn = document.getElementById('pause-btn');
const guideBtn = document.getElementById('guide-btn');
const settingsBtn = document.getElementById('settings-btn');
const newChatBtn = document.getElementById('new-chat-btn');
const composerShell = document.getElementById('composer-shell');
const macroRecordBtn = document.getElementById('macro-record-btn');
const macroReplayBtn = document.getElementById('macro-replay-btn');
const macroStatusBadge = document.getElementById('macro-status-badge');

const guideDrawer = document.getElementById('guide-drawer');
const closeGuideBtn = document.getElementById('close-guide-btn');

const domainApprovalBar = document.getElementById('domain-approval-bar');
const domainApprovalText = document.getElementById('domain-approval-text');
const domainAllowBtn = document.getElementById('domain-allow-btn');
const domainDismissBtn = document.getElementById('domain-dismiss-btn');

const workflowsDrawer = document.getElementById('workflows-drawer');
const closeWorkflowsBtn = document.getElementById('close-workflows-btn');
const shortcutsListEl = document.getElementById('shortcuts-list');
const addShortcutForm = document.getElementById('add-shortcut-form');
const schedulesListEl = document.getElementById('schedules-list');
const addScheduleForm = document.getElementById('add-schedule-form');

const settingsDrawer = document.getElementById('settings-drawer');
const closeSettingsBtn = document.getElementById('close-settings-btn');
const bridgeEndpointLabel = document.getElementById('bridge-endpoint-label');
const reconnectBtn = document.getElementById('reconnect-btn');
const modeAutoBtn = document.getElementById('mode-auto-btn');
const modeAskBtn = document.getElementById('mode-ask-btn');
const attachTabGroupBtn = document.getElementById('attach-tab-group-btn');
const allowDomainsInput = document.getElementById('allow-domains-input');
const blockDomainsInput = document.getElementById('block-domains-input');
const saveDomainsBtn = document.getElementById('save-domains-btn');
const clearLogsBtn = document.getElementById('clear-logs-btn');
const activityLogList = document.getElementById('activity-log-list');

const messagesContainer = document.getElementById('chat-messages');
const welcomeState = document.getElementById('welcome-state');
const paletteMenu = document.getElementById('Floating-menu');

const chatForm = document.getElementById('chat-form');
const activeTabChip = document.getElementById('active-tab-chip');
const activeTabLabel = document.getElementById('active-tab-label');
const dynamicChips = document.getElementById('dynamic-chips');
const attachmentBar = document.getElementById('attachment-bar');
const attachmentImg = document.getElementById('attachment-img');
const attachmentRemove = document.getElementById('attachment-remove');
const attachmentLabel = document.getElementById('attachment-label');

const chatInput = document.getElementById('chat-input');
const mentionTabBtn = document.getElementById('mention-tab-btn');
const pickElementBtn = document.getElementById('pick-element-btn');
const snipRegionBtn = document.getElementById('snip-region-btn');
const captureTabBtn = document.getElementById('capture-tab-btn');
const fileUploadInput = document.getElementById('file-upload-input');
const quickModeBtn = document.getElementById('quick-mode-btn');
const sendBtn = document.getElementById('send-btn');

// Runtime UI state
let currentState = null;
let allOpenTabs = [];
let activeTab = null;
let includeActivePage = true;
let mentionedTabs = []; // [{ tabId, title, url }]
let pickedElement = null;
let attachedImageDataUrl = null;
let chatHistory = [];
let pendingApprovalHostname = null;
let lastCompositionEndAt = null;
let activeTraceSteps = []; // Live RPC steps for current turn

// --- Safe Markdown Renderer (Zero eval / XSS-safe) ---
function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderSafeMarkdown(rawText) {
  const escaped = escapeHtml(rawText || '');
  const codeBlocks = [];
  const withPlaceholders = escaped.replace(/```([\w-]*)\n([\s\S]*?)```/g, (_m, _lang, code) => {
    const idx = codeBlocks.length;
    codeBlocks.push(`<pre role="region" aria-label="Code snippet" tabindex="0"><code>${code.trim()}</code></pre>`);
    return `@@CODEBLOCK_${idx}@@`;
  });

  const blocks = withPlaceholders.split(/\n{2,}/);
  const htmlParts = blocks.map((block) => {
    const trimmed = block.trim();
    if (!trimmed) return '';
    if (/^@@CODEBLOCK_\d+@@$/.test(trimmed)) return trimmed;

    if (/^#{1,3}\s+/.test(trimmed)) {
      const level = trimmed.match(/^#+/)[0].length;
      const title = formatInline(trimmed.replace(/^#{1,3}\s+/, ''));
      return `<h${level}>${title}</h${level}>`;
    }

    const lines = trimmed.split('\n');

    // GFM Table support
    if (lines.length >= 2 && lines.every((l) => l.trim().startsWith('|') && l.trim().endsWith('|'))) {
      const parseCells = (row) => row.trim().slice(1, -1).split('|').map((c) => formatInline(c.trim()));
      const headerCells = parseCells(lines[0]);
      const isSep = /^[\s|:-]+$/.test(lines[1]);
      const bodyRows = (isSep ? lines.slice(2) : lines.slice(1)).map(parseCells);
      const thead = `<thead><tr>${headerCells.map((h) => `<th>${h}</th>`).join('')}</tr></thead>`;
      const tbody = `<tbody>${bodyRows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody>`;
      return `<table>${thead}${tbody}</table>`;
    }

    if (lines.every((l) => /^[-*•]\s+/.test(l.trim()))) {
      const items = lines.map((l) => `<li>${formatInline(l.trim().replace(/^[-*•]\s+/, ''))}</li>`).join('');
      return `<ul>${items}</ul>`;
    }

    if (lines.every((l) => /^\d+\.\s+/.test(l.trim()))) {
      const items = lines.map((l) => `<li>${formatInline(l.trim().replace(/^\d+\.\s+/, ''))}</li>`).join('');
      return `<ol>${items}</ol>`;
    }

    if (lines.every((l) => /^&gt;\s?/.test(l.trim()))) {
      const quote = lines.map((l) => formatInline(l.trim().replace(/^&gt;\s?/, ''))).join('<br>');
      return `<blockquote><p>${quote}</p></blockquote>`;
    }

    return `<p>${lines.map(formatInline).join('<br>')}</p>`;
  });

  let finalHtml = htmlParts.join('');
  codeBlocks.forEach((cb, idx) => {
    finalHtml = finalHtml.replace(`@@CODEBLOCK_${idx}@@`, cb);
  });
  return finalHtml;
}

function formatInline(str) {
  return str
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
}

// Safe DOM insertion using Chrome 146+ native Sanitizer API (`setHTML`) with strict allowlist fallback
function mountSanitizedMarkdown(container, rawMarkdown) {
  const html = renderSafeMarkdown(rawMarkdown);
  const allowedElements = [
    'p', 'br', 'strong', 'em', 'code', 'pre', 'ul', 'ol', 'li',
    'h1', 'h2', 'h3', 'blockquote', 'table', 'thead', 'tbody', 'tr', 'th', 'td'
  ];
  if ('setHTML' in Element.prototype) {
    try {
      container.setHTML(html, {
        sanitizer: {
          elements: allowedElements,
          attributes: ['tabindex', 'role', 'aria-label']
        }
      });
    } catch (_e) {
      container.innerHTML = html;
    }
  } else {
    container.innerHTML = html;
  }

  // Attach accessible 1-click Copy buttons to fenced code blocks
  container.querySelectorAll('pre').forEach((pre) => {
    pre.setAttribute('tabindex', '0');
    pre.setAttribute('role', 'region');
    pre.setAttribute('aria-label', 'Code snippet');
    const copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.className = 'code-copy-btn';
    copyBtn.textContent = 'Copy';
    copyBtn.addEventListener('click', async () => {
      const codeText = pre.querySelector('code')?.textContent || '';
      await navigator.clipboard.writeText(codeText);
      copyBtn.textContent = 'Copied';
      setTimeout(() => { copyBtn.textContent = 'Copy'; }, 1200);
    });
    pre.appendChild(copyBtn);
  });
}

// --- Theme Handling ---
function applyTheme(theme) {
  const pref = theme || 'system';
  if (pref === 'dark' || pref === 'light') {
    document.documentElement.setAttribute('data-theme', pref);
  } else {
    document.documentElement.removeAttribute('data-theme');
  }
  document.querySelectorAll('.theme-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.themeVal === pref);
  });
}

// --- Composer State & Chips ---
function updateSubmitState() {
  const hasText = chatInput.value.trim().length > 0;
  const hasAttachment = Boolean(attachedImageDataUrl || pickedElement);
  sendBtn.disabled = !hasText && !hasAttachment;
}

if (!CSS.supports('field-sizing', 'content')) {
  chatInput.addEventListener('input', () => {
    chatInput.style.height = 'auto';
    chatInput.style.height = `${Math.min(chatInput.scrollHeight, 130)}px`;
  });
}

function renderDynamicChips() {
  dynamicChips.innerHTML = '';

  for (const t of mentionedTabs) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'ctx-chip active';
    chip.title = t.url || t.title;
    const host = safeHostname(t.url) || t.title.slice(0, 18);
    chip.innerHTML = `<span class="chip-text">@${escapeHtml(host)}</span><span class="chip-remove">×</span>`;
    chip.addEventListener('click', () => {
      mentionedTabs = mentionedTabs.filter((x) => x.tabId !== t.tabId);
      renderDynamicChips();
    });
    dynamicChips.appendChild(chip);
  }

  if (pickedElement) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'ctx-chip active';
    const desc = `${pickedElement.tag}${pickedElement.id ? '#' + pickedElement.id : ''}`;
    chip.title = pickedElement.selector || desc;
    chip.innerHTML = `<span class="chip-text">&lt;${escapeHtml(desc)}&gt;</span><span class="chip-remove">×</span>`;
    chip.addEventListener('click', () => {
      pickedElement = null;
      renderDynamicChips();
      updateSubmitState();
    });
    dynamicChips.appendChild(chip);
  }
}

function safeHostname(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch (_e) {
    return '';
  }
}

function setAttachment(dataUrl, label = 'Attached') {
  attachedImageDataUrl = dataUrl;
  attachmentImg.src = dataUrl;
  attachmentLabel.textContent = label;
  attachmentBar.hidden = false;
  updateSubmitState();
  chatInput.focus();
}

function clearAttachment() {
  attachedImageDataUrl = null;
  attachmentImg.src = '';
  attachmentBar.hidden = true;
  fileUploadInput.value = '';
  updateSubmitState();
}

attachmentRemove.addEventListener('click', clearAttachment);

activeTabChip.addEventListener('click', () => {
  includeActivePage = !includeActivePage;
  activeTabChip.classList.toggle('active', includeActivePage);
});

// --- Slash `/` & Tab `@` Floating Palette ---
function hidePalette() {
  paletteMenu.hidden = true;
  paletteMenu.innerHTML = '';
}

function renderSlashPalette(filterText) {
  const shortcuts = currentState?.shortcuts || [];
  const q = filterText.toLowerCase();
  const matches = shortcuts.filter(
    (s) => s.command.toLowerCase().includes(q) || (s.label || '').toLowerCase().includes(q)
  );
  if (!matches.length) {
    hidePalette();
    return;
  }

  paletteMenu.innerHTML = '';
  matches.forEach((sc, idx) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `palette-item${idx === 0 ? ' selected' : ''}`;
    btn.innerHTML = `<span class="palette-item-key">${escapeHtml(sc.command)}</span>
      <span class="palette-item-sub">${escapeHtml(sc.label || sc.prompt)}</span>`;
    btn.addEventListener('click', () => {
      chatInput.value = sc.prompt;
      hidePalette();
      updateSubmitState();
      chatInput.focus();
    });
    paletteMenu.appendChild(btn);
  });
  paletteMenu.hidden = false;
}

function renderTabMentionPalette(filterText) {
  const q = filterText.toLowerCase();
  const candidates = allOpenTabs.filter(
    (t) =>
      /^https?:/i.test(t.url) &&
      !mentionedTabs.some((m) => m.tabId === t.tabId) &&
      (t.title.toLowerCase().includes(q) || t.url.toLowerCase().includes(q))
  );
  if (!candidates.length) {
    hidePalette();
    return;
  }

  paletteMenu.innerHTML = '';
  candidates.slice(0, 8).forEach((tab, idx) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `palette-item${idx === 0 ? ' selected' : ''}`;
    const host = safeHostname(tab.url);
    btn.innerHTML = `<span class="palette-item-key">${escapeHtml(tab.title.slice(0, 28) || host)}</span>
      <span class="palette-item-sub">${escapeHtml(host)}</span>`;
    btn.addEventListener('click', () => {
      mentionedTabs.push({ tabId: tab.tabId, title: tab.title, url: tab.url });
      chatInput.value = chatInput.value.replace(/@[^\s]*$/, '');
      renderDynamicChips();
      hidePalette();
      chatInput.focus();
    });
    paletteMenu.appendChild(btn);
  });
  paletteMenu.hidden = false;
}

chatInput.addEventListener('input', () => {
  updateSubmitState();
  const val = chatInput.value;
  if (val.startsWith('/') && !val.includes(' ')) {
    renderSlashPalette(val);
    return;
  }
  const atMatch = val.match(/(?:^|\s)@([^\s]*)$/);
  if (atMatch) {
    renderTabMentionPalette(atMatch[1] || '');
    return;
  }
  hidePalette();
});

mentionTabBtn.addEventListener('click', () => {
  const needsSpace = chatInput.value.length > 0 && !chatInput.value.endsWith(' ');
  chatInput.value += `${needsSpace ? ' ' : ''}@`;
  renderTabMentionPalette('');
  chatInput.focus();
});

// --- Tool Buttons ---
pickElementBtn.addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'TRIGGER_ELEMENT_PICKER', tabId: activeTab?.tabId || null });
});

snipRegionBtn.addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'TRIGGER_REGION_SNIP', tabId: activeTab?.tabId || null });
});

captureTabBtn.addEventListener('click', async () => {
  captureTabBtn.disabled = true;
  try {
    const res = await chrome.runtime.sendMessage({
      type: 'CAPTURE_TAB_SCREENSHOT',
      tabId: activeTab?.tabId || null
    });
    if (res?.dataUrl) {
      setAttachment(res.dataUrl, 'Viewport screenshot');
    }
  } finally {
    captureTabBtn.disabled = false;
  }
});

fileUploadInput.addEventListener('change', (e) => {
  const file = e.target.files?.[0];
  if (!file || !file.type.startsWith('image/')) return;
  const reader = new FileReader();
  reader.onload = (ev) => {
    if (ev.target?.result) setAttachment(String(ev.target.result), file.name);
  };
  reader.readAsDataURL(file);
});

document.addEventListener('paste', (e) => {
  const items = e.clipboardData?.items;
  if (!items) return;
  for (const item of items) {
    if (item.type.startsWith('image/')) {
      const file = item.getAsFile();
      if (file) {
        const reader = new FileReader();
        reader.onload = (ev) => {
          if (ev.target?.result) setAttachment(String(ev.target.result), 'Pasted image');
        };
        reader.readAsDataURL(file);
        e.preventDefault();
        break;
      }
    }
  }
});

// GIF Recording Button
gifBtn.addEventListener('click', async () => {
  gifBtn.disabled = true;
  try {
    const res = await chrome.runtime.sendMessage({ type: 'TOGGLE_GIF_RECORDING' });
    if (res?.ok && res.result && res.result.recording === false && res.result.dataUrl) {
      const msgObj = {
        role: 'agent',
        text: `Recorded **${res.result.frameCount}-frame** workflow GIF (${Math.round(res.result.byteLength / 1024)} KB). Right-click the image below to save.`,
        screenshot: res.result.dataUrl,
        timestamp: Date.now()
      };
      chatHistory.push(msgObj);
      await saveHistory();
      renderAllMessages();
    }
  } finally {
    gifBtn.disabled = false;
  }
});

// --- Drawers, Inert Shell & Settings ---
function setShellInert(drawerOpen) {
  messagesContainer.inert = Boolean(drawerOpen);
  if (composerShell) composerShell.inert = Boolean(drawerOpen);
}

function toggleDrawer(targetDrawer) {
  const isHidden = targetDrawer.hidden;
  workflowsDrawer.hidden = true;
  settingsDrawer.hidden = true;
  if (guideDrawer) guideDrawer.hidden = true;
  workflowsBtn.classList.remove('active');
  settingsBtn.classList.remove('active');
  if (guideBtn) guideBtn.classList.remove('active');

  if (isHidden) {
    targetDrawer.hidden = false;
    setShellInert(true);
    if (targetDrawer === workflowsDrawer) workflowsBtn.classList.add('active');
    if (targetDrawer === settingsDrawer) settingsBtn.classList.add('active');
    if (targetDrawer === guideDrawer && guideBtn) guideBtn.classList.add('active');
  } else {
    setShellInert(false);
  }
}

if (guideBtn && guideDrawer) {
  guideBtn.addEventListener('click', () => toggleDrawer(guideDrawer));
}
if (closeGuideBtn && guideDrawer) {
  closeGuideBtn.addEventListener('click', () => {
    guideDrawer.hidden = true;
    guideBtn?.classList.remove('active');
    setShellInert(false);
  });
}

workflowsBtn.addEventListener('click', () => toggleDrawer(workflowsDrawer));
closeWorkflowsBtn.addEventListener('click', () => {
  workflowsDrawer.hidden = true;
  workflowsBtn.classList.remove('active');
  setShellInert(false);
});

settingsBtn.addEventListener('click', () => toggleDrawer(settingsDrawer));
statusTrigger.addEventListener('click', () => toggleDrawer(settingsDrawer));
closeSettingsBtn.addEventListener('click', () => {
  settingsDrawer.hidden = true;
  settingsBtn.classList.remove('active');
  setShellInert(false);
});

// Instant 100ms Core Web Vitals + WCAG 2.2 + SEO Audit
async function runInstantAudit() {
  if (quickAuditBtn) quickAuditBtn.disabled = true;
  try {
    const res = await chrome.runtime.sendMessage({
      type: 'RUN_QUICK_AUDIT',
      tabId: activeTab?.tabId || null
    });
    if (!res?.ok || !res.result) {
      chatHistory.push({
        role: 'agent',
        text: `Audit unavailable on this tab: ${res?.error || 'Switch to an http/https webpage.'}`,
        error: true,
        timestamp: Date.now()
      });
    } else {
      const r = res.result;
      const p = r.performance || {};
      const a = r.accessibility || {};
      const s = r.seo || {};
      const allIssues = [
        ...(p.issues || []).map((i) => `- **Perf**: ${i}`),
        ...(a.issues || []).map((i) => `- **A11y**: ${i}`),
        ...(s.issues || []).map((i) => `- **SEO**: ${i}`)
      ];
      const md = [
        `### Live Page Audit — ${r.title || r.url}`,
        '',
        `| Category | Score | Key Telemetry |`,
        `| --- | --- | --- |`,
        `| **Performance** | **${p.score ?? '-'}/100** | TTFB ${p.metrics?.ttfbMs ?? '-'}ms · FCP ${p.metrics?.fcpMs ?? '-'}ms · LCP ${p.metrics?.lcpMs ?? '-'}ms · CLS ${p.metrics?.cls ?? 0} |`,
        `| **Accessibility** | **${a.score ?? '-'}/100** | Contrast fails: ${a.lowContrastCount ?? 0} · Unlabeled: ${a.unlabeledCount ?? 0} · Small targets: ${a.smallTapTargetCount ?? 0} |`,
        `| **SEO** | **${s.score ?? '-'}/100** | H1s: ${s.metadata?.h1Count ?? 0} · JSON-LD: ${s.metadata?.jsonLdSchemaCount ?? 0} · Canonical: ${s.metadata?.canonical ? 'Yes' : 'No'} |`,
        '',
        allIssues.length > 0 ? `### Actionable Findings\n\n${allIssues.join('\n')}` : `All Core Web Vitals, WCAG 2.2 AA, and SEO checks passed cleanly.`
      ].join('\n');
      chatHistory.push({ role: 'agent', text: md, timestamp: Date.now() });
    }
    await saveHistory();
    renderAllMessages();
  } finally {
    if (quickAuditBtn) quickAuditBtn.disabled = false;
  }
}

if (quickAuditBtn) {
  quickAuditBtn.addEventListener('click', runInstantAudit);
}

if (macroRecordBtn) {
  macroRecordBtn.addEventListener('click', async () => {
    const res = await chrome.runtime.sendMessage({
      type: 'TOGGLE_MACRO_RECORDING',
      tabId: activeTab?.tabId || null
    });
    if (res?.ok && res.result && res.result.recording === false && res.result.playwrightCode) {
      workflowsDrawer.hidden = true;
      workflowsBtn.classList.remove('active');
      setShellInert(false);
      chatHistory.push({
        role: 'agent',
        text: `Recorded **${res.result.stepCount}** human workflow step(s) — ready-to-run Playwright test:\n\n\`\`\`ts\n${res.result.playwrightCode.trim()}\n\`\`\``,
        timestamp: Date.now()
      });
      await saveHistory();
      renderAllMessages();
    }
  });
}

if (macroReplayBtn) {
  macroReplayBtn.addEventListener('click', async () => {
    workflowsDrawer.hidden = true;
    workflowsBtn.classList.remove('active');
    setShellInert(false);
    submitPrompt('Use chrome_macro_recorder with action="replay" to replay my recorded browser workflow steps on this tab and report the outcome.');
  });
}

pauseBtn.addEventListener('click', async () => {
  const nextPaused = !currentState?.paused;
  await chrome.runtime.sendMessage({ type: 'SET_PAUSE', paused: nextPaused });
});

async function setAutonomyMode(mode) {
  await chrome.runtime.sendMessage({ type: 'SET_AUTONOMY_MODE', mode });
}

modeAutoBtn.addEventListener('click', () => setAutonomyMode('auto'));
modeAskBtn.addEventListener('click', () => setAutonomyMode('ask'));
quickModeBtn.addEventListener('click', () => {
  const next = currentState?.autonomyMode === 'ask' ? 'auto' : 'ask';
  setAutonomyMode(next);
});

document.querySelectorAll('.theme-btn').forEach((btn) => {
  btn.addEventListener('click', async () => {
    const theme = btn.dataset.themeVal || 'system';
    applyTheme(theme);
    await chrome.runtime.sendMessage({ type: 'SET_THEME_PREFERENCE', theme });
  });
});

document.querySelectorAll('.model-btn').forEach((btn) => {
  btn.addEventListener('click', async () => {
    const model = btn.dataset.modelVal || 'auto';
    document.querySelectorAll('.model-btn').forEach((b) => b.classList.toggle('active', b.dataset.modelVal === model));
    await chrome.runtime.sendMessage({ type: 'SET_PREFERRED_MODEL', model });
  });
});

reconnectBtn.addEventListener('click', async () => {
  reconnectBtn.textContent = '...';
  await chrome.runtime.sendMessage({ type: 'RECONNECT_BRIDGE' });
  reconnectBtn.textContent = 'Reconnect';
});

attachTabGroupBtn.addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'GROUP_CURRENT_TAB' });
  attachTabGroupBtn.textContent = 'Grouped';
  setTimeout(() => {
    attachTabGroupBtn.textContent = 'Group Active Tab';
  }, 1200);
});

saveDomainsBtn.addEventListener('click', async () => {
  const allow = allowDomainsInput.value.split(/[\n,]+/).map((s) => s.trim()).filter(Boolean);
  const block = blockDomainsInput.value.split(/[\n,]+/).map((s) => s.trim()).filter(Boolean);
  await chrome.runtime.sendMessage({ type: 'UPDATE_DOMAIN_RULES', allow, block });
  saveDomainsBtn.textContent = 'Saved';
  setTimeout(() => {
    saveDomainsBtn.textContent = 'Save Rules';
  }, 1200);
});

clearLogsBtn.addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'CLEAR_LOGS' });
});

domainAllowBtn.addEventListener('click', async () => {
  if (pendingApprovalHostname) {
    await chrome.runtime.sendMessage({ type: 'ALLOW_DOMAIN_QUICK', hostname: pendingApprovalHostname });
  }
  domainApprovalBar.hidden = true;
});

domainDismissBtn.addEventListener('click', () => {
  domainApprovalBar.hidden = true;
});

// Shortcuts & Schedules CRUD
function renderWorkflowsDrawer() {
  if (!currentState) return;

  shortcutsListEl.innerHTML = '';
  for (const sc of currentState.shortcuts || []) {
    const row = document.createElement('div');
    row.className = 'list-row';
    const main = document.createElement('div');
    main.className = 'list-row-main';
    main.innerHTML = `<span class="list-row-cmd">${escapeHtml(sc.command)}</span>${escapeHtml(sc.label || sc.prompt)}`;
    main.addEventListener('click', () => {
      workflowsDrawer.hidden = true;
      workflowsBtn.classList.remove('active');
      chatInput.value = sc.prompt;
      updateSubmitState();
      chatInput.focus();
    });

    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'text-btn';
    delBtn.textContent = '×';
    delBtn.addEventListener('click', async () => {
      const next = (currentState.shortcuts || []).filter((x) => x.id !== sc.id);
      await chrome.runtime.sendMessage({ type: 'SAVE_SHORTCUTS', shortcuts: next });
    });

    row.append(main, delBtn);
    shortcutsListEl.appendChild(row);
  }

  schedulesListEl.innerHTML = '';
  const schedules = currentState.schedules || [];
  if (!schedules.length) {
    const empty = document.createElement('div');
    empty.style.fontSize = '11px';
    empty.style.color = 'var(--fg-subtle)';
    empty.textContent = 'No recurring browser tasks scheduled.';
    schedulesListEl.appendChild(empty);
  } else {
    for (const s of schedules) {
      const row = document.createElement('div');
      row.className = 'list-row';
      const main = document.createElement('div');
      main.className = 'list-row-main';
      main.innerHTML = `<span class="list-row-cmd">Every ${Number(s.intervalMinutes)}m</span>${escapeHtml(s.name)}`;
      const delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'text-btn';
      delBtn.textContent = '×';
      delBtn.addEventListener('click', async () => {
        const next = schedules.filter((x) => x.id !== s.id);
        await chrome.runtime.sendMessage({ type: 'SAVE_SCHEDULES', schedules: next });
      });
      row.append(main, delBtn);
      schedulesListEl.appendChild(row);
    }
  }
}

addShortcutForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const cmdInput = document.getElementById('sc-cmd');
  const promptInput = document.getElementById('sc-prompt');
  let command = cmdInput.value.trim();
  if (!command.startsWith('/')) command = `/${command}`;
  const prompt = promptInput.value.trim();
  if (!command || !prompt) return;

  const next = [
    ...(currentState?.shortcuts || []),
    { id: `sc-${Date.now()}`, command, label: prompt.slice(0, 36), prompt }
  ];
  await chrome.runtime.sendMessage({ type: 'SAVE_SHORTCUTS', shortcuts: next });
  cmdInput.value = '';
  promptInput.value = '';
});

addScheduleForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const nameEl = document.getElementById('sched-name');
  const minsEl = document.getElementById('sched-mins');
  const urlEl = document.getElementById('sched-url');
  const promptEl = document.getElementById('sched-prompt');

  const next = [
    ...(currentState?.schedules || []),
    {
      id: `sched-${Date.now()}`,
      name: nameEl.value.trim(),
      intervalMinutes: Math.max(1, Number(minsEl.value) || 60),
      url: urlEl.value.trim() || null,
      prompt: promptEl.value.trim(),
      enabled: true
    }
  ];
  await chrome.runtime.sendMessage({ type: 'SAVE_SCHEDULES', schedules: next });
  nameEl.value = '';
  urlEl.value = '';
  promptEl.value = '';
});

// --- UI State Synchronization ---
function syncStateUi() {
  if (!currentState) return;

  connDot.className = 'status-dot';
  if (currentState.paused) {
    connDot.classList.add('paused');
    pauseBtn.classList.add('active');
  } else if (currentState.connected) {
    connDot.classList.add('connected');
    pauseBtn.classList.remove('active');
  } else {
    pauseBtn.classList.remove('active');
  }

  gifBtn.classList.toggle('recording', Boolean(currentState.gifRecording));
  if (macroRecordBtn) {
    macroRecordBtn.textContent = currentState.macroRecording ? 'Stop & Codegen' : 'Record Macro';
  }
  if (macroStatusBadge) {
    macroStatusBadge.textContent = `${currentState.macroStepCount || 0} step${currentState.macroStepCount === 1 ? '' : 's'}`;
  }
  const prefModel = currentState.preferredModel || 'auto';
  document.querySelectorAll('.model-btn').forEach((b) => {
    b.classList.toggle('active', b.dataset.modelVal === prefModel);
  });

  const isAsk = currentState.autonomyMode === 'ask';
  quickModeBtn.textContent = isAsk ? 'Ask' : 'Auto';
  modeAutoBtn.classList.toggle('active', !isAsk);
  modeAskBtn.classList.toggle('active', isAsk);

  bridgeEndpointLabel.textContent = `127.0.0.1:${currentState.bridgePort || 17380}`;
  applyTheme(currentState.themePreference);

  if (document.activeElement !== allowDomainsInput) {
    allowDomainsInput.value = (currentState.domainRules?.allow || []).join(', ');
  }
  if (document.activeElement !== blockDomainsInput) {
    blockDomainsInput.value = (currentState.domainRules?.block || []).join(', ');
  }

  activityLogList.innerHTML = '';
  const logs = currentState.actionLogs || [];
  for (const entry of logs.slice(0, 15)) {
    const li = document.createElement('li');
    li.className = 'log-entry';
    const time = new Date(entry.timestamp).toLocaleTimeString([], { hour12: false });
    li.innerHTML = `<div class="log-entry-head"><span>${escapeHtml(entry.action)}</span><span>${escapeHtml(time)}</span></div>
      <div class="log-entry-body">${escapeHtml(entry.details)}</div>`;
    activityLogList.appendChild(li);
  }

  renderWorkflowsDrawer();
}

function syncTabsUi(tabs = []) {
  allOpenTabs = tabs;
  const current = tabs.find((t) => t.active) || tabs[0];
  if (current) {
    activeTab = current;
    const host = safeHostname(current.url);
    activeTabLabel.textContent = host || (current.title || 'Current tab').slice(0, 22);
    activeTabChip.title = `${current.title}\n${current.url}`;
  }
}

// --- Chat History & Message Rendering ---
async function loadHistory() {
  const data = await chrome.storage.local.get(STORAGE_CHAT_KEY);
  if (Array.isArray(data[STORAGE_CHAT_KEY]) && data[STORAGE_CHAT_KEY].length > 0) {
    chatHistory = data[STORAGE_CHAT_KEY];
  }
  renderAllMessages();
}

async function saveHistory() {
  await chrome.storage.local.set({ [STORAGE_CHAT_KEY]: chatHistory.slice(-60) });
}

function renderMessageElement(msg) {
  const row = document.createElement('div');
  row.className = `msg-row ${msg.role}`;
  if (msg.requestId) row.dataset.requestId = msg.requestId;

  if (msg.role === 'agent' && Array.isArray(msg.steps) && msg.steps.length > 0) {
    const details = document.createElement('details');
    details.className = 'trace-details';
    const summary = document.createElement('summary');
    summary.className = 'trace-summary';
    summary.innerHTML = `<span>${msg.steps.length} browser action${msg.steps.length === 1 ? '' : 's'}</span><span>▾</span>`;
    const list = document.createElement('div');
    list.className = 'trace-list';
    for (const s of msg.steps) {
      const item = document.createElement('div');
      item.className = `trace-step ${s.status || 'done'}`;
      item.innerHTML = `<span class="trace-step-dot"></span><span>${escapeHtml(s.label)}</span>`;
      list.appendChild(item);
    }
    details.append(summary, list);
    row.appendChild(details);
  }

  const bubble = document.createElement('div');
  bubble.className = 'msg-bubble';

  if (msg.pending) {
    bubble.innerHTML = `<div class="thinking-line"><span class="thinking-dot"></span><span>${escapeHtml(msg.streamText || 'Working...')}</span></div>`;
  } else if (msg.role === 'agent') {
    const contentDiv = document.createElement('div');
    contentDiv.className = 'msg-content';
    mountSanitizedMarkdown(contentDiv, msg.text || '');
    bubble.appendChild(contentDiv);
  } else {
    bubble.textContent = msg.text || '';
  }

  if (msg.screenshot) {
    const media = document.createElement('div');
    media.className = 'msg-media';
    const img = document.createElement('img');
    img.src = msg.screenshot;
    img.alt = 'Capture';
    media.appendChild(img);
    bubble.appendChild(media);
  }

  row.appendChild(bubble);
  return row;
}

function renderAllMessages() {
  messagesContainer.innerHTML = '';
  if (chatHistory.length === 0) {
    messagesContainer.appendChild(welcomeState);
    return;
  }
  for (const msg of chatHistory) {
    messagesContainer.appendChild(renderMessageElement(msg));
  }
  messagesContainer.scrollTop = messagesContainer.scrollHeight;
}

// --- Submit Prompt ---
async function submitPrompt(rawText) {
  const text = String(rawText || '').trim();
  const screenshotToSend = attachedImageDataUrl;
  const elementToSend = pickedElement;
  const tabsToSend = mentionedTabs.map((t) => t.tabId);

  if (!text && !screenshotToSend && !elementToSend) return;

  const userDisplay =
    text ||
    (elementToSend ? `Inspect <${elementToSend.tag}> (${elementToSend.selector})` : 'Inspect attached screenshot');

  chatHistory.push({
    role: 'user',
    text: userDisplay,
    screenshot: screenshotToSend,
    timestamp: Date.now()
  });

  const requestId = `req-${Date.now()}`;
  activeTraceSteps = [];
  chatHistory.push({
    role: 'agent',
    requestId,
    text: '',
    pending: true,
    steps: [],
    timestamp: Date.now()
  });

  chatInput.value = '';
  if (!CSS.supports('field-sizing', 'content')) {
    chatInput.style.height = 'auto';
  }
  pickedElement = null;
  mentionedTabs = [];
  renderDynamicChips();
  clearAttachment();
  hidePalette();
  await saveHistory();
  renderAllMessages();

  try {
    const res = await chrome.runtime.sendMessage({
      type: 'SEND_PROMPT_TO_ANTIGRAVITY',
      requestId,
      prompt: userDisplay,
      tabId: activeTab?.tabId || null,
      includePageContext: includeActivePage,
      mentionedTabIds: tabsToSend,
      pickedElement: elementToSend,
      screenshot: screenshotToSend
    });

    if (!res?.ok) {
      finalizePendingMessage(requestId, `Bridge unavailable: ${res?.error || 'Check connection.'}`, true);
    }
  } catch (err) {
    finalizePendingMessage(requestId, `Bridge error: ${err.message}`, true);
  }
}

function finalizePendingMessage(requestId, text, isError = false) {
  const idx = chatHistory.findIndex((m) => m.requestId === requestId);
  if (idx !== -1) {
    chatHistory[idx].pending = false;
    chatHistory[idx].text = text;
    chatHistory[idx].error = isError;
    if (activeTraceSteps.length > 0) {
      chatHistory[idx].steps = [...activeTraceSteps];
    }
  } else {
    chatHistory.push({
      role: 'agent',
      text,
      error: isError,
      steps: [...activeTraceSteps],
      timestamp: Date.now()
    });
  }
  saveHistory();
  renderAllMessages();
}

// Starter Buttons
document.querySelectorAll('.starter-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    if (btn.getAttribute('data-action') === 'quick-audit') {
      runInstantAudit();
      return;
    }
    const prompt = btn.getAttribute('data-prompt');
    if (prompt) submitPrompt(prompt);
  });
});

// New Conversation
newChatBtn.addEventListener('click', async () => {
  chatHistory = [];
  activeTraceSteps = [];
  await chrome.runtime.sendMessage({ type: 'RESET_CONVERSATION' });
  renderAllMessages();
  chatInput.focus();
});

// Form & IME-Safe Enter-to-Submit (per modern-web-guidance `ime-safe-enter-submit`)
chatInput.addEventListener('compositionend', (event) => {
  lastCompositionEndAt = event.timeStamp;
});

chatInput.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !paletteMenu.hidden) {
    event.preventDefault();
    hidePalette();
    return;
  }

  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    if (event.isComposing || event.keyCode === 229) return;
    if (lastCompositionEndAt !== null && Math.abs(event.timeStamp - lastCompositionEndAt) < 50) {
      return;
    }
    if (!paletteMenu.hidden) {
      const first = paletteMenu.querySelector('.palette-item');
      if (first) {
        first.click();
        return;
      }
    }
    chatForm.requestSubmit();
  }
});

chatForm.addEventListener('submit', (e) => {
  e.preventDefault();
  submitPrompt(chatInput.value);
});

// --- Runtime Event Stream Listener ---
chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === 'STATE_UPDATED' && message.state) {
    currentState = message.state;
    syncStateUi();
    return;
  }

  if (message?.type === 'COMPOSER_ELEMENT_ATTACHED' && message.element) {
    pickedElement = message.element;
    renderDynamicChips();
    updateSubmitState();
    chatInput.focus();
    return;
  }

  if (message?.type === 'COMPOSER_IMAGE_ATTACHED' && message.dataUrl) {
    setAttachment(message.dataUrl, message.label || 'Region capture');
    return;
  }

  if (message?.type === 'DOMAIN_APPROVAL_NEEDED' && message.hostname) {
    pendingApprovalHostname = message.hostname;
    domainApprovalText.textContent = `Allow Antigravity on ${message.hostname}?`;
    domainApprovalBar.hidden = false;
    return;
  }

  if (message?.type === 'LIVE_TOOL_EVENT') {
    const cleanName = String(message.method || '').replace(/^chrome_/, '');
    if (message.phase === 'start') {
      activeTraceSteps.push({ id: message.id, label: cleanName, status: 'running' });
    } else {
      const existing = activeTraceSteps.find((s) => s.id === message.id);
      if (existing) existing.status = message.phase === 'error' ? 'error' : 'done';
      else activeTraceSteps.push({ id: message.id, label: cleanName, status: message.phase });
    }

    const lastMsg = chatHistory[chatHistory.length - 1];
    if (lastMsg && lastMsg.role === 'agent') {
      lastMsg.steps = [...activeTraceSteps];
      if (lastMsg.pending) {
        lastMsg.streamText = `Running ${cleanName}...`;
      }
      renderAllMessages();
    }
    return;
  }

  if (message?.type === 'PROMPT_STREAM' && message.chunk) {
    const idx = chatHistory.findIndex((m) => m.requestId === message.requestId);
    if (idx !== -1 && chatHistory[idx].pending) {
      chatHistory[idx].streamText = String(message.chunk).trim().slice(-90) || 'Working...';
      renderAllMessages();
    }
    return;
  }

  if (message?.type === 'PROMPT_COMPLETED') {
    finalizePendingMessage(message.requestId, message.output, !message.ok);
  }
});

// Refresh tab context on tab switch/navigation
chrome.tabs.onActivated.addListener(async () => {
  const res = await chrome.runtime.sendMessage({ type: 'GET_STATE' });
  if (res?.tabs) syncTabsUi(res.tabs);
});

chrome.tabs.onUpdated.addListener(async (_tabId, changeInfo) => {
  if (changeInfo.status === 'complete' || changeInfo.title) {
    const res = await chrome.runtime.sendMessage({ type: 'GET_STATE' });
    if (res?.tabs) syncTabsUi(res.tabs);
  }
});

// Boot
(async () => {
  await loadHistory();
  const res = await chrome.runtime.sendMessage({ type: 'GET_STATE' });
  if (res) {
    currentState = res.state;
    syncStateUi();
    syncTabsUi(res.tabs);
  }
})();
