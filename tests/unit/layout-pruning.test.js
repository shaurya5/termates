import { describe, it, expect } from 'vitest';

// ---------------------------------------------------------------------------
// Pure layout-tree functions extracted from src/client/main.js.
//
// These are intentionally re-implemented here (not imported) because main.js
// is compiled as a browser IIFE bundle and cannot be imported directly in a
// Node/Vitest environment.  The implementations are identical to the source.
// ---------------------------------------------------------------------------

/**
 * Remove a single terminal ID from a layout tree.
 * When a split loses one child, it collapses to the remaining child.
 */
function removeFromLayoutTree(layout, id) {
  if (!layout) return null;
  if (layout.type === 'leaf') return layout.panelId === id ? null : layout;
  if (layout.type === 'split') {
    const l = removeFromLayoutTree(layout.children[0], id);
    const r = removeFromLayoutTree(layout.children[1], id);
    if (!l && !r) return null;
    if (!l) return r;
    if (!r) return l;
    return { ...layout, children: [l, r] };
  }
  return layout;
}

/**
 * Prune a layout tree so that only leaves whose panelId is in validIds survive.
 * Split nodes that end up with one valid child collapse to that child.
 * Split nodes with zero valid children return null.
 */
function pruneLayout(node, validIds) {
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
 */
function collectLayoutIds(node) {
  const ids = new Set();
  (function walk(n) {
    if (!n) return;
    if (n.type === 'leaf') ids.add(n.panelId);
    if (n.type === 'split') { walk(n.children[0]); walk(n.children[1]); }
  })(node);
  return ids;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function leaf(id) {
  return { type: 'leaf', panelId: id };
}

function split(left, right, direction = 'horizontal', ratio = 0.5) {
  return { type: 'split', direction, ratio, children: [left, right] };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('pruneLayout(layout, validIds)', () => {

  // -------------------------------------------------------------------------
  // Leaf nodes
  // -------------------------------------------------------------------------

  describe('leaf nodes', () => {
    it('single leaf with valid ID returns the leaf unchanged', () => {
      const node = leaf('t1');
      const result = pruneLayout(node, new Set(['t1']));
      expect(result).toEqual(node);
    });

    it('single leaf with invalid ID returns null', () => {
      const node = leaf('t1');
      const result = pruneLayout(node, new Set(['t2']));
      expect(result).toBeNull();
    });

    it('leaf with empty validIds set returns null', () => {
      expect(pruneLayout(leaf('t1'), new Set())).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // null / undefined input
  // -------------------------------------------------------------------------

  describe('null / undefined input', () => {
    it('null layout returns null', () => {
      expect(pruneLayout(null, new Set(['t1']))).toBeNull();
    });

    it('null layout with empty validIds returns null', () => {
      expect(pruneLayout(null, new Set())).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // Splits with one invalid child
  // -------------------------------------------------------------------------

  describe('split where one child is invalid', () => {
    it('collapses to the valid left child when right child is invalid', () => {
      const node = split(leaf('t1'), leaf('t2'));
      const result = pruneLayout(node, new Set(['t1']));
      expect(result).toEqual(leaf('t1'));
    });

    it('collapses to the valid right child when left child is invalid', () => {
      const node = split(leaf('t1'), leaf('t2'));
      const result = pruneLayout(node, new Set(['t2']));
      expect(result).toEqual(leaf('t2'));
    });

    it('collapsed result is a leaf, not a split', () => {
      const node = split(leaf('t1'), leaf('t2'));
      const result = pruneLayout(node, new Set(['t1']));
      expect(result?.type).toBe('leaf');
    });
  });

  // -------------------------------------------------------------------------
  // Splits where both children are invalid
  // -------------------------------------------------------------------------

  describe('split where both children are invalid', () => {
    it('returns null when neither leaf is in validIds', () => {
      const node = split(leaf('t1'), leaf('t2'));
      const result = pruneLayout(node, new Set(['t99']));
      expect(result).toBeNull();
    });

    it('returns null for a split of two invalid leaves even with other valid ids present', () => {
      const node = split(leaf('t1'), leaf('t2'));
      const result = pruneLayout(node, new Set(['t3', 't4']));
      expect(result).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // Splits where both children are valid
  // -------------------------------------------------------------------------

  describe('split where both children are valid', () => {
    it('returns the original split structure unchanged when both children are valid', () => {
      const node = split(leaf('t1'), leaf('t2'));
      const result = pruneLayout(node, new Set(['t1', 't2']));
      expect(result).toEqual(node);
    });

    it('preserves direction and ratio on the surviving split node', () => {
      const node = split(leaf('t1'), leaf('t2'), 'vertical', 0.3);
      const result = pruneLayout(node, new Set(['t1', 't2']));
      expect(result?.direction).toBe('vertical');
      expect(result?.ratio).toBe(0.3);
    });
  });

  // -------------------------------------------------------------------------
  // Nested splits with mixed valid/invalid leaves
  // -------------------------------------------------------------------------

  describe('nested split with mixed valid/invalid leaves', () => {
    it('deeply nested pruning: only the valid subtree survives', () => {
      // Structure:
      //       root (split)
      //      /            \
      //   left (split)    t4 (leaf, invalid)
      //   /        \
      //  t1 (valid)  t2 (invalid)
      const inner = split(leaf('t1'), leaf('t2'));
      const root = split(inner, leaf('t4'));
      const result = pruneLayout(root, new Set(['t1']));
      expect(result).toEqual(leaf('t1'));
    });

    it('three-way nested split collapses correctly when two of three leaves survive', () => {
      // Structure:
      //       root (split)
      //      /            \
      //   left (split)    t3 (valid)
      //   /       \
      //  t1(valid)  t2(invalid)
      const inner = split(leaf('t1'), leaf('t2'));
      const root = split(inner, leaf('t3'));
      const result = pruneLayout(root, new Set(['t1', 't3']));
      // left branch collapses from split→leaf(t1), right is leaf(t3)
      expect(result?.type).toBe('split');
      const ids = collectLayoutIds(result);
      expect(ids.has('t1')).toBe(true);
      expect(ids.has('t3')).toBe(true);
      expect(ids.has('t2')).toBe(false);
    });

    it('all leaves invalid in a deep tree returns null', () => {
      const deep = split(split(leaf('t1'), leaf('t2')), split(leaf('t3'), leaf('t4')));
      expect(pruneLayout(deep, new Set())).toBeNull();
    });

    it('all leaves valid in a deep tree returns the entire tree', () => {
      const deep = split(split(leaf('t1'), leaf('t2')), split(leaf('t3'), leaf('t4')));
      const result = pruneLayout(deep, new Set(['t1', 't2', 't3', 't4']));
      expect(result).toEqual(deep);
    });
  });
});

// ---------------------------------------------------------------------------

describe('removeFromLayoutTree(layout, id)', () => {
  it('returns null when the only leaf is removed', () => {
    expect(removeFromLayoutTree(leaf('t1'), 't1')).toBeNull();
  });

  it('returns the leaf unchanged when a different id is removed', () => {
    expect(removeFromLayoutTree(leaf('t1'), 't99')).toEqual(leaf('t1'));
  });

  it('null layout returns null regardless of id', () => {
    expect(removeFromLayoutTree(null, 't1')).toBeNull();
  });

  it('split collapses to remaining leaf when left child is removed', () => {
    const node = split(leaf('t1'), leaf('t2'));
    expect(removeFromLayoutTree(node, 't1')).toEqual(leaf('t2'));
  });

  it('split collapses to remaining leaf when right child is removed', () => {
    const node = split(leaf('t1'), leaf('t2'));
    expect(removeFromLayoutTree(node, 't2')).toEqual(leaf('t1'));
  });

  it('split returns null when both leaves match (by removing them sequentially)', () => {
    // Each remove call is independent; to get null we must remove both
    let node = split(leaf('t1'), leaf('t2'));
    node = removeFromLayoutTree(node, 't1');
    node = removeFromLayoutTree(node, 't2');
    expect(node).toBeNull();
  });

  it('removing an id not in the tree leaves the tree unchanged', () => {
    const node = split(leaf('t1'), leaf('t2'));
    expect(removeFromLayoutTree(node, 't99')).toEqual(node);
  });

  it('nested removal collapses only the affected branch', () => {
    //       root (split)
    //      /            \
    //   left (split)    t3
    //   /        \
    //  t1         t2 ← remove this
    const inner = split(leaf('t1'), leaf('t2'));
    const root = split(inner, leaf('t3'));
    const result = removeFromLayoutTree(root, 't2');
    // left branch collapses to leaf(t1), right stays as leaf(t3)
    expect(result?.type).toBe('split');
    const ids = collectLayoutIds(result);
    expect(ids.has('t1')).toBe(true);
    expect(ids.has('t3')).toBe(true);
    expect(ids.has('t2')).toBe(false);
  });
});

// ---------------------------------------------------------------------------

describe('collectLayoutIds(node)', () => {
  it('returns empty set for null', () => {
    expect(collectLayoutIds(null).size).toBe(0);
  });

  it('returns a set with one id for a single leaf', () => {
    const ids = collectLayoutIds(leaf('t1'));
    expect(ids.has('t1')).toBe(true);
    expect(ids.size).toBe(1);
  });

  it('returns all ids from a flat split', () => {
    const ids = collectLayoutIds(split(leaf('t1'), leaf('t2')));
    expect(ids).toEqual(new Set(['t1', 't2']));
  });

  it('returns all ids from a nested tree', () => {
    const tree = split(split(leaf('t1'), leaf('t2')), leaf('t3'));
    const ids = collectLayoutIds(tree);
    expect(ids).toEqual(new Set(['t1', 't2', 't3']));
  });
});
