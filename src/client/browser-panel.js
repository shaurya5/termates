// ============================================
// Browser Panel
// ============================================

import { S } from './state.js';
import { send } from './transport.js';
import { fitAll } from './layout/renderer.js';

export function toggleBrowser(forceOpen) {
  const open = forceOpen !== undefined ? forceOpen : !S.browserOpen;
  S.browserOpen = open;
  document.getElementById('browser-panel').classList.toggle('hidden', !open);
  document.getElementById('browser-resize-handle').classList.toggle('hidden', !open);
  document.getElementById('btn-toggle-browser').classList.toggle('active', open);
  if (open && S.browserTabs.length === 0) addBrowserTab();
  if (open) renderBrowserTabs();
  fitAll();
  send('browser:update', { open });
}

export function addBrowserTab(url = '', title = 'New Tab') {
  const id = S.nextBrowserTabId++;
  S.browserTabs.push({ id, url, title });
  S.activeBrowserTab = S.browserTabs.length - 1;
  renderBrowserTabs(); navigateBrowserTab(); persistBrowser();
}

export function closeBrowserTab(index) {
  S.browserTabs.splice(index, 1);
  if (S.browserTabs.length === 0) { toggleBrowser(false); return; }
  if (S.activeBrowserTab >= S.browserTabs.length) S.activeBrowserTab = S.browserTabs.length - 1;
  renderBrowserTabs(); navigateBrowserTab(); persistBrowser();
}

export function selectBrowserTab(index) {
  S.activeBrowserTab = index;
  renderBrowserTabs(); navigateBrowserTab(); persistBrowser();
}

export function renderBrowserTabs() {
  const container = document.getElementById('browser-tabs');
  container.innerHTML = '';
  S.browserTabs.forEach((tab, i) => {
    const el = document.createElement('button');
    el.className = 'browser-tab' + (i === S.activeBrowserTab ? ' active' : '');
    const label = document.createElement('span');
    try { label.textContent = tab.url ? new URL(tab.url).hostname : tab.title; } catch (e) { label.textContent = tab.title; }
    el.appendChild(label);
    const close = document.createElement('span'); close.className = 'tab-close'; close.textContent = '\u00d7';
    close.addEventListener('click', (e) => { e.stopPropagation(); closeBrowserTab(i); });
    el.appendChild(close);
    el.addEventListener('click', () => selectBrowserTab(i));
    container.appendChild(el);
  });
  const tab = S.browserTabs[S.activeBrowserTab];
  const urlBar = document.getElementById('browser-url');
  if (tab && urlBar) urlBar.value = tab.url || '';
}

export function navigateBrowserTab() {
  const tab = S.browserTabs[S.activeBrowserTab];
  const content = document.getElementById('browser-content');
  if (!tab || !content) return;
  content.innerHTML = '';
  if (tab.url) {
    const iframe = document.createElement('iframe');
    iframe.src = `/proxy?url=${encodeURIComponent(tab.url)}`;
    iframe.sandbox = 'allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox';
    content.appendChild(iframe);
  } else {
    const empty = document.createElement('div'); empty.className = 'browser-empty'; empty.textContent = 'Enter a URL to browse';
    content.appendChild(empty);
  }
}

export function persistBrowser() {
  send('browser:update', { tabs: S.browserTabs, activeTab: S.activeBrowserTab, open: S.browserOpen, width: S.browserWidth });
}

export function setupBrowserResize() {
  const handle = document.getElementById('browser-resize-handle');
  const panel = document.getElementById('browser-panel');
  const workspace = document.getElementById('workspace');
  handle.addEventListener('mousedown', (e) => {
    e.preventDefault(); handle.classList.add('dragging');
    const startX = e.clientX, startW = panel.offsetWidth;
    const move = (e) => { panel.style.width = Math.max(300, Math.min(workspace.offsetWidth * 0.6, startW + (startX - e.clientX))) + 'px'; fitAll(); };
    const up = () => { handle.classList.remove('dragging'); document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up); document.body.style.cursor = ''; document.body.style.userSelect = ''; S.browserWidth = panel.offsetWidth / workspace.offsetWidth; persistBrowser(); fitAll(); };
    document.addEventListener('mousemove', move); document.addEventListener('mouseup', up);
    document.body.style.cursor = 'col-resize'; document.body.style.userSelect = 'none';
  });
}
