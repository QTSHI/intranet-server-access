const $ = selector => document.querySelector(selector);
const base = document.querySelector('meta[name="lab-base-path"]')?.content === '/lab' ? '/lab' : '';
const endpoint = path => `${base}${path}`;
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const shapes = {
  terminal: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="m7 9 3 3-3 3m6 0h4"/>',
  folder: '<path d="M3 7V5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6M8 13h8M8 17h6"/>',
  link: '<path d="m10 13 4-4m-6 5-2 2a3 3 0 0 1-4-4l4-4a3 3 0 0 1 4 0m4 2 2-2a3 3 0 0 1 4 4l-4 4a3 3 0 0 1-4 0"/>',
  chevron: '<path d="m9 5 7 7-7 7"/>',
  refresh: '<path d="M20 8a8 8 0 1 0 0 8M20 3v5h-5"/>',
  home: '<path d="m3 10 9-7 9 7v11h-7v-7h-4v7H3z"/>',
  up: '<path d="M12 20V4m-6 6 6-6 6 6"/>',
  sidebar: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 3v18"/>',
  expand: '<path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5"/>',
  collapse: '<path d="M3 8h5V3m13 5h-5V3M8 21v-5H3m13 5v-5h5"/>',
  power: '<path d="M12 2v10m-5-7a9 9 0 1 0 10 0"/>',
  arrow: '<path d="M5 12h14m-5-5 5 5-5 5"/>',
  shield: '<path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6z"/><path d="m8.5 12 2.5 2.5 4.5-5"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6m0-10h.01"/>',
  save: '<path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h12l4 4v12a2 2 0 0 1-2 2zM7 3v6h10V3M7 21v-8h10v8"/>',
  key: '<circle cx="8" cy="8" r="5"/><path d="m12 12 9 9m-4-4 3-3m-6 0 3-3"/>',
};
const icon = (name, size = 18) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${shapes[name] || shapes.info}</svg>`;
const brand = () => `<span class="w-brand-symbol" aria-hidden="true">${icon('terminal', 21)}</span><span>实验室远程工作台</span>`;
const state = { serverName: '实验室服务器', available: null, busy: false, connected: false, username: '', message: '', error: false, sidebarCollapsed: false, fileDrawerOpen: false, features: {}, terminalCollapsed: false, terminalSize: 1, mobileView: 'terminal', quickInputOpen: true };
const newFiles = () => ({ available: false, status: 'waiting', message: '', homePath: '', rootPath: '', nodes: new Map(), focusPath: '', selectedPath: '' });
let files = newFiles();
let socket = null;
let term = null;
let fit = null;
let observer = null;
let runId = 0;
let pendingSecret = null;
let authTimeout;
let fitFrame = 0;
let outputBytes = 0;
let toastTimeout;
let requestCounter = 0;
let fileQueue = [];
const pendingFiles = new Map();
const directoryLoads = new Map();
let filePumpTimeout;
let lastFileSend = 0;
let editor = null;
let editorModulePromise = null;
let editorInitPromise = null;
let applyingEditor = false;
let tabs = [];
let activeTabId = '';
let tabCounter = 0;
let pendingAckBytes = 0;
let ackTimer;
let perfTimer;
let perfCounter = 0;
let quickInputComposing = false;
const pendingPings = new Map();
const metrics = { webRttMs: null, sftpStatMs: null, sftpSampleAgeMs: null, renderQueueMs: null, outputPending: null, outputPaused: false, eventLoopDelayMs: null, updatedAt: 0 };

let currentLocation = location.pathname + location.hash;
let leavePending = false;
const MAX_BUFFER = 1024 * 1024;
const MAX_FILE = 256 * 1024;

function toast(message) {
  $('#toast').textContent = message; $('#toast').hidden = false;
  clearTimeout(toastTimeout); toastTimeout = setTimeout(() => { $('#toast').hidden = true; }, 4500);
}
function safeMessage(message, fallback) {
  const text = typeof message === 'string' ? message.slice(0, 300) : '';
  return text && !/\b(?:\d{1,3}\.){3}\d{1,3}\b|SHA256:|(?:port|端口)\s*[:=]?\s*\d{2,5}|ECONN|ENOTFOUND/i.test(text) ? text : fallback;
}
function active() { return (state.busy || state.connected) && socket && socket.readyState <= WebSocket.OPEN; }
function renderLogin() {
  $('#app').innerHTML = `<div class="w-login-page">
    <header class="w-login-top"><div class="w-brand">${brand()}</div></header>
    <main class="w-login-main" id="main" tabindex="-1">
      <section class="w-login-card" aria-labelledby="w-login-title">
        <div class="w-login-heading"><h1 id="w-login-title">远程工作台</h1><p class="w-login-description">使用个人校园 Linux 账号，进入自己的开发环境。</p></div>
        <form id="w-campus-login" autocomplete="on">
          <label class="w-field" for="campus-username">校园账号<input id="campus-username" name="username" maxlength="64" autocomplete="username" autocapitalize="none" spellcheck="false" required placeholder="用户名" value="${esc(state.username)}"></label>
          <label class="w-field" for="campus-password">密码<input id="campus-password" name="password" type="password" maxlength="512" autocomplete="current-password" required placeholder="密码"></label>
          <button class="w-button w-primary w-login-submit" id="w-connect" type="submit">连接${icon('arrow', 17)}</button>
          <button class="w-cancel-login" id="w-cancel-login" type="button" hidden>取消</button>
        </form>
        <p id="w-login-feedback" class="w-login-feedback" role="status" aria-live="polite"></p>
        <button type="button" id="w-retry-service" class="w-text-button" hidden>重试</button>
      </section>
    </main>
  </div>`;
  $('#w-campus-login').addEventListener('submit', beginConnection);
  $('#w-cancel-login').onclick = () => disconnectToLogin('已取消连接。');
  $('#w-retry-service').onclick = () => void loadCapabilities();
  updateLogin();
}
function updateLogin() {
  if (!$('#w-campus-login')) return;
  $('#campus-username').disabled = state.busy;
  $('#campus-password').disabled = state.busy;
  $('#w-connect').disabled = state.busy || state.available !== true;
  $('#w-connect').innerHTML = state.busy ? '<span class="w-spinner" aria-hidden="true"></span>正在连接…' : `连接${icon('arrow', 17)}`;
  $('#w-cancel-login').hidden = !state.busy;
  $('#w-retry-service').hidden = state.available !== false || state.busy;
  const feedback = $('#w-login-feedback');
  feedback.textContent = state.message || (state.available === null ? '正在准备连接服务…' : '');
  feedback.classList.toggle('w-error', state.error);
  feedback.setAttribute('role', state.error ? 'alert' : 'status');
  document.querySelectorAll('[data-server-name]').forEach(el => { el.textContent = state.serverName; });
}
async function loadCapabilities() {
  state.available = null; state.message = ''; state.error = false; updateLogin();
  try {
    const response = await fetch(endpoint('/api/session'), { credentials: 'omit', cache: 'no-store', headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(12000) });
    if (!response.ok) throw new Error();
    const data = await response.json(); const capabilities = data.capabilities || data;
    if (capabilities.authMode !== 'campus') throw new Error();
    if (typeof capabilities.serverName === 'string') state.serverName = capabilities.serverName.slice(0, 80);
    state.available = true;
  } catch { state.available = false; state.error = true; state.message = '连接服务暂时不可用，请稍后重试。'; }
  updateLogin();
}
function renderWorkspace() {
  $('#app').innerHTML = `<div class="w-workspace${state.sidebarCollapsed ? ' w-sidebar-collapsed' : ''}" id="w-workspace" data-mobile-view="${state.mobileView}">
    <header class="w-topbar"><div class="w-topbar-left"><button class="w-icon-button" id="w-files-toggle" aria-label="切换文件概览" title="切换文件概览" aria-controls="w-file-sidebar" aria-expanded="${!state.sidebarCollapsed}">${icon('sidebar', 19)}</button><div class="w-brand">${brand()}</div></div><div class="w-topbar-actions"><span class="w-account" id="w-account">${esc(state.username)}</span><span class="w-connected" id="w-session-status" role="status"><i></i>已连接</span><button class="w-latency" id="w-latency" title="查看连接诊断" aria-label="查看连接诊断" hidden>— ms</button><button class="w-icon-button" id="w-fullscreen" aria-label="全屏" title="全屏">${icon('expand', 18)}</button><button class="w-disconnect" id="w-disconnect">${icon('power', 16)}<span>断开会话</span></button></div></header>
    <div class="w-workspace-body"><aside class="w-file-sidebar" id="w-file-sidebar" aria-label="校园账户文件概览"><header class="w-files-heading"><h2>文件概览</h2><div><button class="w-icon-button" id="w-files-home" title="回到主目录" aria-label="回到主目录">${icon('home', 15)}</button><button class="w-icon-button" id="w-files-refresh" title="刷新当前目录" aria-label="刷新当前目录">${icon('refresh', 15)}</button><button class="w-icon-button w-drawer-close" id="w-files-close" title="关闭文件概览" aria-label="关闭文件概览">${icon('close', 17)}</button></div></header><div class="w-files-location"><button class="w-icon-button" id="w-files-up" title="上一级目录" aria-label="上一级目录">${icon('up', 14)}</button><span id="w-files-location"></span></div><div class="w-files-content" id="w-files-content" role="region" aria-label="目录内容"><div id="w-file-tree" role="tree" aria-label="校园 Linux 文件树"></div><div class="w-files-feedback" id="w-files-feedback" role="status"></div></div></aside><button class="w-files-backdrop" id="w-files-backdrop" aria-label="关闭文件概览" hidden></button>
    <main class="w-editor-main" id="main" tabindex="-1"><section class="w-editor-pane" id="w-editor-pane" aria-label="文件编辑区"><div class="w-editor-tabbar"><div class="w-editor-tabs" id="w-editor-tabs" role="tablist" aria-label="已打开文件"></div><div class="w-editor-actions"><button class="w-icon-button" id="w-reload" title="从服务器重新载入文件" aria-label="重新载入文件" disabled>${icon('refresh', 15)}</button><button class="w-save" id="w-save" title="保存 (Ctrl / ⌘ S)" disabled>${icon('save', 15)}<span>保存</span></button></div></div><div class="w-editor-path" id="w-editor-path" hidden></div><div class="w-editor-message" id="w-editor-message" role="status" hidden></div><div class="w-editor-surface" id="w-editor-surface" role="tabpanel" aria-label="文件内容"><div class="w-editor-text" id="w-editor-text" hidden></div><div class="w-editor-empty" id="w-editor-empty"><span class="w-empty-icon">${icon('file', 32)}</span><h1>打开文件，开始工作</h1><p>从左侧选择文本文件，本地编辑后保存到校园服务器。</p><span class="w-editor-shortcut"><kbd>Ctrl</kbd> / <kbd>⌘</kbd> + <kbd>S</kbd> 保存</span></div></div><footer class="w-editor-status" id="w-editor-status" role="status" hidden></footer></section>
    <section class="w-terminal-pane" id="w-terminal-pane" aria-label="校园 SSH 终端"><header class="w-terminal-tabbar"><button class="w-terminal-toggle" id="w-terminal-toggle" aria-expanded="true" aria-controls="w-xterm">${icon('terminal', 15)}<span>终端</span><span class="w-tab-connection">SSH</span></button><div><button class="w-quick-input-toggle" id="w-quick-input-toggle" type="button" aria-controls="w-quick-input-form" aria-expanded="false" title="快速输入 (Ctrl+Shift+Enter)">快速输入</button><button class="w-icon-button" id="w-terminal-resize" title="调整终端高度" aria-label="调整终端高度">${icon('expand', 14)}</button><button class="w-icon-button" id="w-terminal-collapse" title="收起终端" aria-label="收起终端">${icon('chevron', 14)}</button></div></header><div class="w-xterm" id="w-xterm" aria-label="校园 SSH 终端"></div><form class="w-quick-input-form" id="w-quick-input-form" autocomplete="off" hidden><input id="w-quick-input" type="text" aria-label="快速输入命令" placeholder="输入命令，Enter 发送" maxlength="8192" autocomplete="off" autocapitalize="none" spellcheck="false"><button id="w-quick-input-send" type="submit" disabled>发送</button></form></section></main></div>
    <nav class="w-mobile-views" aria-label="工作区视图"><button data-view="files">${icon('folder', 17)}文件</button><button data-view="editor">${icon('file', 17)}编辑</button><button data-view="terminal">${icon('terminal', 17)}终端</button></nav><footer class="w-statusbar"><span id="w-workspace-status">校园账户环境</span></footer></div>`;
  $('#w-files-toggle').onclick = toggleFiles;
  $('#w-files-close').onclick = closeFilesDrawer;
  $('#w-files-backdrop').onclick = closeFilesDrawer;
  $('#w-files-refresh').onclick = () => { if (files.rootPath) void loadDirectory(files.rootPath, true); };
  $('#w-files-home').onclick = () => { if (files.homePath) showDirectory(files.homePath); };
  $('#w-files-up').onclick = () => { if (files.rootPath && files.rootPath !== '/') showDirectory(parentPath(files.rootPath)); };
  $('#w-file-tree').addEventListener('click', event => { const row = event.target.closest('[role="treeitem"]'); if (row) activateTreeRow(row); });
  $('#w-file-tree').addEventListener('dblclick', event => { const row = event.target.closest('[role="treeitem"]'); if (row?.dataset.type === 'directory') showDirectory(row.dataset.path); });
  $('#w-file-tree').addEventListener('keydown', treeKeydown);
  $('#w-editor-tabs').addEventListener('click', event => {
    const close = event.target.closest('[data-tab-close]');
    if (close) { void closeTab(close.dataset.tabClose); return; }
    const button = event.target.closest('[data-tab-id]'); if (button) switchTab(button.dataset.tabId);
  });
  $('#w-editor-tabs').addEventListener('keydown', event => {
    const button = event.target.closest('[data-tab-id]'); if (!button || !['ArrowLeft', 'ArrowRight', 'Home', 'End', 'Delete'].includes(event.key)) return;
    event.preventDefault();
    if (event.key === 'Delete') { void closeTab(button.dataset.tabId); return; }
    const index = tabs.findIndex(tab => tab.id === button.dataset.tabId);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
    switchTab(tabs[next].id, false); $(`[data-tab-id="${tabs[next].id}"]`)?.focus();
  });
  $('#w-save').onclick = () => void saveActiveTab();
  $('#w-reload').onclick = () => void reloadActiveTab();
  $('#w-terminal-toggle').onclick = toggleTerminal;
  $('#w-terminal-collapse').onclick = toggleTerminal;
  $('#w-terminal-resize').onclick = () => { state.terminalSize = (state.terminalSize + 1) % 3; state.terminalCollapsed = false; updateTerminalLayout(); };
  document.querySelectorAll('[data-view]').forEach(button => { button.onclick = () => setMobileView(button.dataset.view); });
  $('#w-latency').onclick = showDiagnostics;
  $('#w-fullscreen').onclick = async () => {
    try { if (document.fullscreenElement) await document.exitFullscreen(); else await $('#w-workspace').requestFullscreen(); }
    catch { toast('浏览器未允许全屏，请检查浏览器设置后重试。'); }
  };
  $('#w-disconnect').onclick = async () => { if (await askDisconnect(state.connected ? '断开连接？' : '返回登录？', state.connected ? '断开' : '返回登录')) disconnectToLogin(state.connected ? '已断开连接。' : '请重新输入校园密码。', false, true); };
  if (innerWidth <= 760) { $('#w-file-sidebar').inert = true; $('#w-files-toggle').setAttribute('aria-expanded', 'false'); }
  else $('#w-file-sidebar').inert = state.sidebarCollapsed;
  initQuickInput(); updateQuickInputLayout(); initTerminal(); renderFiles(); renderTabs(); updateEditorView(); updateTerminalLayout(); updateWorkspaceConnection();
  document.querySelectorAll('[data-view]').forEach(button => { button.classList.toggle('w-view-active', button.dataset.view === state.mobileView); button.setAttribute('aria-pressed', String(button.dataset.view === state.mobileView)); });
  if (files.available && files.rootPath) void loadDirectory(files.rootPath);
  if (state.features.performance) startPerformance();
}
function updateWorkspaceConnection() {
  if (!$('#w-workspace')) return;
  const connected = state.connected;
  $('#w-session-status').innerHTML = connected ? '<i></i>已连接' : '<i></i>已断开';
  $('#w-session-status').classList.toggle('w-offline', !connected);
  $('#w-workspace-status').textContent = connected ? '校园账户环境' : '连接已断开 · 未保存内容仍在当前页面';
  $('#w-disconnect').querySelector('span').textContent = connected ? '断开会话' : '返回登录';
  $('#w-disconnect').setAttribute('aria-label', connected ? '断开会话' : '返回登录');
  $('#w-latency').hidden = !state.features.performance || !connected;
  $('#w-terminal-resize').disabled = !connected;
  updateQuickInputLayout();
  updateEditorStatus(); updateLatency();
}
function updateTerminalLayout() {
  const workspace = $('#w-workspace'); if (!workspace) return;
  workspace.classList.toggle('w-terminal-collapsed', state.terminalCollapsed);
  workspace.style.setProperty('--terminal-height', ['180px', 'min(34vh, 330px)', 'min(55vh, 520px)'][state.terminalSize]);
  $('#w-terminal-toggle').setAttribute('aria-expanded', String(!state.terminalCollapsed));
  $('#w-terminal-collapse').title = state.terminalCollapsed ? '展开终端' : '收起终端';
  $('#w-terminal-collapse').setAttribute('aria-label', state.terminalCollapsed ? '展开终端' : '收起终端');
  $('#w-terminal-collapse').classList.toggle('w-is-collapsed', state.terminalCollapsed);
  scheduleFit();
}
function toggleTerminal() {
  if (innerWidth <= 760) { setMobileView(state.mobileView === 'terminal' ? 'editor' : 'terminal'); return; }
  state.terminalCollapsed = !state.terminalCollapsed; updateTerminalLayout();
  if (!state.terminalCollapsed) term?.focus();
}
function setMobileView(view) {
  if (!['files', 'editor', 'terminal'].includes(view)) return;
  if (view === 'files') { setDrawer(true); return; }
  if (state.fileDrawerOpen) closeFilesDrawer();
  state.mobileView = view;
  $('#w-workspace')?.setAttribute('data-mobile-view', view);
  document.querySelectorAll('[data-view]').forEach(button => { button.classList.toggle('w-view-active', button.dataset.view === view); button.setAttribute('aria-pressed', String(button.dataset.view === view)); });
  scheduleFit(); if (view === 'terminal') term?.focus(); else if (activeTab()) editor?.focus();
}
function syncViewport() {
  const viewport = window.visualViewport;
  // Pinch zoom should magnify the workspace rather than rearrange its panels.
  const height = !document.fullscreenElement && viewport && Math.abs(viewport.scale - 1) < 0.01
    ? Math.min(innerHeight, viewport.height) : innerHeight;
  if (Number.isFinite(height) && height > 0) {
    const value = `${height}px`;
    if (document.documentElement.style.getPropertyValue('--workbench-height') !== value)
      document.documentElement.style.setProperty('--workbench-height', value);
  }
  scheduleFit();
}
function scheduleFit() {
  cancelAnimationFrame(fitFrame);
  fitFrame = requestAnimationFrame(() => {
    updateQuickInputLayout();
    if (!state.connected || !term || !fit || !$('#w-xterm')?.getClientRects().length) return;
    try { fit.fit(); } catch { toast('终端尺寸调整失败，请退出全屏后重试。'); }
  });
}
function initTerminal() {
  term = new window.Terminal({ cursorBlink: true, fontSize: 14, fontFamily: '"SFMono-Regular", Consolas, "Liberation Mono", monospace', scrollback: 3000, allowProposedApi: false, theme: { background: '#111827', foreground: '#cbd5e1', cursor: '#93b8ff', selectionBackground: '#334a70' } });
  fit = new window.FitAddon.FitAddon(); term.loadAddon(fit); term.open($('#w-xterm'));
  term.onData(sendTerminalInput);
  term.onResize(({ cols, rows }) => { if (state.connected) send({ type: 'resize', cols, rows }); });
  observer = new ResizeObserver(scheduleFit); observer.observe($('#w-xterm'));
  fit.fit(); term.focus();
}
function sendTerminalInput(data) {
  if (!state.connected || !socket || socket.readyState !== WebSocket.OPEN) return false;
  let offset = 0;
  while (state.connected && offset < data.length) {
    let end = Math.min(offset + 2048, data.length);
    if (end < data.length && /[\uD800-\uDBFF]/.test(data[end - 1]) && /[\uDC00-\uDFFF]/.test(data[end])) end--;
    if (!send({ type: 'input', data: data.slice(offset, end) })) return false;
    offset = end;
  }
  return offset === data.length;
}
function quickInputAvailable() {
  return ($('#main')?.clientHeight || 0) >= (innerWidth <= 760 ? 140 : 300);
}
function updateQuickInputControls() {
  const input = $('#w-quick-input'); if (!input) return;
  $('#w-quick-input-send').disabled = !state.connected || input.disabled || quickInputComposing || !input.value.length;
}
function updateQuickInputLayout() {
  const form = $('#w-quick-input-form'); if (!form) return;
  const available = quickInputAvailable();
  const shown = available && state.quickInputOpen && !state.terminalCollapsed;
  form.hidden = !shown;
  $('#w-terminal-pane').classList.toggle('w-quick-input-open', shown);
  $('#w-quick-input-toggle').disabled = !state.connected || !available;
  $('#w-quick-input-toggle').setAttribute('aria-expanded', String(shown));
  $('#w-quick-input').disabled = !state.connected || !shown;
  updateQuickInputControls();
}
function clearQuickInput() {
  quickInputComposing = false;
  const input = $('#w-quick-input');
  if (input) { input.value = ''; input.disabled = true; input.blur(); }
  const sendButton = $('#w-quick-input-send'); if (sendButton) sendButton.disabled = true;
  const toggle = $('#w-quick-input-toggle'); if (toggle) toggle.disabled = true;
}
function focusQuickInput() {
  if (!state.connected || !quickInputAvailable()) return;
  state.quickInputOpen = true;
  if (state.terminalCollapsed) { state.terminalCollapsed = false; updateTerminalLayout(); }
  updateQuickInputLayout();
  const input = $('#w-quick-input');
  if (input && !input.disabled && input.getClientRects().length) input.focus({ preventScroll: true });
  scheduleFit();
}
function submitQuickInput() {
  const input = $('#w-quick-input');
  if (!input || input.disabled || !state.connected || quickInputComposing || !input.value.length) return;
  if (/[\x00-\x1f\x7f-\x9f\u2028\u2029]/.test(input.value)) {
    toast('控制按键请直接在终端中输入。'); return;
  }
  if (!sendTerminalInput(`${input.value}\r`)) return;
  input.value = ''; updateQuickInputControls(); term?.focus();
}
function initQuickInput() {
  quickInputComposing = false;
  const input = $('#w-quick-input');
  $('#w-quick-input-form').onsubmit = event => { event.preventDefault(); submitQuickInput(); };
  $('#w-quick-input-toggle').onclick = () => {
    if (state.terminalCollapsed) { focusQuickInput(); return; }
    state.quickInputOpen = !state.quickInputOpen; updateQuickInputLayout(); scheduleFit();
    if (state.quickInputOpen) focusQuickInput(); else term?.focus();
  };
  input.addEventListener('input', updateQuickInputControls);
  input.addEventListener('compositionstart', () => { quickInputComposing = true; updateQuickInputControls(); });
  input.addEventListener('compositionend', () => {
    quickInputComposing = false;
    if (!state.connected || input.disabled) input.value = '';
    updateQuickInputControls();
  });
  input.addEventListener('keydown', event => {
    if (event.key === 'Enter') {
      event.preventDefault(); event.stopPropagation();
      if (!event.isComposing && event.keyCode !== 229 && !quickInputComposing) submitQuickInput();
    } else if (event.key === 'Escape') {
      event.preventDefault(); event.stopPropagation(); quickInputComposing = false; term?.focus();
    }
  });
  input.addEventListener('paste', event => {
    const text = event.clipboardData?.getData('text');
    if (typeof text !== 'string') { event.preventDefault(); return; }
    if (/[\r\n\u2028\u2029]/.test(text)) {
      event.preventDefault(); toast('多行内容请直接粘贴到终端。');
    } else if (/[\x00-\x1f\x7f-\x9f]/.test(text)) {
      event.preventDefault(); toast('控制按键请直接在终端中输入。');
    }
  });
}
function send(packet) {
  if (!socket || socket.readyState !== WebSocket.OPEN) return false;
  const data = JSON.stringify(packet);
  if (socket.bufferedAmount + new TextEncoder().encode(data).byteLength > MAX_BUFFER) {
    disconnectToLogin('发送积压过多，连接已断开。请检查网络后重新登录。', true); return false;
  }
  try { socket.send(data); return true; }
  catch { disconnectToLogin('连接已中断，请重新登录。', true); return false; }
}
function rejectFileWork(message) {
  clearTimeout(filePumpTimeout);
  const error = new Error(message);
  for (const job of pendingFiles.values()) { clearTimeout(job.timeout); job.reject(error); }
  pendingFiles.clear();
  for (const job of fileQueue) job.reject(error);
  fileQueue = []; directoryLoads.clear();
}
function teardown(notify = false, keepDrafts = false) {
  $('#w-confirm-cancel')?.click();
  clearQuickInput();
  runId++; stopPerformance(); clearTimeout(ackTimer); ackTimer = null; pendingAckBytes = 0; clearTimeout(authTimeout); pendingSecret?.(); pendingSecret = null;
  const previous = socket; socket = null;
  if (previous) {
    previous.onopen = previous.onmessage = previous.onerror = previous.onclose = null;
    try { if (notify && previous.readyState === WebSocket.OPEN) previous.send(JSON.stringify({ type: 'disconnect' })); if (previous.readyState < WebSocket.CLOSING) previous.close(1000, 'Browser session closed'); } catch {}
  }
  cancelAnimationFrame(fitFrame); observer?.disconnect(); observer = null;
  term?.dispose(); term = null; fit = null; outputBytes = 0;
  rejectFileWork('会话已结束。'); files = newFiles(); lastFileSend = 0;
  editorInitPromise = null;
  if (!keepDrafts) { editor?.destroy(); editor = null; tabs = []; activeTabId = ''; }
  else for (const tab of tabs) { tab.saving = false; tab.loading = false; if (tab.draft !== tab.savedContent) tab.error = '会话已断开。当前草稿仍在页面中，可复制保留；返回登录会清除草稿。'; }
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
}
function disconnectToLogin(message, error = false, discard = false) {
  const preserve = !discard && state.connected && hasDirtyTabs();
  if (preserve) rememberEditorState();
  teardown(true, preserve); state.connected = false; state.busy = false; state.fileDrawerOpen = false;
  state.message = message; state.error = error;
  if (preserve && $('#w-workspace')) {
    if ($('#w-file-sidebar')?.classList.contains('w-drawer-open')) setDrawer(false);
    files.status = 'unavailable'; files.message = '连接已断开。'; renderFiles();
    $('#w-xterm').innerHTML = '<p class="w-terminal-offline">会话已断开。未保存的编辑内容仍在当前页面，请复制保留后返回登录。</p>';
    updateWorkspaceConnection(); updateTabIndicators(); updateEditorStatus(); toast(message); return;
  }
  document.title = '实验室远程工作台'; renderLogin(); $('#campus-password')?.focus();
}
function beginConnection(event) {
  event.preventDefault(); if (active() || state.available !== true) return;
  const userInput = $('#campus-username'); const passInput = $('#campus-password');
  const username = userInput.value.trim(); let secret = passInput.value;
  passInput.value = '';
  if (!username || username.length > 64 || /[\s\x00-\x1f\x7f]/.test(username) || !secret || secret.length > 512) {
    secret = ''; state.message = '请填写有效的校园 SSH 用户名和密码。用户名不能包含空格。'; state.error = true; updateLogin(); return;
  }
  if (typeof window.Terminal !== 'function' || typeof window.FitAddon?.FitAddon !== 'function') {
    secret = ''; state.message = '终端组件未能加载，请刷新页面后重试。'; state.error = true; updateLogin(); return;
  }
  teardown(); state.features = {}; state.mobileView = 'terminal'; state.terminalCollapsed = false; state.terminalSize = 1; state.quickInputOpen = true; state.username = username; state.busy = true; state.message = '正在连接校园通道并验证账户，请稍候。'; state.error = false; updateLogin();
  pendingSecret = () => { secret = ''; };
  const generation = runId;
  const url = new URL(endpoint('/api/terminal'), location.origin); url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  let connection;
  try { connection = new WebSocket(url); socket = connection; }
  catch { secret = ''; disconnectToLogin('网页连接无法建立，请刷新后重试。', true); return; }
  const isCurrent = () => runId === generation && socket === connection;
  authTimeout = setTimeout(() => { if (isCurrent()) disconnectToLogin('校园认证等待超时。请检查账户信息后重试，或联系管理员检查校园通道。', true); }, 30000);
  connection.onopen = () => {
    if (!isCurrent()) { secret = ''; return; }
    send({ type: 'login', username, password: secret, cols: Math.min(300, Math.max(20, Math.floor((innerWidth - 36) / 8.5))), rows: Math.min(150, Math.max(10, Math.floor((innerHeight - 120) / 21))) });
    secret = ''; pendingSecret = null;
  };
  connection.onmessage = event => {
    if (!isCurrent()) return;
    let packet;
    try {
      if (typeof event.data !== 'string' || event.data.length > 2 * MAX_BUFFER) throw new Error();
      packet = JSON.parse(event.data);
      if (!packet || typeof packet !== 'object' || Array.isArray(packet)) throw new Error();
    } catch { disconnectToLogin('收到无法识别的连接响应，已断开会话。', true); return; }
    if (packet.type === 'state') {
      if (packet.state === 'authenticating') { if (!state.connected) { state.busy = true; updateLogin(); } }
      else if (packet.state === 'connected') {
        clearTimeout(authTimeout); secret = ''; pendingSecret = null;
        state.busy = false; state.features = { fileWrite: packet.features?.fileWrite === true, performance: packet.features?.performance === true };
        if (typeof packet.username === 'string') state.username = packet.username.slice(0, 64);
        if (!state.connected) {
          state.connected = true;
          try { renderWorkspace(); } catch { disconnectToLogin('终端显示未能初始化，已断开连接。请刷新后重试。', true); }
        }
      } else if (packet.state === 'error') disconnectToLogin(safeMessage(packet.message, '校园登录失败，请检查用户名和密码后重试。'), true);
      else if (packet.state === 'disconnected') disconnectToLogin(safeMessage(packet.message, '校园会话已断开，请重新登录。'));
    } else if (packet.type === 'data') {
      if (!state.connected || !term) return;
      try {
        if (typeof packet.data !== 'string' || packet.data.length > 2 * MAX_BUFFER) throw new Error();
        const bytes = Uint8Array.from(atob(packet.data), c => c.charCodeAt(0)); outputBytes += bytes.byteLength;
        if (outputBytes > MAX_BUFFER) { disconnectToLogin('终端输出积压过多，连接已断开。请重新登录并减少一次性输出。', true); return; }
        const expected = term; const queuedAt = performance.now();
        term.write(bytes, () => {
          if (expected !== term || !isCurrent()) return;
          outputBytes = Math.max(0, outputBytes - bytes.byteLength);
          metrics.renderQueueMs = Math.round(performance.now() - queuedAt);
          pendingAckBytes += bytes.byteLength;
          if (pendingAckBytes >= 32768) flushAck();
          else if (!ackTimer) ackTimer = setTimeout(flushAck, 16);
        });
      } catch { disconnectToLogin('终端输出无法解析，已断开会话。', true); }
    } else if (packet.type === 'exit') {
      const detail = Number.isInteger(packet.code) ? `（退出码 ${packet.code}）` : '';
      disconnectToLogin(`校园会话已退出${detail}。再次连接时，请重新输入密码。`);
    } else if (packet.type === 'files:ready') {
      if (!validPath(packet.homePath)) { setFilesUnavailable('无法确认校园账户主目录，文件概览暂不可用。'); return; }
      files.available = true; files.status = 'ready'; files.homePath = packet.homePath; files.rootPath = packet.homePath; files.message = '';
      if (state.connected) { renderFiles(); void loadDirectory(files.rootPath); }
    } else if (packet.type === 'files:unavailable') setFilesUnavailable(safeMessage(packet.message, '当前校园环境不支持文件概览。'));
    else if (['files:list', 'files:read', 'files:write', 'files:error'].includes(packet.type)) finishFileRequest(packet);
    else if (packet.type === 'perf:pong' && state.features.performance) receivePong(packet);
    else if (packet.type === 'perf:stats' && state.features.performance) receiveStats(packet);
  };
  connection.onerror = () => { if (isCurrent()) { secret = ''; disconnectToLogin('网页连接未能建立或已中断，请检查网络后重新登录。', true); } };
  connection.onclose = () => { if (isCurrent()) { secret = ''; disconnectToLogin(state.connected ? '校园会话已断开，请重新登录。' : '连接已关闭，校园认证尚未完成。请重新输入密码后连接。'); } };
}
function validPath(path) { return typeof path === 'string' && path.startsWith('/') && path.length <= 4096 && !path.includes('\0'); }
function parentPath(path) { const clean = path.replace(/\/+$/, ''); return clean.slice(0, clean.lastIndexOf('/')) || '/'; }
function baseName(path) { return path.replace(/\/+$/, '').split('/').pop() || '/'; }
function childPath(parent, name) { return `${parent === '/' ? '' : parent}/${name}`; }
function displayPath(path) { return path === files.homePath ? '~' : files.homePath && path.startsWith(`${files.homePath}/`) ? `~/${path.slice(files.homePath.length + 1)}` : path; }
function setFilesUnavailable(message) {
  rejectFileWork(message); files.available = false; files.status = 'unavailable'; files.message = message; renderFiles(); updateEditorStatus();
}
function requestFile(type, path, extra = {}) {
  if (!state.connected || !files.available || !validPath(path)) return Promise.reject(new Error('文件概览当前不可用。'));
  if (fileQueue.length >= 20) return Promise.reject(new Error('请等待当前文件请求完成后重试。'));
  return new Promise((resolve, reject) => {
    fileQueue.push({ type, path, extra, generation: runId, resolve, reject }); pumpFiles();
  });
}
function pumpFiles() {
  clearTimeout(filePumpTimeout);
  if (pendingFiles.size || !fileQueue.length || !state.connected || !files.available) return;
  const delay = Math.max(0, 220 - (Date.now() - lastFileSend));
  if (delay) { filePumpTimeout = setTimeout(pumpFiles, delay); return; }
  const job = fileQueue.shift();
  if (job.generation !== runId) { job.reject(new Error('会话已结束。')); pumpFiles(); return; }
  const requestId = `files-${runId}-${++requestCounter}`;
  job.timeout = setTimeout(() => {
    if (pendingFiles.get(requestId) !== job) return;
    setFilesUnavailable('文件请求超时。保存结果可能未知，草稿将保留；文件操作已暂停，终端仍可使用。');
  }, 15000);
  pendingFiles.set(requestId, job); lastFileSend = Date.now();
  send({ type: job.type, requestId, path: job.path, ...job.extra }); updateFileControls();
}
function finishFileRequest(packet) {
  const job = pendingFiles.get(packet.requestId);
  if (!job || job.generation !== runId) return;
  clearTimeout(job.timeout); pendingFiles.delete(packet.requestId);
  if (packet.type === 'files:error') {
    const message = safeMessage(packet.message, '无法读取此项目，请检查校园账户的文件权限。');
    const error = new Error(message); error.code = packet.code; job.reject(error);
  } else if (packet.type !== job.type) job.reject(new Error('文件响应类型不匹配，请重试。'));
  else job.resolve(packet);
  updateFileControls(); pumpFiles();
}
function nodeFor(path, type = 'directory', name = baseName(path)) {
  let node = files.nodes.get(path);
  if (!node) { node = { path, name, type, size: null, mtime: null, entries: null, expanded: false, loading: false, error: '', truncated: false }; files.nodes.set(path, node); }
  return node;
}
async function loadDirectory(path, force = false) {
  if (!files.available || !validPath(path)) return;
  if (directoryLoads.has(path)) return directoryLoads.get(path);
  const node = nodeFor(path); if (node.entries && !force) { renderFiles(); return; }
  const generation = runId; node.loading = true; node.error = ''; renderFiles();
  const work = (async () => {
    try {
      const packet = await requestFile('files:list', path);
      if (generation !== runId || !files.available) return;
      if (!Array.isArray(packet.entries)) throw new Error('目录内容无法识别，请刷新后重试。');
      const entries = packet.entries.filter(entry => entry && typeof entry.name === 'string' && entry.name !== '.' && entry.name !== '..' && !entry.name.includes('/') && !entry.name.includes('\0') && entry.name.length <= 512);
      node.entries = entries.slice(0, 300).map(entry => {
        const child = nodeFor(childPath(path, entry.name), ['directory', 'file', 'symlink', 'other'].includes(entry.type) ? entry.type : 'other', entry.name);
        child.type = ['directory', 'file', 'symlink', 'other'].includes(entry.type) ? entry.type : 'other';
        child.size = Number.isFinite(entry.size) ? entry.size : null; child.mtime = entry.mtime;
        return child.path;
      });
      node.truncated = packet.truncated === true || entries.length > 300;
      if (validPath(packet.homePath)) files.homePath = packet.homePath;
    } catch (error) { if (generation === runId) node.error = safeMessage(error.message, '目录暂时无法读取。'); }
    finally { if (generation === runId) { node.loading = false; directoryLoads.delete(path); renderFiles(); } }
  })();
  directoryLoads.set(path, work); return work;
}
function showDirectory(path) {
  if (!files.available || !validPath(path)) return;
  files.rootPath = path; files.focusPath = ''; files.selectedPath = ''; renderFiles(); void loadDirectory(path);
}
function renderFiles() {
  if (!$('#w-file-tree')) return;
  const tree = $('#w-file-tree'); const activeRow = document.activeElement?.closest('[role="treeitem"]');
  const restorePath = activeRow && tree.contains(activeRow) ? activeRow.dataset.path : '';
  const root = files.nodes.get(files.rootPath); const busy = pendingFiles.size > 0 || root?.loading;
  $('#w-files-home').disabled = !files.available || busy;
  $('#w-files-refresh').disabled = !files.available || busy;
  $('#w-files-up').disabled = !files.available || busy || files.rootPath === '/';
  $('#w-files-location').textContent = files.rootPath ? displayPath(files.rootPath) : '校园主目录';
  $('#w-files-location').title = files.rootPath;
  let rows = []; let count = 0;
  const walk = (node, depth) => {
    if (!node || count >= 800) return;
    count++;
    const directory = node.type === 'directory';
    rows.push(`<div class="w-tree-row${files.selectedPath === node.path ? ' w-selected' : ''}${node.loading ? ' w-loading-row' : ''}" role="treeitem" aria-level="${depth + 1}"${directory ? ` aria-expanded="${node.expanded}"` : ''} aria-selected="${files.selectedPath === node.path}"${node.loading ? ' aria-busy="true"' : ''} tabindex="-1" data-path="${esc(node.path)}" data-type="${node.type}" data-depth="${depth}" style="--depth:${depth}" title="${esc(node.name)}${directory ? ' · 单击展开，双击进入目录' : ''}"><span class="w-tree-chevron${node.expanded ? ' w-expanded' : ''}">${directory ? icon('chevron', 11) : ''}</span><span class="w-entry-icon w-entry-${node.type}">${icon(directory ? 'folder' : node.type === 'symlink' ? 'link' : 'file', 16)}</span><span class="w-entry-name">${esc(node.name)}</span>${node.loading ? '<span class="w-tree-spinner" aria-label="加载中"></span>' : ''}</div>`);
    if (directory && node.expanded) {
      if (node.error) rows.push(`<div class="w-tree-hint w-error" style="--depth:${depth + 1}">${esc(node.error)}</div>`);
      else if (Array.isArray(node.entries) && node.entries.length === 0) rows.push(`<div class="w-tree-hint" style="--depth:${depth + 1}">空文件夹</div>`);
      if (depth < 8) for (const child of node.entries || []) walk(files.nodes.get(child), depth + 1);
      if (node.truncated) rows.push(`<div class="w-tree-hint" style="--depth:${depth + 1}">仅显示部分项目</div>`);
    }
  };
  if (files.available) for (const child of root?.entries || []) walk(files.nodes.get(child), 0);
  tree.innerHTML = rows.join('');
  const allRows = [...tree.querySelectorAll('[role="treeitem"]')];
  const focused = allRows.find(row => row.dataset.path === (restorePath || files.focusPath)) || allRows[0];
  if (focused) { focused.tabIndex = 0; if (restorePath) focused.focus({ preventScroll: true }); }
  const feedback = $('#w-files-feedback');
  if (!files.available) feedback.textContent = files.status === 'unavailable' ? files.message : '正在准备校园账户文件概览…';
  else if (root?.error) feedback.textContent = root.error;
  else if (root?.loading && !root.entries) feedback.textContent = '正在读取目录…';
  else if (root?.entries?.length === 0) feedback.textContent = '此目录为空。';
  else if (root?.truncated || count >= 800) feedback.textContent = '仅显示部分项目。可进入更具体的目录继续查看。';
  else feedback.textContent = '';
  feedback.hidden = !feedback.textContent;
}
function focusRow(row) {
  if (!row) return;
  document.querySelectorAll('#w-file-tree [role="treeitem"]').forEach(item => { item.tabIndex = item === row ? 0 : -1; });
  files.focusPath = row.dataset.path; row.focus();
}
function activateTreeRow(row) {
  const node = files.nodes.get(row.dataset.path); if (!node || !files.available) return;
  files.focusPath = node.path; files.selectedPath = node.path;
  if (node.type === 'directory') {
    if (Number(row.dataset.depth) >= 8) { showDirectory(node.path); return; }
    node.expanded = !node.expanded;
    renderFiles(); if (node.expanded) void loadDirectory(node.path);
  } else if (node.type === 'file') { renderFiles(); void openFile(node); }
  else { renderFiles(); toast(node.type === 'symlink' ? '符号链接仅显示名称，暂不展开或编辑。' : '此项目类型暂不支持编辑。'); }
}
function treeKeydown(event) {
  const row = event.target.closest('[role="treeitem"]'); if (!row) return;
  const rows = [...$('#w-file-tree').querySelectorAll('[role="treeitem"]')]; const index = rows.indexOf(row); const node = files.nodes.get(row.dataset.path);
  if (['ArrowUp', 'ArrowDown', 'Home', 'End', 'ArrowLeft', 'ArrowRight', 'Enter', ' '].includes(event.key)) event.preventDefault(); else return;
  if (event.key === 'ArrowUp') focusRow(rows[Math.max(0, index - 1)]);
  else if (event.key === 'ArrowDown') focusRow(rows[Math.min(rows.length - 1, index + 1)]);
  else if (event.key === 'Home') focusRow(rows[0]);
  else if (event.key === 'End') focusRow(rows[rows.length - 1]);
  else if (event.key === 'ArrowRight' && node?.type === 'directory') {
    if (!node.expanded) activateTreeRow(row);
    else if (rows[index + 1] && Number(rows[index + 1].dataset.depth) > Number(row.dataset.depth)) focusRow(rows[index + 1]);
  } else if (event.key === 'ArrowLeft') {
    if (node?.type === 'directory' && node.expanded) activateTreeRow(row);
    else focusRow(rows.find(item => item.dataset.path === parentPath(row.dataset.path)));
  } else if (['Enter', ' '].includes(event.key)) activateTreeRow(row);
}
async function ensureEditor(generation) {
  if (editor) return true;
  if (editorInitPromise) return editorInitPromise;
  editorInitPromise = (async () => {
    try {
      editorModulePromise ||= import('./editor.mjs');
      const { createEditor } = await editorModulePromise;
      if (generation !== runId || !$('#w-editor-text')) return false;
      editor = createEditor($('#w-editor-text'), { doc: '', path: '', readOnly: true, onChange: text => {
        if (applyingEditor || typeof text !== 'string') return;
        const tab = activeTab(); if (!tab || tab.loading) return;
        tab.draft = text; if (!tab.conflict) tab.error = ''; updateTabIndicators(); updateEditorStatus();
      }, onSave: () => void saveActiveTab() });
      updateEditorView(); return true;
    } catch {
      editorModulePromise = null;
      return false;
    } finally { if (generation === runId) editorInitPromise = null; }
  })();
  return editorInitPromise;
}
function activeTab() { return tabs.find(tab => tab.id === activeTabId); }
function isDirty(tab) { return tab.draft !== tab.savedContent; }
function hasDirtyTabs() { return tabs.some(tab => isDirty(tab) || tab.saving); }
function rememberEditorState() { const tab = activeTab(); if (tab && editor) tab.editorState = editor.getState(); }
function validRevision(revision) { return typeof revision === 'string' && /^sha256:[a-f0-9]{64}$/.test(revision); }
function canSave(tab) { return !!tab && state.connected && files.available && state.features.fileWrite && validRevision(tab.revision) && !tab.loading && !tab.saving && !tab.conflict && isDirty(tab); }
function renderTabs() {
  const host = $('#w-editor-tabs'); if (!host) return;
  host.innerHTML = tabs.map(tab => `<div class="w-editor-tab${tab.id === activeTabId ? ' w-tab-active' : ''}" data-tab-wrap="${tab.id}"><button role="tab" id="tab-${tab.id}" aria-selected="${tab.id === activeTabId}" aria-controls="w-editor-surface" tabindex="${tab.id === activeTabId ? 0 : -1}" data-tab-id="${tab.id}" title="${esc(displayPath(tab.path))}">${icon('file', 14)}<span>${esc(tab.name)}</span><i class="w-tab-dirty" aria-hidden="true"${isDirty(tab) ? '' : ' hidden'}></i><span class="w-sr-only">${isDirty(tab) ? '，未保存' : ''}</span></button><button class="w-tab-close" data-tab-close="${tab.id}" aria-label="关闭 ${esc(tab.name)}" title="关闭文件"${tab.saving ? ' disabled' : ''}>${icon('close', 12)}</button></div>`).join('');
  if (!tabs.length) host.innerHTML = '<span class="w-tabs-empty">编辑器</span>';
}
function updateTabIndicators() {
  for (const tab of tabs) {
    const wrap = $(`[data-tab-wrap="${tab.id}"]`); if (!wrap) continue;
    const dirty = isDirty(tab); wrap.querySelector('.w-tab-dirty').hidden = !dirty;
    wrap.querySelector('.w-sr-only').textContent = dirty ? '，未保存' : '';
    wrap.querySelector('[data-tab-close]').disabled = tab.saving;
    wrap.classList.toggle('w-tab-saving', tab.saving);
  }
}
function switchTab(id, focus = true) {
  if (!tabs.some(tab => tab.id === id)) return;
  if (activeTabId !== id) { rememberEditorState(); activeTabId = id; renderTabs(); updateEditorView(); }
  if (innerWidth <= 760) setMobileView('editor');
  if (focus && !activeTab()?.loading) editor?.focus();
  $(`[data-tab-wrap="${id}"]`)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}
function updateEditorView() {
  const tab = activeTab(); const show = !!tab && !tab.loading && !!editor;
  $('#w-editor-text').hidden = !show;
  $('#w-editor-empty').hidden = show;
  $('#w-editor-path').hidden = !tab;
  $('#w-editor-path').textContent = tab ? displayPath(tab.path) : '';
  $('#w-editor-path').title = tab?.path || '';
  if (show) {
    applyingEditor = true;
    try { editor.setValue(tab.draft); if (tab.editorState) editor.setState(tab.editorState); }
    finally { applyingEditor = false; }
    editor.setPath?.(tab.path);
    editor.setReadOnly(!state.features.fileWrite || !validRevision(tab.revision));
    $('#w-editor-surface').setAttribute('aria-labelledby', `tab-${tab.id}`);
  } else {
    $('#w-editor-surface').removeAttribute('aria-labelledby');
    $('#w-editor-empty').innerHTML = tab ? `${icon('file', 30)}<h1>${tab.loading || !tab.error ? '正在打开文件…' : '无法打开文件'}</h1><p>${esc(tab.error || '请稍候。')}</p>` : `<span class="w-empty-icon">${icon('file', 32)}</span><h1>打开文件，开始工作</h1><p>从左侧选择文本文件，本地编辑后保存到校园服务器。</p><span class="w-editor-shortcut"><kbd>Ctrl</kbd> / <kbd>⌘</kbd> + <kbd>S</kbd> 保存</span>`;
  }
  updateEditorStatus();
}
function updateEditorStatus() {
  if (!$('#w-save')) return;
  const tab = activeTab();
  $('#w-save').disabled = !canSave(tab);
  $('#w-save').querySelector('span').textContent = tab?.saving ? '保存中…' : '保存';
  $('#w-reload').disabled = !tab || tab.loading || tab.saving || !state.connected || !files.available;
  const message = $('#w-editor-message');
  message.textContent = tab?.error || '';
  message.hidden = !message.textContent; message.classList.toggle('w-error', !!tab?.error);
  const status = $('#w-editor-status');
  status.hidden = !tab;
  if (!tab) status.textContent = '';
  else if (tab.loading) status.textContent = '正在读取校园文件…';
  else if (tab.saving) status.textContent = '正在保存到校园服务器…';
  else if (!state.connected) status.textContent = '会话已断开 · 草稿尚未保存，可选择复制保留';
  else if (!state.features.fileWrite || !validRevision(tab.revision)) status.textContent = '只读 · 当前服务器未提供文件保存能力';
  else if (tab.conflict) status.textContent = '保存冲突 · 本地草稿已保留';
  else if (isDirty(tab)) status.textContent = '未保存 · Ctrl / ⌘ S 保存到校园服务器';
  else status.textContent = tab.savedAt ? `已保存 · ${tab.savedAt} · UTF-8` : '已载入 · UTF-8';
  document.title = `${hasDirtyTabs() ? '● ' : ''}实验室远程工作台`;
}
async function openFile(node) {
  const existing = tabs.find(tab => tab.path === node.path); if (existing) { switchTab(existing.id); return; }
  if (tabs.length >= 12) { toast('最多同时打开 12 个文件，请先关闭部分标签。'); return; }
  if (node.size !== null && node.size > MAX_FILE) { toast('文件超过 256 KiB，无法在网页编辑器中打开。'); return; }
  rememberEditorState();
  const tab = { id: `file-${++tabCounter}`, name: node.name, path: node.path, draft: '', savedContent: '', revision: null, editorState: null, loading: true, saving: false, conflict: false, error: '', savedAt: '' };
  tabs.push(tab); activeTabId = tab.id; renderTabs(); updateEditorView();
  if (innerWidth <= 760) setMobileView('editor');
  const generation = runId;
  const results = await Promise.allSettled([readIntoTab(tab), ensureEditor(generation)]);
  if (generation !== runId || !tabs.includes(tab)) return;
  if (results[1].status !== 'fulfilled' || !results[1].value) { tab.error = '编辑器未能加载，终端仍可使用。请关闭此标签后重新打开。'; updateEditorView(); }
  else if (tab.id === activeTabId && !tab.error) { updateEditorView(); editor?.focus(); }
}
async function readIntoTab(tab) {
  const generation = runId;
  try {
    const packet = await requestFile('files:read', tab.path);
    if (generation !== runId || !tabs.includes(tab)) return;
    if (packet.encoding !== 'utf-8' || typeof packet.content !== 'string') throw new Error('此文件不是可编辑的 UTF-8 文本。');
    if ((Number.isFinite(packet.size) && packet.size > MAX_FILE) || new TextEncoder().encode(packet.content).byteLength > MAX_FILE) throw new Error('文件超过 256 KiB，无法在网页编辑器中打开。');
    tab.draft = packet.content; tab.savedContent = packet.content; tab.revision = validRevision(packet.revision) ? packet.revision : null;
    tab.editorState = null; tab.conflict = false; tab.error = ''; tab.savedAt = '';
  } catch (error) {
    if (generation !== runId || !tabs.includes(tab)) return;
    tab.error = safeMessage(error.message, '无法打开此文件，请检查账户权限或文件类型。');
  } finally {
    if (generation === runId && tabs.includes(tab)) { tab.loading = false; renderTabs(); if (tab.id === activeTabId) { updateEditorView(); if (!tab.error && editor && (innerWidth > 760 || state.mobileView === 'editor')) editor.focus(); } }
  }
}
async function reloadActiveTab() {
  const tab = activeTab(); if (!tab || tab.loading || tab.saving || !state.connected || !files.available) return;
  if (isDirty(tab) && !(await confirmAction('重新载入文件？', '服务器版本将替换当前编辑内容，未保存的草稿会被丢弃。请先复制需要保留的内容。', '丢弃草稿并载入'))) return;
  if (tab !== activeTab() || !state.connected) return;
  tab.loading = true; tab.error = ''; updateEditorView();
  await readIntoTab(tab);
}
async function saveActiveTab() {
  const tab = activeTab(); if (!canSave(tab)) return;
  const content = tab.draft; const generation = runId;
  if (new TextEncoder().encode(content).byteLength > MAX_FILE) { tab.error = '内容超过 256 KiB，未发送。请缩减内容后重试。'; updateEditorStatus(); return; }
  tab.saving = true; tab.error = ''; updateTabIndicators(); updateEditorStatus();
  try {
    const packet = await requestFile('files:write', tab.path, { content, revision: tab.revision });
    if (generation !== runId || !tabs.includes(tab)) return;
    if (!validRevision(packet.revision)) throw new Error('保存响应无法确认。草稿已保留，请重新载入核对服务器内容。');
    tab.savedContent = content; tab.revision = packet.revision; tab.conflict = false;
    tab.savedAt = new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
    const node = files.nodes.get(tab.path); if (node) { node.size = packet.size; node.mtime = packet.mtime; }
  } catch (error) {
    if (generation !== runId || !tabs.includes(tab)) return;
    if (error.code === 'conflict') { tab.conflict = true; tab.error = '服务器文件已变化，保存被拒绝。本地草稿已保留；请先复制需要的内容，再点“重新载入”获取新版本。'; }
    else if (error.code === 'atomic_save_unsupported') tab.error = '校园服务器暂不支持安全原子保存，文件未覆盖。本地草稿已保留。';
    else if (error.code === 'permission_denied') tab.error = '没有保存此文件的权限。本地草稿已保留。';
    else tab.error = safeMessage(error.message, '保存未能确认，本地草稿已保留。请核对服务器文件后再试。');
  } finally {
    if (generation === runId && tabs.includes(tab)) { tab.saving = false; updateTabIndicators(); updateEditorStatus(); }
  }
}
async function closeTab(id) {
  const tab = tabs.find(item => item.id === id); if (!tab || tab.saving) return;
  if (isDirty(tab) && !(await confirmAction('关闭未保存的文件？', `“${tab.name}”有未保存的修改。关闭后，当前草稿会被丢弃。`, '放弃修改并关闭'))) return;
  if (!tabs.includes(tab) || tab.saving) return;
  const index = tabs.indexOf(tab); const wasActive = activeTabId === id;
  if (!wasActive) rememberEditorState();
  tabs.splice(index, 1);
  if (wasActive) activeTabId = tabs[Math.min(index, tabs.length - 1)]?.id || '';
  renderTabs(); if (wasActive) updateEditorView(); else updateEditorStatus();
  if (activeTab()) editor?.focus(); else $('#w-files-toggle')?.focus();
}
function updateFileControls() {
  if (!$('#w-files-home')) return;
  const busy = pendingFiles.size > 0 || files.nodes.get(files.rootPath)?.loading;
  $('#w-files-home').disabled = !files.available || busy;
  $('#w-files-refresh').disabled = !files.available || busy;
  $('#w-files-up').disabled = !files.available || busy || files.rootPath === '/';
}
function setDrawer(open) {
  if (!$('#w-file-sidebar')) return;
  state.fileDrawerOpen = open;
  $('#w-file-sidebar').classList.toggle('w-drawer-open', open);
  $('#w-file-sidebar').inert = !open;
  if (open) { $('#w-file-sidebar').setAttribute('role', 'dialog'); $('#w-file-sidebar').setAttribute('aria-modal', 'true'); }
  else { $('#w-file-sidebar').removeAttribute('role'); $('#w-file-sidebar').removeAttribute('aria-modal'); }
  $('#w-files-backdrop').hidden = !open; $('#w-files-toggle').setAttribute('aria-expanded', String(open));
  $('#main').inert = open; $('.w-topbar').inert = open; $('.w-mobile-views').inert = open;
  document.querySelector('[data-view="files"]')?.classList.toggle('w-view-active', open);
  if (open) $('#w-files-close').focus(); else $('#w-files-toggle').focus();
}
function closeFilesDrawer() { if (state.fileDrawerOpen) setDrawer(false); }
function toggleFiles() {
  if (innerWidth <= 760) { setDrawer(!state.fileDrawerOpen); return; }
  state.sidebarCollapsed = !state.sidebarCollapsed;
  $('#w-workspace').classList.toggle('w-sidebar-collapsed', state.sidebarCollapsed); $('#w-file-sidebar').inert = state.sidebarCollapsed;
  $('#w-files-toggle').setAttribute('aria-expanded', String(!state.sidebarCollapsed)); scheduleFit();
}
function confirmAction(title, body, label, danger = true) {
  if ($('#w-confirm-dialog')) return Promise.resolve(false);
  const returnFocus = document.activeElement;
  return new Promise(resolve => {
    $('#modal-root').innerHTML = `<dialog class="w-confirm" id="w-confirm-dialog" aria-labelledby="w-confirm-title" aria-describedby="w-confirm-body"><h2 id="w-confirm-title">${esc(title)}</h2><p id="w-confirm-body">${esc(body)}</p><div><button class="w-button w-secondary" id="w-confirm-cancel">取消</button><button class="w-button ${danger ? 'w-danger' : 'w-primary'}" id="w-confirm-accept">${esc(label)}</button></div></dialog>`;
    const dialog = $('#w-confirm-dialog');
    const finish = answer => { dialog.close(); dialog.remove(); if (returnFocus?.isConnected && returnFocus.getClientRects().length) returnFocus.focus(); resolve(answer); };
    $('#w-confirm-cancel').onclick = () => finish(false); $('#w-confirm-accept').onclick = () => finish(true);
    dialog.addEventListener('cancel', event => { event.preventDefault(); finish(false); });
    dialog.showModal(); $('#w-confirm-cancel').focus();
  });
}
function askDisconnect(title = '断开连接？', label = '断开') {
  const dirty = tabs.filter(isDirty).length;
  const saving = tabs.some(tab => tab.saving);
  const body = `${dirty ? `有 ${dirty} 个文件包含未保存修改。离开会丢弃当前页面中的草稿。` : ''}${saving ? '有文件正在保存，断开后保存结果可能未知，请先等待完成。' : ''}${state.connected ? '终端连接将关闭。' : '返回登录会清除当前页面中的文件内容。'}`;
  return confirmAction(title, body, label);
}
function flushAck() {
  clearTimeout(ackTimer); ackTimer = null;
  if (!pendingAckBytes || !state.connected) return;
  const bytes = pendingAckBytes; pendingAckBytes = 0;
  send({ type: 'ack', bytes });
}
function stopPerformance() {
  clearInterval(perfTimer); perfTimer = null;
  for (const pending of pendingPings.values()) clearTimeout(pending.timeout);
  pendingPings.clear();
  for (const key of Object.keys(metrics)) metrics[key] = key === 'outputPaused' ? false : key === 'updatedAt' ? 0 : null;
  $('#w-diagnostics')?.close();
}
function startPerformance() {
  stopPerformance(); samplePerformance(); perfTimer = setInterval(samplePerformance, 15000);
}
function samplePerformance() {
  if (!state.connected || !state.features.performance || !socket || socket.readyState !== WebSocket.OPEN) return;
  const requestId = `perf-${runId}-${++perfCounter}`; const generation = runId;
  const timeout = setTimeout(() => { if (generation !== runId || !pendingPings.has(requestId)) return; pendingPings.delete(requestId); metrics.webRttMs = null; updateLatency(); }, 10000);
  pendingPings.set(requestId, { started: performance.now(), generation, timeout });
  if (!send({ type: 'perf:ping', requestId })) { clearTimeout(timeout); pendingPings.delete(requestId); return; }
  send({ type: 'perf:stats', requestId });
}
function receivePong(packet) {
  const pending = pendingPings.get(packet.requestId); if (!pending || pending.generation !== runId) return;
  clearTimeout(pending.timeout); pendingPings.delete(packet.requestId);
  metrics.webRttMs = Math.round(performance.now() - pending.started); updateLatency();
}
function receiveStats(packet) {
  const numeric = value => Number.isFinite(value) && value >= 0 ? value : null;
  metrics.sftpStatMs = numeric(packet.sftpStatMs); metrics.sftpSampleAgeMs = numeric(packet.sftpSampleAgeMs);
  metrics.outputPending = numeric(packet.outputPending); metrics.outputPaused = packet.outputPaused === true;
  metrics.eventLoopDelayMs = numeric(packet.eventLoopDelayMs); metrics.updatedAt = Date.now(); updateLatency();
}
function formatMs(value) { return Number.isFinite(value) ? `${Math.round(value)} ms` : '等待采样'; }
function updateLatency() {
  const button = $('#w-latency'); if (!button) return;
  button.textContent = Number.isFinite(metrics.webRttMs) ? `${metrics.webRttMs} ms` : '— ms';
  button.setAttribute('aria-label', `连接诊断，网页往返${formatMs(metrics.webRttMs)}`);
  if ($('#w-diagnostics')?.open) renderDiagnostics();
}
function renderDiagnostics() {
  const age = metrics.sftpSampleAgeMs === null ? null : metrics.sftpSampleAgeMs + (metrics.updatedAt ? Date.now() - metrics.updatedAt : 0);
  $('#w-diagnostics-web').textContent = formatMs(metrics.webRttMs);
  $('#w-diagnostics-campus').textContent = age !== null && age > 60000 ? '样本已过期' : formatMs(metrics.sftpStatMs);
  $('#w-diagnostics-render').textContent = formatMs(metrics.renderQueueMs);
  $('#w-diagnostics-detail').textContent = `${metrics.outputPending !== null ? `终端待消费 ${Math.round(metrics.outputPending / 1024)} KiB${metrics.outputPaused ? '，已回压' : ''}。` : ''}${Number.isFinite(metrics.eventLoopDelayMs) ? `网关调度延迟 ${Math.round(metrics.eventLoopDelayMs)} ms。` : ''}`;
}
function showDiagnostics() {
  if (!$('#w-diagnostics') || !state.connected) return;
  renderDiagnostics(); $('#w-diagnostics').showModal(); $('#w-diagnostics-close').focus();
}
$('#w-diagnostics-close').onclick = () => $('#w-diagnostics').close();
document.addEventListener('keydown', event => {
  if (!state.connected || event.isComposing || event.keyCode === 229 || quickInputComposing
    || !event.ctrlKey || !event.shiftKey || event.altKey || event.metaKey || event.key !== 'Enter'
    || !(event.target instanceof Element) || !event.target.closest('#w-terminal-pane')
    || state.fileDrawerOpen || document.querySelector('dialog[open]')) return;
  event.preventDefault(); event.stopPropagation(); focusQuickInput();
}, true);
document.addEventListener('keydown', event => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's' && activeTab() && (event.target.closest('#w-editor-pane') || event.target.closest('.w-editor-pane'))) { event.preventDefault(); void saveActiveTab(); }
});
document.addEventListener('fullscreenchange', () => {
  const button = $('#w-fullscreen'); if (button) { const full = !!document.fullscreenElement; button.innerHTML = icon(full ? 'collapse' : 'expand', 18); button.setAttribute('aria-label', full ? '退出全屏' : '全屏'); button.title = full ? '退出全屏' : '全屏'; }
  syncViewport();
});
window.addEventListener('resize', () => {
  syncViewport();
  if (!state.connected) return;
  if (innerWidth > 760) {
    closeFilesDrawer(); $('#w-file-sidebar').inert = state.sidebarCollapsed;
    $('#w-files-toggle').setAttribute('aria-expanded', String(!state.sidebarCollapsed));
  } else if (!state.fileDrawerOpen) { $('#w-file-sidebar').inert = true; $('#w-files-toggle').setAttribute('aria-expanded', 'false'); }
  scheduleFit();
});
document.addEventListener('keydown', event => {
  if (!state.fileDrawerOpen || document.querySelector('dialog[open]')) return;
  if (event.key === 'Escape') { event.preventDefault(); closeFilesDrawer(); }
  if (event.key === 'Tab') {
    const controls = [...$('#w-file-sidebar').querySelectorAll('button:not(:disabled),[tabindex="0"]')].filter(el => el.getClientRects().length);
    const first = controls[0], last = controls[controls.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  }
});
window.addEventListener('beforeunload', event => { if (active() || hasDirtyTabs()) { event.preventDefault(); event.returnValue = ''; } });
window.addEventListener('popstate', async () => {
  if (!active() && !hasDirtyTabs()) { currentLocation = location.pathname + location.hash; return; }
  const next = location.pathname + location.hash; history.pushState({}, '', currentLocation);
  if (leavePending) return; leavePending = true;
  const allowed = await askDisconnect('离开当前终端？', '断开并离开'); leavePending = false;
  if (allowed) { disconnectToLogin('会话已断开。', false, true); history.replaceState({}, '', next); currentLocation = next; }
});
document.addEventListener('click', async event => {
  const anchor = event.target.closest('a[href]');
  if (!anchor || (!active() && !hasDirtyTabs()) || anchor.target === '_blank' || event.button || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  const target = new URL(anchor.href, location.href);
  if (target.pathname === location.pathname && target.origin === location.origin) return;
  event.preventDefault(); if (leavePending) return; leavePending = true;
  const allowed = await askDisconnect('离开当前终端？', '断开并离开'); leavePending = false;
  if (allowed) { teardown(true); state.connected = false; state.busy = false; location.assign(target.href); }
});
window.visualViewport?.addEventListener('resize', syncViewport);
document.fonts?.ready.then(scheduleFit);
syncViewport();
renderLogin(); void loadCapabilities();
