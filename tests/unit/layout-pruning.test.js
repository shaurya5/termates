import { describe, it, expect } from 'vitest';
import {
  removeLayoutLeaf as removeFromLayoutTree,
  pruneLayout,
  collectLayoutIds,
} from '../../shared/layout-tree.js';

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
