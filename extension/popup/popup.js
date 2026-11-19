/**
 * Popup UI controller for Gemini Antigravity in Chrome.
 */

const statusBadge = document.getElementById('status-badge');
const agyVersionEl = document.getElementById('agy-version');
const bridgeEndpointEl = document.getElementById('bridge-endpoint');
const activeConvosEl = document.getElementById('active-convos');
const openSidepanelBtn = document.getElementById('open-sidepanel-btn');
const groupTabBtn = document.getElementById('group-tab-btn');
const pauseBtn = document.getElementById('pause-btn');
const reconnectBtn = document.getElementById('reconnect-btn');
const clearLogsBtn = document.getElementById('clear-logs-btn');
const actionLogList = document.getElementById('action-log-list');

let currentState = null;

function renderState(state) {
  currentState = state;
  if (!state) return;

  if (state.paused) {
    statusBadge.textContent = 'Paused';
    statusBadge.className = 'badge badge-paused';
    pauseBtn.textContent = 'Resume Control';
  } else if (state.connected) {
    statusBadge.textContent = 'Connected';
    statusBadge.className = 'badge badge-connected';
    pauseBtn.textContent = 'Pause Control';
  } else {
    statusBadge.textContent = 'Offline';
    statusBadge.className = 'badge badge-disconnected';
    pauseBtn.textContent = 'Pause Control';
  }

  bridgeEndpointEl.textContent = `127.0.0.1:${state.bridgePort || 17380}`;

  const info = state.antigravityInfo;
  if (info?.installed) {
    agyVersionEl.textContent = info.running
      ? `Running (${info.version || 'Active'})`
      : 'Installed (Idle)';
    activeConvosEl.textContent = String(info.activeConversations?.length || 0);
  } else if (state.connected) {
    agyVersionEl.textContent = 'Bridge Active';
    activeConvosEl.textContent = '1';
  } else {
    agyVersionEl.textContent = 'Waiting for Bridge...';
    activeConvosEl.textContent = '0';
  }

  const logs = state.actionLogs || [];
  actionLogList.innerHTML = '';
  if (logs.length === 0) {
    const empty = document.createElement('li');
    empty.className = 'log-empty';
    empty.textContent = 'No agent actions recorded yet.';
    actionLogList.appendChild(empty);
  } else {
    for (const item of logs.slice(0, 12)) {
      const li = document.createElement('li');
      li.className = 'log-item';

      const top = document.createElement('div');
      top.className = 'log-item-top';
      const actSpan = document.createElement('span');
      actSpan.textContent = item.action;
      const timeSpan = document.createElement('span');
      timeSpan.textContent = new Date(item.timestamp).toLocaleTimeString();
      top.append(actSpan, timeSpan);

      const det = document.createElement('div');
      det.className = 'log-item-details';
      det.textContent = item.details;

      li.append(top, det);
      actionLogList.appendChild(li);
    }
  }
}

openSidepanelBtn.addEventListener('click', async () => {
  const currentWindow = await chrome.windows.getCurrent({ populate: false });
  if (currentWindow?.id) {
    await chrome.sidePanel.open({ windowId: currentWindow.id });
    window.close();
  }
});

groupTabBtn.addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'GROUP_CURRENT_TAB' });
  groupTabBtn.textContent = 'Tab Attached!';
  setTimeout(() => {
    groupTabBtn.textContent = 'Attach Current Tab';
  }, 1500);
});

pauseBtn.addEventListener('click', async () => {
  const nextPaused = !currentState?.paused;
  const response = await chrome.runtime.sendMessage({
    type: 'SET_PAUSE',
    paused: nextPaused
  });
  if (response?.ok && currentState) {
    renderState({ ...currentState, paused: nextPaused });
  }
});

reconnectBtn.addEventListener('click', async () => {
  reconnectBtn.textContent = 'Scanning...';
  const res = await chrome.runtime.sendMessage({ type: 'RECONNECT_BRIDGE' });
  if (res?.state) renderState(res.state);
  reconnectBtn.textContent = 'Re-Scan Local Antigravity Bridge';
});

clearLogsBtn.addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'CLEAR_LOGS' });
  if (currentState) renderState({ ...currentState, actionLogs: [] });
});

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === 'STATE_UPDATED' && message.state) {
    renderState(message.state);
  }
});

(async () => {
  const response = await chrome.runtime.sendMessage({ type: 'GET_STATE' });
  if (response?.state) {
    renderState(response.state);
  }
})();
