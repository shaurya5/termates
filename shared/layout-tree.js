/**
 * Pure layout tree functions shared between client and server.
 *
 * A layout is a binary tree where:
 *   - Leaf: { type: 'leaf', panelId: string }
 *   - Split: { type: 'split', direction: 'horizontal'|'vertical', ratio: number, children: [LayoutNode, LayoutNode] }
 *
 * All functions are pure — no side effects, no DOM, no state.
 * Safe to import in both Node (server/tests) and browser (client bundle).
 */

/**
 * Remove a terminal from a layout tree by panel ID.
 * When a split loses one child, it collapses to the remaining child.
 * @param {object|null} node
 * @param {string} id
 * @returns {object|null}
 */
export function removeLayoutLeaf(node, id) {
  if (!node) return null;
  if (node.type === 'leaf') return node.panelId === id ? null : node;
  if (node.type === 'split') {
    const l = removeLayoutLeaf(node.children[0], id);
    const r = removeLayoutLeaf(node.children[1], id);
    if (!l && !r) return null;
    if (!l) return r;
    if (!r) return l;
    return { ...node, children: [l, r] };
  }
  return node;
}

/**
 * Split a specific leaf in the tree, creating a new split node.
 * @param {object} tree
 * @param {string} targetId - panelId of the leaf to split
 * @param {string} direction - 'horizontal' or 'vertical'
 * @param {object} newLeaf - the new leaf node to insert
 * @returns {object}
 */
export function splitInTree(tree, targetId, direction, newLeaf) {
  if (tree.type === 'leaf' && tree.panelId === targetId)
    return { type: 'split', direction, ratio: 0.5, children: [{ ...tree }, newLeaf] };
  if (tree.type === 'split')
    return { ...tree, children: [
      splitInTree(tree.children[0], targetId, direction, newLeaf),
      splitInTree(tree.children[1], targetId, direction, newLeaf),
    ]};
  return tree;
}

/**
 * Build a balanced binary layout tree from an array of terminal IDs.
 * Alternates split direction at each level.
 * @param {string[]} ids
 * @param {string} direction
 * @returns {object|null}
 */
export function buildBalancedLayout(ids, direction = 'horizontal') {
  if (!ids || ids.length === 0) return null;
  if (ids.length === 1) return { type: 'leaf', panelId: ids[0] };
  const mid = Math.ceil(ids.length / 2);
  const nextDir = direction === 'horizontal' ? 'vertical' : 'horizontal';
  return {
    type: 'split', direction, ratio: 0.5,
    children: [
      buildBalancedLayout(ids.slice(0, mid), nextDir),
      buildBalancedLayout(ids.slice(mid), nextDir),
    ],
  };
}

/**
 * Prune a layout tree so that only leaves whose panelId is in validIds survive.
 * @param {object|null} node
 * @param {Set<string>} validIds
 * @returns {object|null}
 */
export function pruneLayout(node, validIds) {
  if (!node) return null;
  if (node.type === 'leaf') return validIds.has(node.panelId) ? node : null;
  if (node.type === 'split') {
    const l = pruneLayout(node.children[0], validIds);
    const r = pruneLayout(node.children[1], validIds);
    if (!l && !r) return null;
    if (!l) return r;
    if (!r) return l;
    return { ...node, children: [l, r] };
  }
  return null;
}

/**
 * Collect all panelIds present in a layout tree.
 * @param {object|null} node
 * @returns {Set<string>}
 */
export function collectLayoutIds(node) {
  const ids = new Set();
  (function walk(n) {
    if (!n) return;
    if (n.type === 'leaf') ids.add(n.panelId);
    if (n.type === 'split') { walk(n.children[0]); walk(n.children[1]); }
  })(node);
  return ids;
}
