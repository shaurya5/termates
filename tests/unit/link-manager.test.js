import { describe, it, expect, beforeEach } from 'vitest';
import { LinkManager } from '../../server/link-manager.js';

describe('LinkManager', () => {
  let lm;

  beforeEach(() => {
    lm = new LinkManager();
  });

  // -------------------------------------------------------------------------
  // link()
  // -------------------------------------------------------------------------

  describe('link()', () => {
    it('creates a link and returns true', () => {
      expect(lm.link('t1', 't2')).toBe(true);
    });

    it('duplicate link with the same pair (same order) returns false', () => {
      lm.link('t1', 't2');
      expect(lm.link('t1', 't2')).toBe(false);
    });

    it('duplicate link with reversed pair (t2→t1 after t1→t2) returns false', () => {
      lm.link('t1', 't2');
      expect(lm.link('t2', 't1')).toBe(false);
    });

    it('self-link returns false', () => {
      expect(lm.link('t1', 't1')).toBe(false);
    });

    it('can link different pairs independently', () => {
      expect(lm.link('t1', 't2')).toBe(true);
      expect(lm.link('t1', 't3')).toBe(true);
      expect(lm.link('t2', 't3')).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // unlink()
  // -------------------------------------------------------------------------

  describe('unlink()', () => {
    it('removes an existing link and returns true', () => {
      lm.link('t1', 't2');
      expect(lm.unlink('t1', 't2')).toBe(true);
    });

    it('after unlink(), the pair is no longer linked', () => {
      lm.link('t1', 't2');
      lm.unlink('t1', 't2');
      expect(lm.areLinked('t1', 't2')).toBe(false);
    });

    it('unlink() with reversed order also removes the link', () => {
      lm.link('t1', 't2');
      expect(lm.unlink('t2', 't1')).toBe(true);
      expect(lm.areLinked('t1', 't2')).toBe(false);
    });

    it('unlink() on a non-existent pair returns false', () => {
      expect(lm.unlink('t99', 't100')).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // areLinked()
  // -------------------------------------------------------------------------

  describe('areLinked()', () => {
    it('returns true for a linked pair', () => {
      lm.link('t1', 't2');
      expect(lm.areLinked('t1', 't2')).toBe(true);
    });

    it('is symmetric: areLinked(a,b) equals areLinked(b,a)', () => {
      lm.link('t1', 't2');
      expect(lm.areLinked('t2', 't1')).toBe(true);
    });

    it('returns false for a pair that was never linked', () => {
      expect(lm.areLinked('t1', 't2')).toBe(false);
    });

    it('returns false after the link was removed', () => {
      lm.link('t1', 't2');
      lm.unlink('t1', 't2');
      expect(lm.areLinked('t1', 't2')).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // getLinkedTerminals()
  // -------------------------------------------------------------------------

  describe('getLinkedTerminals()', () => {
    it('returns the IDs of all terminals linked to a given terminal', () => {
      lm.link('t1', 't2');
      lm.link('t1', 't3');

      const linked = lm.getLinkedTerminals('t1');
      expect(linked).toHaveLength(2);
      expect(linked).toContain('t2');
      expect(linked).toContain('t3');
    });

    it('works symmetrically: linked terminal also reports the original', () => {
      lm.link('t1', 't2');
      const linked = lm.getLinkedTerminals('t2');
      expect(linked).toContain('t1');
    });

    it('returns an empty array for a terminal with no links', () => {
      expect(lm.getLinkedTerminals('t99')).toEqual([]);
    });

    it('does not return a terminal as linked to itself', () => {
      lm.link('t1', 't2');
      expect(lm.getLinkedTerminals('t1')).not.toContain('t1');
    });
  });

  // -------------------------------------------------------------------------
  // removeTerminal()
  // -------------------------------------------------------------------------

  describe('removeTerminal()', () => {
    it('removes all links for a terminal and returns the count', () => {
      lm.link('t1', 't2');
      lm.link('t1', 't3');
      lm.link('t2', 't3');

      const removed = lm.removeTerminal('t1');
      expect(removed).toBe(2); // t1-t2 and t1-t3
    });

    it('remaining links between other terminals are preserved', () => {
      lm.link('t1', 't2');
      lm.link('t2', 't3');

      lm.removeTerminal('t1');
      expect(lm.areLinked('t2', 't3')).toBe(true);
    });

    it('after removeTerminal(), the removed terminal has no linked peers', () => {
      lm.link('t1', 't2');
      lm.link('t1', 't3');

      lm.removeTerminal('t1');
      expect(lm.getLinkedTerminals('t1')).toEqual([]);
    });

    it('no other terminal still reports the removed terminal as linked', () => {
      lm.link('t1', 't2');
      lm.removeTerminal('t1');
      expect(lm.getLinkedTerminals('t2')).not.toContain('t1');
    });

    it('returns 0 when the terminal has no links', () => {
      expect(lm.removeTerminal('t99')).toBe(0);
    });

    it('handles removing a terminal that was only on the "to" side of a link', () => {
      lm.link('t1', 't2');
      const removed = lm.removeTerminal('t2');
      expect(removed).toBe(1);
      expect(lm.areLinked('t1', 't2')).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // listAll()
  // -------------------------------------------------------------------------

  describe('listAll()', () => {
    it('returns all links as an array', () => {
      lm.link('t1', 't2');
      lm.link('t3', 't4');
      expect(lm.listAll()).toHaveLength(2);
    });

    it('returns empty array when there are no links', () => {
      expect(lm.listAll()).toEqual([]);
    });
  });
});
