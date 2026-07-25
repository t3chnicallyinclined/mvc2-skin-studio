// projects.mjs — named projects + bounded version history, persisted to localStorage.
//
// Pure logic over an injected key/value store (localStorage in the app, a mock in tests), so the
// whole thing is unit-testable headless. localStorage persists across restarts in BOTH a browser
// and the Tauri WebView, so this needs no Rust backend and works identically on every platform.
//
// A "state" is the minimal editable snapshot the editor produces:
//   { active:"PL17", chars:{ "PL17":{palette,painted,zBias}, ... } }
// It holds only the edits (palette diffs + painted parts + layer order) — never sprite or ROM
// bytes — so it stays small and keeping 20+ versions is cheap.
//
// Storage layout:
//   mvc2-sks-projects            -> { currentId, projects: { id: {id,name,created,modified} } }
//   mvc2-sks-project-<id>        -> { id, name, created, modified, state, versions:[{ts,label,state}] }

const IDX = 'mvc2-sks-projects';
const REC = id => `mvc2-sks-project-${id}`;
export const MAX_VERSIONS = 30;

export class ProjectStore {
  constructor({ storage, now, newId } = {}) {
    this.s = storage || (typeof localStorage !== 'undefined' ? localStorage : null);
    this.now = now || (() => Date.now());
    this._seq = 0;
    this.newId = newId || (() => {
      const rnd = (typeof Math !== 'undefined' ? Math.random() : 0);
      return `p_${this.now().toString(36)}_${(this._seq++).toString(36)}${Math.floor(rnd * 1e6).toString(36)}`;
    });
  }

  _get(k, dflt) { try { const v = this.s.getItem(k); return v == null ? dflt : JSON.parse(v); } catch { return dflt; } }
  _set(k, v) { this.s.setItem(k, JSON.stringify(v)); }
  _index() { const ix = this._get(IDX, null); return (ix && ix.projects) ? ix : { currentId: null, projects: {} }; }
  _saveIndex(ix) { this._set(IDX, ix); }
  _touch(id, t) { const ix = this._index(); if (ix.projects[id]) { ix.projects[id].modified = t; this._saveIndex(ix); } }

  // Newest-modified first.
  list() { return Object.values(this._index().projects).sort((a, b) => (b.modified || 0) - (a.modified || 0)); }
  currentId() { return this._index().currentId; }
  setCurrent(id) { const ix = this._index(); ix.currentId = id; this._saveIndex(ix); }
  get(id) { return this._get(REC(id), null); }
  meta(id) { return this._index().projects[id] || null; }

  create(name, state = { active: null, chars: {} }) {
    const ix = this._index();
    const id = this.newId();
    const t = this.now();
    ix.projects[id] = { id, name: name || 'Untitled project', created: t, modified: t };
    ix.currentId = id;
    this._saveIndex(ix);
    this._set(REC(id), { id, name: ix.projects[id].name, created: t, modified: t, state, versions: [] });
    return id;
  }

  // Autosave the live working state onto a project (no new version).
  save(id, state) {
    const rec = this.get(id); if (!rec) return false;
    const t = this.now();
    rec.state = state; rec.modified = t;
    this._set(REC(id), rec);
    this._touch(id, t);
    return true;
  }

  rename(id, name) {
    const ix = this._index(); if (!ix.projects[id]) return false;
    const t = this.now();
    ix.projects[id].name = name; ix.projects[id].modified = t; this._saveIndex(ix);
    const rec = this.get(id); if (rec) { rec.name = name; rec.modified = t; this._set(REC(id), rec); }
    return true;
  }

  remove(id) {
    const ix = this._index();
    if (!ix.projects[id]) return false;
    delete ix.projects[id];
    this._saveIndex(ix);
    try { this.s.removeItem(REC(id)); } catch {}
    // If we deleted the active project, fall back to the newest remaining one.
    const ix2 = this._index();
    if (!ix2.projects[ix2.currentId]) { ix2.currentId = (this.list()[0]?.id) || null; this._saveIndex(ix2); }
    return true;
  }

  // Push a version snapshot (a labeled point-in-time copy of the state), capped to `cap` newest.
  snapshot(id, label, state, cap = MAX_VERSIONS) {
    const rec = this.get(id); if (!rec) return false;
    const t = this.now();
    rec.versions = rec.versions || [];
    rec.versions.push({ ts: t, label: label || 'snapshot', state });
    if (rec.versions.length > cap) rec.versions = rec.versions.slice(rec.versions.length - cap);
    rec.modified = t;
    this._set(REC(id), rec);
    this._touch(id, t);
    return t;
  }

  versions(id) { return (this.get(id)?.versions || []).slice().reverse(); }   // newest first
  version(id, ts) { return (this.get(id)?.versions || []).find(v => v.ts === ts) || null; }
}
