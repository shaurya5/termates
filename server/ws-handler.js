import { WebSocketServer, WebSocket } from 'ws';

/**
 * Handle a single parsed WebSocket message.
 * @param {WebSocket} ws - the client connection
 * @param {object} msg - parsed JSON message { type, payload }
 * @param {object} ctx - shared context object
 */
function handleWsMessage(ws, msg, ctx) {
  const { ptyManager, linkManager, stateManager, broadcast, sendTo,
          persistState, addTerminalToWorkspace, removeTerminalFromWorkspaces,
          subscribeTerminalOutput } = ctx;
  const { type, payload } = msg;

  switch (type) {
    case 'terminal:create': {
      const { name, shell, cwd, role, sshTarget, remoteCwd } = payload || {};
      let terminal;
      // Check if active workspace is remote
      const wsState = stateManager.get();
      const activeWsState = wsState.workspaces.find(w => w.id === wsState.activeWorkspaceId);
      if (activeWsState?.sshTarget) {
        // Auto-create as remote terminal using workspace's SSH target
        terminal = ptyManager.createRemote({
          name: name || `Terminal ${ptyManager.size + 1}`,
          role, sshTarget: activeWsState.sshTarget,
          remoteCwd: remoteCwd || activeWsState.remoteCwd,
        });
      } else if (sshTarget) {
        terminal = ptyManager.createRemote({ name, role, sshTarget, remoteCwd });
      } else {
        // Inherit working directory from workspace if not explicitly set
        const effectiveCwd = cwd || activeWsState?.cwd || undefined;
        terminal = ptyManager.create({ name: name || `Terminal ${ptyManager.size + 1}`, shell, cwd: effectiveCwd, role });
      }
      subscribeTerminalOutput(terminal);
      addTerminalToWorkspace(terminal.id);
      broadcast({
        type: 'terminal:created',
        payload: { id: terminal.id, name: terminal.name, role: terminal.role, status: terminal.status },
      });
      persistState();
      break;
    }

    case 'terminal:input': {
      // Strip DA query/response escape sequences that xterm.js sends.
      // These leak into the shell via tmux and cause garbled output.
      const clean = payload.data.replace(/\x1b\[[\?>]?[\d;]*c/g, '');
      if (clean) ptyManager.write(payload.id, clean);
      break;
    }

    case 'terminal:resize': {
      ptyManager.resize(payload.id, payload.cols, payload.rows);
      break;
    }

    case 'terminal:rename': {
      if (ptyManager.rename(payload.id, payload.name)) {
        broadcast({ type: 'terminal:renamed', payload: { id: payload.id, name: payload.name } });
        persistState();
      }
      break;
    }

    case 'terminal:configure': {
      const { id, name, role } = payload;
      if (name !== undefined) ptyManager.rename(id, name);
      if (role !== undefined) ptyManager.setRole(id, role);
      broadcast({ type: 'terminal:configured', payload: { id, name, role } });
      persistState();
      break;
    }

    case 'terminal:destroy': {
      const { id } = payload;
      const removedLinks = linkManager.getLinksFor(id);
      ptyManager.destroy(id);
      linkManager.removeTerminal(id);
      removeTerminalFromWorkspaces(id);
      broadcast({ type: 'terminal:destroyed', payload: { id } });
      for (const link of removedLinks) {
        broadcast({ type: 'terminal:unlinked', payload: { from: link.from, to: link.to } });
      }
      persistState();
      break;
    }

    case 'terminal:link': {
      const { from, to } = payload;
      if (linkManager.link(from, to)) {
        broadcast({ type: 'terminal:linked', payload: { from, to } });
        persistState();
      }
      break;
    }

    case 'terminal:unlink': {
      const { from, to } = payload;
      if (linkManager.unlink(from, to)) {
        broadcast({ type: 'terminal:unlinked', payload: { from, to } });
        persistState();
      }
      break;
    }

    case 'terminal:send-to-linked': {
      const { from, to, text } = payload;
      if (linkManager.areLinked(from, to)) {
        ptyManager.write(to, text);
        broadcast({ type: 'terminal:message-sent', payload: { from, to, text, timestamp: Date.now() } });
      }
      break;
    }

    case 'terminal:status': {
      if (ptyManager.setStatus(payload.id, payload.status)) {
        broadcast({ type: 'terminal:status-changed', payload: { id: payload.id, status: payload.status } });
        persistState();
      }
      break;
    }

    case 'terminal:list': {
      const saved = stateManager.get();
      const termList = ptyManager.list();
      sendTo(ws, {
        type: 'terminal:list',
        payload: {
          terminals: termList,
          workspaces: saved.workspaces || [],
          activeWorkspaceId: saved.activeWorkspaceId || 'w1',
          nextWorkspaceId: saved.nextWorkspaceId || 2,
          browserTabs: saved.browserTabs || [],
          activeBrowserTab: saved.activeBrowserTab || 0,
          browserOpen: saved.browserOpen || false,
          browserWidth: saved.browserWidth || 0.35,
        },
      });
      // Send buffered content for each terminal so restored xterms aren't blank
      for (const t of termList) {
        const term = ptyManager.get(t.id);
        if (term && term.buffer.length > 0) {
          sendTo(ws, { type: 'terminal:output', payload: { id: t.id, data: term.buffer.join('') } });
        }
      }
      break;
    }

    // --- Workspace sync ---
    case 'workspace:update': {
      stateManager.setWorkspaces(payload.workspaces);
      if (payload.activeWorkspaceId !== undefined) stateManager.setActiveWorkspaceId(payload.activeWorkspaceId);
      if (payload.nextWorkspaceId !== undefined) stateManager.setNextWorkspaceId(payload.nextWorkspaceId);
      break;
    }

    case 'browser:update': {
      if (payload.tabs !== undefined) stateManager.setBrowserTabs(payload.tabs);
      if (payload.activeTab !== undefined) stateManager.setActiveBrowserTab(payload.activeTab);
      if (payload.open !== undefined) stateManager.setBrowserOpen(payload.open);
      if (payload.width !== undefined) stateManager.setBrowserWidth(payload.width);
      break;
    }

    default:
      sendTo(ws, { type: 'error', payload: { message: `Unknown type: ${type}` } });
  }
}

/**
 * Create a WebSocketServer on the given HTTP server and wire up the connection handler.
 * Returns the wss instance (needed for broadcast).
 * @param {import('http').Server} httpServer
 * @param {object} ctx
 * @returns {WebSocketServer}
 */
export function setupWebSocket(httpServer, ctx) {
  const wss = new WebSocketServer({ server: httpServer });

  wss.on('connection', (ws) => {
    ws.on('message', (raw) => {
      try {
        handleWsMessage(ws, JSON.parse(raw.toString()), ctx);
      } catch (e) {
        ctx.sendTo(ws, { type: 'error', payload: { message: 'Invalid JSON' } });
      }
    });
  });

  return wss;
}
