// ============================================
// WebSocket Transport
// ============================================

import { S } from './state.js';
import { handleMsg } from './events.js';

export function connectWs() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  S.ws = new WebSocket(`${proto}//${location.host}`);
  S.ws.onopen = () => { S.connected = true; S.ws.send(JSON.stringify({ type: 'terminal:list' })); };
  S.ws.onmessage = (e) => { try { handleMsg(JSON.parse(e.data)); } catch (err) { console.error(err); } };
  S.ws.onclose = () => { S.connected = false; setTimeout(connectWs, 2000); };
  S.ws.onerror = () => { S.connected = false; };
}

export function send(type, payload) {
  if (S.ws?.readyState === WebSocket.OPEN) S.ws.send(JSON.stringify({ type, payload }));
}
