export class LinkManager {
  constructor() {
    // key: "idA:idB" (sorted), value: { from, to, createdAt }
    this.links = new Map();
    // Shared notes between linked terminals
    this.notes = new Map(); // noteId -> { id, title, content, linkedTerminals: Set }
    this.nextNoteId = 1;
  }

  _key(a, b) {
    return [a, b].sort().join(':');
  }

  link(from, to) {
    if (from === to) return false;
    const key = this._key(from, to);
    if (this.links.has(key)) return false;
    this.links.set(key, { from, to, createdAt: Date.now() });
    return true;
  }

  unlink(from, to) {
    const key = this._key(from, to);
    return this.links.delete(key);
  }

  areLinked(a, b) {
    return this.links.has(this._key(a, b));
  }

  getLinkedTerminals(id) {
    const result = [];
    for (const link of this.links.values()) {
      if (link.from === id) result.push(link.to);
      else if (link.to === id) result.push(link.from);
    }
    return result;
  }

  getLinksFor(id) {
    const result = [];
    for (const link of this.links.values()) {
      if (link.from === id || link.to === id) {
        result.push(link);
      }
    }
    return result;
  }

  removeTerminal(id) {
    const keysToDelete = [];
    for (const [key, link] of this.links) {
      if (link.from === id || link.to === id) {
        keysToDelete.push(key);
      }
    }
    for (const key of keysToDelete) {
      this.links.delete(key);
    }
    // Remove from notes
    for (const note of this.notes.values()) {
      note.linkedTerminals.delete(id);
    }
    return keysToDelete.length;
  }

  listAll() {
    return Array.from(this.links.values());
  }

  // --- Shared Notes ---

  createNote(title, content = '') {
    const id = `n${this.nextNoteId++}`;
    const note = { id, title, content, linkedTerminals: new Set(), createdAt: Date.now() };
    this.notes.set(id, note);
    return note;
  }

  getNote(id) {
    return this.notes.get(id) || null;
  }

  updateNote(id, content) {
    const note = this.notes.get(id);
    if (note) {
      note.content = content;
      return true;
    }
    return false;
  }

  linkNoteToTerminal(noteId, terminalId) {
    const note = this.notes.get(noteId);
    if (note) {
      note.linkedTerminals.add(terminalId);
      return true;
    }
    return false;
  }

  getNotesForTerminal(terminalId) {
    const result = [];
    for (const note of this.notes.values()) {
      if (note.linkedTerminals.has(terminalId)) {
        result.push({
          id: note.id,
          title: note.title,
          content: note.content,
        });
      }
    }
    return result;
  }

  listNotes() {
    return Array.from(this.notes.values()).map(n => ({
      id: n.id,
      title: n.title,
      linkedTerminals: [...n.linkedTerminals],
    }));
  }
}
