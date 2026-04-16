import net from 'net';
import fs from 'fs';

/**
 * Handle a single parsed CLI command from the Unix socket.
 * @param {net.Socket} socket
 * @param {object} msg - parsed JSON command
 * @param {object} ctx - shared context object
 */
function handleCliCommand(socket, msg, ctx) {
  const { ptyManager, linkManager, broadcast,
          persistState, addTerminalToWorkspace, addLinkToWorkspace, removeLinkFromWorkspaces, removeTerminalFromWorkspaces,
          subscribeTerminalOutput } = ctx;
  const respond = (data) => { try { socket.write(JSON.stringify(data) + '\n'); socket.end(); } catch (e) {} };
  try {
    switch (msg.command) {
      case 'ping':
        respond({ ok: true, version: '2.0.0', uptime: process.uptime(), persistent: ptyManager.tmuxAvailable });
        break;

      case 'list':
        respond({ ok: true, terminals: ptyManager.list(), links: linkManager.listAll(), notes: linkManager.listNotes() });
        break;

      case 'create': {
        const terminal = ptyManager.create({ name: msg.name, shell: msg.shell, cwd: msg.cwd, role: msg.role });
        subscribeTerminalOutput(terminal);
        addTerminalToWorkspace(terminal.id);
        broadcast({ type: 'terminal:created', payload: { id: terminal.id, name: terminal.name, role: terminal.role, status: terminal.status } });
        persistState();
        respond({ ok: true, id: terminal.id, name: terminal.name });
        break;
      }

      case 'ssh': {
        const terminal = ptyManager.createSsh({ name: msg.name, role: msg.role, target: msg.target });
        subscribeTerminalOutput(terminal);
        addTerminalToWorkspace(terminal.id);
        broadcast({ type: 'terminal:created', payload: { id: terminal.id, name: terminal.name, role: terminal.role, status: terminal.status } });
        persistState();
        respond({ ok: true, id: terminal.id, name: terminal.name });
        break;
      }

      case 'send': {
        const t = ptyManager.resolve(msg.target || msg.id || msg.name);
        if (t) { ptyManager.write(t.id, msg.text + '\n'); respond({ ok: true, id: t.id }); }
        else respond({ ok: false, error: `Terminal not found: ${msg.target || msg.id || msg.name}` });
        break;
      }

      case 'read': {
        const t = ptyManager.resolve(msg.target || msg.id || msg.name);
        if (t) respond({ ok: true, id: t.id, buffer: t.getBuffer(msg.lines || 50) });
        else respond({ ok: false, error: `Terminal not found: ${msg.target || msg.id || msg.name}` });
        break;
      }

      case 'link': {
        const from = ptyManager.resolve(msg.from), to = ptyManager.resolve(msg.to);
        if (!from) { respond({ ok: false, error: `Terminal not found: ${msg.from}` }); break; }
        if (!to) { respond({ ok: false, error: `Terminal not found: ${msg.to}` }); break; }
        linkManager.link(from.id, to.id);
        addLinkToWorkspace(from.id, to.id);
        broadcast({ type: 'terminal:linked', payload: { from: from.id, to: to.id } });
        persistState();
        respond({ ok: true, from: from.id, to: to.id });
        break;
      }

      case 'unlink': {
        const from = ptyManager.resolve(msg.from), to = ptyManager.resolve(msg.to);
        if (from && to) {
          linkManager.unlink(from.id, to.id);
          removeLinkFromWorkspaces(from.id, to.id);
          broadcast({ type: 'terminal:unlinked', payload: { from: from.id, to: to.id } });
          persistState();
        }
        respond({ ok: true });
        break;
      }

      case 'notify': {
        const t = ptyManager.resolve(msg.target || msg.id);
        if (t) { ptyManager.setStatus(t.id, msg.status || 'attention'); broadcast({ type: 'terminal:notification', payload: { id: t.id, status: msg.status || 'attention', text: msg.text || '' } }); persistState(); respond({ ok: true }); }
        else respond({ ok: false, error: 'Terminal not found' });
        break;
      }

      case 'status': {
        const t = ptyManager.resolve(msg.target || msg.id);
        if (t) { ptyManager.setStatus(t.id, msg.status); broadcast({ type: 'terminal:status-changed', payload: { id: t.id, status: msg.status } }); persistState(); respond({ ok: true }); }
        else respond({ ok: false, error: 'Terminal not found' });
        break;
      }

      case 'destroy': {
        const t = ptyManager.resolve(msg.target || msg.id);
        if (t) { linkManager.removeTerminal(t.id); removeTerminalFromWorkspaces(t.id); ptyManager.destroy(t.id); broadcast({ type: 'terminal:destroyed', payload: { id: t.id } }); persistState(); respond({ ok: true }); }
        else respond({ ok: false, error: 'Terminal not found' });
        break;
      }

      case 'rename': {
        const t = ptyManager.resolve(msg.target || msg.id);
        if (t && msg.name) { ptyManager.rename(t.id, msg.name); broadcast({ type: 'terminal:renamed', payload: { id: t.id, name: msg.name } }); persistState(); respond({ ok: true }); }
        else respond({ ok: false, error: 'Terminal not found or name missing' });
        break;
      }

      case 'browser-snapshot': {
        fetch(msg.url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Termates/1.0)' } })
          .then(r => r.text())
          .then(html => { const text = html.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(); respond({ ok: true, url: msg.url, text: text.substring(0, 20000) }); })
          .catch(err => respond({ ok: false, error: err.message }));
        return;
      }

      default:
        respond({ ok: false, error: `Unknown command: ${msg.command}` });
    }
  } catch (err) {
    console.error(`CLI error (${msg.command}):`, err);
    respond({ ok: false, error: err.message || 'Internal error' });
  }
}

/**
 * Create a Unix domain socket server for CLI commands.
 * @param {string} socketPath
 * @param {object} ctx - shared context object
 * @returns {net.Server}
 */
export function setupCliSocket(socketPath, ctx) {
  // Clean up stale socket file
  try { if (fs.existsSync(socketPath)) fs.unlinkSync(socketPath); } catch (e) { /* ignore */ }

  const unixServer = net.createServer((socket) => {
    let buf = '';
    socket.on('data', (chunk) => {
      buf += chunk.toString();
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        if (line.trim()) {
          try { handleCliCommand(socket, JSON.parse(line), ctx); } catch (e) { socket.write(JSON.stringify({ ok: false, error: 'Invalid JSON' }) + '\n'); }
        }
      }
      if (buf.trim()) {
        try { const m = JSON.parse(buf); buf = ''; handleCliCommand(socket, m, ctx); } catch (e) { /* wait */ }
      }
    });
    socket.on('error', () => {});
  });

  unixServer.listen(socketPath, () => {
    try { fs.chmodSync(socketPath, 0o666); } catch (e) {}
  });

  return unixServer;
}
