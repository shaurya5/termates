import {
  buildBalancedLayout,
  collectLayoutIds,
  pruneLayout,
  removeLayoutLeaf,
} from '../../shared/layout-tree.js';

export function removeTerminalFromWorkspaceState(workspaces, terminalId) {
  return workspaces.map((ws) => {
    const terminalIds = (ws.terminalIds || []).filter((id) => id !== terminalId);
    const links = (ws.links || []).filter((link) => link.from !== terminalId && link.to !== terminalId);
    let layout = ws.layout ? removeLayoutLeaf(ws.layout, terminalId) : null;

    if (terminalIds.length === 0) layout = null;

    return { ...ws, terminalIds, links, layout };
  });
}

export function reconcileWorkspacesWithTerminals(workspaces, terminals, activeWorkspaceId) {
  const liveTerminalIds = terminals.map((terminal) => terminal.id);
  const liveIds = new Set(liveTerminalIds);

  const nextWorkspaces = workspaces.map((ws) => {
    const terminalIds = (ws.terminalIds || []).filter((id) => liveIds.has(id));
    const links = (ws.links || []).filter((link) => liveIds.has(link.from) && liveIds.has(link.to));
    let layout = ws.layout ? pruneLayout(ws.layout, new Set(terminalIds)) : null;

    if (!layout && terminalIds.length > 0) {
      layout = buildBalancedLayout(terminalIds);
    }

    return { ...ws, terminalIds, links, layout };
  });

  const assignedIds = new Set(nextWorkspaces.flatMap((ws) => ws.terminalIds || []));
  const orphanIds = liveTerminalIds.filter((id) => !assignedIds.has(id));
  if (orphanIds.length === 0 || nextWorkspaces.length === 0) return nextWorkspaces;

  const activeIndex = nextWorkspaces.findIndex((ws) => ws.id === activeWorkspaceId);
  const targetIndex = activeIndex >= 0 ? activeIndex : 0;
  const targetWorkspace = nextWorkspaces[targetIndex];
  const terminalIds = [...targetWorkspace.terminalIds];

  for (const id of orphanIds) {
    if (!terminalIds.includes(id)) terminalIds.push(id);
  }

  let layout = targetWorkspace.layout;
  if (!layout && terminalIds.length > 0) {
    layout = buildBalancedLayout(terminalIds);
  } else if (layout) {
    const layoutIds = collectLayoutIds(layout);
    if (terminalIds.some((id) => !layoutIds.has(id))) {
      layout = buildBalancedLayout(terminalIds);
    }
  }

  nextWorkspaces[targetIndex] = { ...targetWorkspace, terminalIds, layout };
  return nextWorkspaces;
}
