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
  // getLinksFor() — used by terminal:destroy to broadcast unlink events
  // -------------------------------------------------------------------------

  describe('getLinksFor()', () => {
    it('returns all link objects involving the terminal', () => {
      lm.link('t1', 't2');
      lm.link('t1', 't3');
      lm.link('t2', 't3');

      const links = lm.getLinksFor('t1');
      expect(links).toHaveLength(2);
    });

    it('returns links where terminal is the "from" side', () => {
      lm.link('t1', 't2');
      const links = lm.getLinksFor('t1');
      expect(links.some(l => l.from === 't1' && l.to === 't2')).toBe(true);
    });

    it('returns links where terminal is the "to" side', () => {
      lm.link('t1', 't2');
      const links = lm.getLinksFor('t2');
      expect(links.some(l => (l.from === 't2' || l.to === 't2'))).toBe(true);
    });

    it('returns empty array when terminal has no links', () => {
      lm.link('t1', 't2');
      expect(lm.getLinksFor('t99')).toEqual([]);
    });

    it('returns empty array when no links exist', () => {
      expect(lm.getLinksFor('t1')).toEqual([]);
    });

    it('each link object has from, to, and createdAt fields', () => {
      lm.link('t1', 't2');
      const links = lm.getLinksFor('t1');
      expect(links[0]).toHaveProperty('from');
      expect(links[0]).toHaveProperty('to');
      expect(links[0]).toHaveProperty('createdAt');
      expect(typeof links[0].createdAt).toBe('number');
    });
  });

  // -------------------------------------------------------------------------
  // Shared Notes
  // -------------------------------------------------------------------------

  describe('Shared Notes', () => {
    it('createNote() creates a note with an ID', () => {
      const note = lm.createNote('My Note', 'content here');
      expect(note.id).toBe('n1');
      expect(note.title).toBe('My Note');
      expect(note.content).toBe('content here');
    });

    it('getNote() retrieves a created note', () => {
      const note = lm.createNote('Test', 'body');
      expect(lm.getNote(note.id)).toBe(note);
    });

    it('getNote() returns null for non-existent note', () => {
      expect(lm.getNote('n999')).toBeNull();
    });

    it('updateNote() changes content and returns true', () => {
      const note = lm.createNote('Test', 'old');
      expect(lm.updateNote(note.id, 'new')).toBe(true);
      expect(lm.getNote(note.id).content).toBe('new');
    });

    it('updateNote() returns false for non-existent note', () => {
      expect(lm.updateNote('n999', 'content')).toBe(false);
    });

    it('linkNoteToTerminal() associates note with terminal', () => {
      const note = lm.createNote('Test', 'body');
      expect(lm.linkNoteToTerminal(note.id, 't1')).toBe(true);
      const notes = lm.getNotesForTerminal('t1');
      expect(notes).toHaveLength(1);
      expect(notes[0].id).toBe(note.id);
    });

    it('linkNoteToTerminal() returns false for non-existent note', () => {
      expect(lm.linkNoteToTerminal('n999', 't1')).toBe(false);
    });

    it('getNotesForTerminal() returns empty for unlinked terminal', () => {
      lm.createNote('Test', 'body');
      expect(lm.getNotesForTerminal('t99')).toEqual([]);
    });

    it('removeTerminal() cleans up note associations', () => {
      const note = lm.createNote('Test', 'body');
      lm.linkNoteToTerminal(note.id, 't1');
      lm.removeTerminal('t1');
      expect(lm.getNotesForTerminal('t1')).toEqual([]);
    });

    it('listNotes() returns all notes with their linked terminals', () => {
      const n1 = lm.createNote('Note1', 'body1');
      const n2 = lm.createNote('Note2', 'body2');
      lm.linkNoteToTerminal(n1.id, 't1');

      const notes = lm.listNotes();
      expect(notes).toHaveLength(2);
      const first = notes.find(n => n.id === n1.id);
      expect(first.linkedTerminals).toContain('t1');
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

    it('each link has from, to, and createdAt fields', () => {
      lm.link('t1', 't2');
      const links = lm.listAll();
      expect(links[0]).toHaveProperty('from');
      expect(links[0]).toHaveProperty('to');
      expect(links[0]).toHaveProperty('createdAt');
    });
  });
});
