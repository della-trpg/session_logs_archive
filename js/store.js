/*
 * 기록 데이터 저장소
 *  - 데모 모드: 예시 JSON + 이 브라우저에 저장된 '원본과 다른 곳'(localStorage)
 *  - 서버 모드: commit() 하나 = 서버 함수 log_apply 호출 하나 (바뀐 줄만). 순서대로 보내고, 실패하면 다시 시도
 *
 * 모든 수정은 commit(label, changes) 하나로 들어온다.
 *   changes = { entries: [줄 객체(전체)], speakers: [...], sessions: [...], book: {제목 등 일부} }
 *   새 줄은 아직 없는 id로, 지우기는 deleted: true 로(휴지통). 되돌리기는 이전 모습을 그대로 다시 넣음.
 */
(function (g) {
  'use strict';
  const SL = (g.SL = g.SL || {});
  const clone = (o) => (o == null ? o : JSON.parse(JSON.stringify(o)));
  const BOOK_FIELDS = ['title', 'system', 'gm', 'players', 'period', 'diceLabels', 'visibility'];

  function Store() {
    this.book = null;
    this.undoStack = [];
    this.redoStack = [];
    this.listeners = new Set();
    this.saveTimer = 0;
    this.saveError = null;
    this.pending = [];       // 서버로 보낼 수정들 (순서대로)
    this.flushing = false;
  }

  /** 기록 열기. api는 js/api.js의 DemoApi 또는 SupabaseApi */
  Store.prototype.open = async function ({ api, bookId, isAdmin }) {
    const res = await api.loadBook(bookId, { admin: isAdmin });
    this.api = api; this.bookId = bookId; this.isAdmin = !!isAdmin; this.meta = res.meta;
    this.mode = api.demo ? 'demo' : 'server';
    this.base = res.book;
    this.baseIdx = null;
    this.key = 'sl:edits:' + bookId;
    this.book = clone(this.base);
    this.undoStack = []; this.redoStack = []; this.pending = []; this.saveError = null;
    this.ov = { entries: {}, speakers: {}, sessions: {}, book: {} };
    if (this.mode === 'demo') this.applyOverrides(this.loadOverrides());
    this.reindex();
    return this.book;
  };

  // ── 데모: 이 브라우저에 남긴 수정 ──
  Store.prototype.loadOverrides = function () {
    try { return JSON.parse(localStorage.getItem(this.key) || 'null'); } catch (e) { return null; }
  };
  Store.prototype.applyOverrides = function (ov) {
    this.ov = { entries: {}, speakers: {}, sessions: {}, book: {} };
    if (!ov) return;
    const b = this.book;
    Object.entries(ov.entries || {}).forEach(([id, e]) => this.putEntry(id, e));
    Object.values(ov.speakers || {}).forEach((s) => { const i = b.speakers.findIndex((x) => x.id === s.id); if (i >= 0) b.speakers[i] = s; });
    Object.values(ov.sessions || {}).forEach((s) => { const i = b.sessions.findIndex((x) => x.no === s.no); if (i >= 0) b.sessions[i] = s; else b.sessions.push(s); });
    Object.assign(b, ov.book || {});
    this.ov = { entries: ov.entries || {}, speakers: ov.speakers || {}, sessions: ov.sessions || {}, book: ov.book || {} };
  };
  // 원본과 같아진 것(되돌렸거나 제자리로 돌아온 줄)은 수정 목록에서 뺀다
  Store.prototype.prune = function () {
    if (!this.baseIdx) {
      this.baseIdx = {
        entries: new Map(this.base.entries.map((e) => [e.id, JSON.stringify(e)])),
        speakers: new Map(this.base.speakers.map((s) => [s.id, JSON.stringify(s)])),
        sessions: new Map(this.base.sessions.map((s) => [String(s.no), JSON.stringify(s)])),
      };
    }
    ['entries', 'speakers', 'sessions'].forEach((k) => {
      const m = this.ov[k];
      Object.keys(m).forEach((id) => {
        const b = this.baseIdx[k].get(String(id));
        if ((b == null && m[id] == null) || (b != null && b === JSON.stringify(m[id]))) delete m[id];
      });
    });
    Object.keys(this.ov.book).forEach((k) => {
      if (JSON.stringify(this.ov.book[k]) === JSON.stringify(this.base[k] === undefined ? null : this.base[k])) delete this.ov.book[k];
    });
  };
  Store.prototype.scheduleSave = function (set) {
    if (this.mode === 'server') { if (set) this.enqueue(set); return; }
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.prune();
      try { localStorage.setItem(this.key, JSON.stringify(this.ov)); this.saveError = null; } catch (e) { this.saveError = e; }
      this.emit({ saved: !this.saveError });
    }, 300);
  };

  // ── 서버: 바뀐 것만 log_apply로 ──
  const stripSpeaker = (s) => { if (!s) return s; const c = Object.assign({}, s); delete c.imageUrl; return c; };
  Store.prototype.payloadOf = function (set) {
    const p = {};
    const ents = set.entries || [];
    if (ents.length) {
      p.entries = ents.filter(([, e]) => e).map(([, e]) => e);
      const rm = ents.filter(([, e]) => !e).map(([id]) => id);
      if (rm.length) p.removeEntries = rm;
    }
    const sps = set.speakers || [];
    if (sps.length) {
      p.speakers = sps.filter(([, x]) => x).map(([, x]) => stripSpeaker(x));
      const rm = sps.filter(([, x]) => !x).map(([id]) => id);
      if (rm.length) p.removeSpeakers = rm;
    }
    const ses = set.sessions || [];
    if (ses.length) {
      p.sessions = ses.filter(([, x]) => x).map(([, x]) => x);
      const rm = ses.filter(([, x]) => !x).map(([no]) => no);
      if (rm.length) p.removeSessions = rm;
    }
    if (set.book) p.book = set.book;
    return p;
  };
  Store.prototype.enqueue = function (set) {
    const p = this.payloadOf(set);
    // 한 번에 2000줄까지 → 나눠 보냄
    const ents = p.entries || [];
    if (ents.length > 1500) {
      for (let i = 0; i < ents.length; i += 1500) this.pending.push(i === 0 ? Object.assign({}, p, { entries: ents.slice(0, 1500) }) : { entries: ents.slice(i, i + 1500) });
    } else this.pending.push(p);
    this.flush();
  };
  Store.prototype.flush = async function () {
    if (this.flushing) return;
    this.flushing = true;
    this.emit({ saving: true });
    while (this.pending.length) {
      try {
        await this.api.apply(this.bookId, this.pending[0]);
        this.pending.shift();
        this.saveError = null;
      } catch (e) {
        this.saveError = e;
        this.flushing = false;
        this.emit({ saved: false });
        return;
      }
    }
    this.flushing = false;
    this.emit({ saved: true });
  };
  Store.prototype.retry = function () { this.saveError = null; this.flush(); };
  Store.prototype.saveState = function () {
    if (this.saveError) return 'error';
    if (this.pending.length || this.flushing) return 'saving';
    return 'saved';
  };

  Store.prototype.hasLocalEdits = function () {
    const o = this.ov || {};
    return ['entries', 'speakers', 'sessions', 'book'].some((k) => o[k] && Object.keys(o[k]).length);
  };
  Store.prototype.resetLocal = function () {
    if (this.mode !== 'demo') return;
    try { localStorage.removeItem(this.key); } catch (e) { /* 무시 */ }
    this.book = clone(this.base); this.ov = { entries: {}, speakers: {}, sessions: {}, book: {} };
    clearTimeout(this.saveTimer);
    this.undoStack = []; this.redoStack = [];
    this.reindex(); this.emit({ reset: true });
  };

  // ── 색인 ──
  Store.prototype.reindex = function () {
    const b = this.book;
    b.sessions.sort((x, y) => x.no - y.no);
    this.byId = new Map(b.entries.map((e) => [e.id, e]));
    this.spk = new Map(b.speakers.map((s) => [s.id, s]));
    this.bySession = new Map(b.sessions.map((s) => [s.no, []]));
    b.entries.slice().sort((x, y) => x.seq - y.seq).forEach((e) => {
      if (!this.bySession.has(e.session)) this.bySession.set(e.session, []);
      this.bySession.get(e.session).push(e);
    });
    this.maxId = b.entries.reduce((m, e) => Math.max(m, Number(String(e.id).replace(/\D/g, '')) || 0), 0);
  };
  Store.prototype.entries = function (no, withDeleted) {
    return (this.bySession.get(no) || []).filter((e) => withDeleted || !e.deleted);
  };
  Store.prototype.allEntries = function (withDeleted) {
    const out = [];
    this.book.sessions.forEach((s) => out.push(...this.entries(s.no, withDeleted)));
    return out;
  };
  Store.prototype.newId = function () { this.maxId += 1; return 'e' + this.maxId; };

  // ── 적용 ──
  Store.prototype.putEntry = function (id, e) {
    const b = this.book;
    const i = b.entries.findIndex((x) => x.id === id);
    if (e == null) { if (i >= 0) b.entries.splice(i, 1); return; }
    if (i >= 0) b.entries[i] = e; else b.entries.push(e);
  };
  Store.prototype.apply = function (set, record) {
    const b = this.book;
    if (this.mode !== 'demo') record = false;
    (set.entries || []).forEach(([id, e]) => { this.putEntry(id, clone(e)); if (record) this.ov.entries[id] = clone(e); });
    (set.speakers || []).forEach(([id, s]) => {
      const i = b.speakers.findIndex((x) => x.id === id);
      if (s == null) { if (i >= 0) b.speakers.splice(i, 1); } else if (i >= 0) b.speakers[i] = clone(s); else b.speakers.push(clone(s));
      if (record) this.ov.speakers[id] = clone(s);
    });
    (set.sessions || []).forEach(([no, s]) => {
      const i = b.sessions.findIndex((x) => x.no === no);
      if (s == null) { if (i >= 0) b.sessions.splice(i, 1); } else if (i >= 0) b.sessions[i] = clone(s); else b.sessions.push(clone(s));
      if (record) this.ov.sessions[no] = clone(s);
    });
    if (set.book) { Object.assign(b, clone(set.book)); if (record) Object.assign(this.ov.book, clone(set.book)); }
  };

  /** 수정 하나 (되돌리기 한 칸) */
  Store.prototype.commit = function (label, ch) {
    const b = this.book;
    const before = { entries: [], speakers: [], sessions: [], book: null };
    const after = { entries: [], speakers: [], sessions: [], book: null };
    (ch.entries || []).forEach((e) => { before.entries.push([e.id, clone(this.byId.get(e.id) || null)]); after.entries.push([e.id, clone(e)]); });
    (ch.removeEntries || []).forEach((id) => { before.entries.push([id, clone(this.byId.get(id) || null)]); after.entries.push([id, null]); });
    (ch.speakers || []).forEach((s) => { before.speakers.push([s.id, clone(this.spk.get(s.id) || null)]); after.speakers.push([s.id, clone(s)]); });
    (ch.sessions || []).forEach((s) => { before.sessions.push([s.no, clone(b.sessions.find((x) => x.no === s.no) || null)]); after.sessions.push([s.no, clone(s)]); });
    if (ch.book) {
      before.book = {}; Object.keys(ch.book).forEach((k) => { if (BOOK_FIELDS.includes(k)) before.book[k] = clone(b[k] === undefined ? null : b[k]); });
      after.book = clone(ch.book);
    }
    this.apply(after, true);
    this.undoStack.push({ label, before, after });
    if (this.undoStack.length > 200) this.undoStack.shift();
    this.redoStack = [];
    this.reindex();
    this.scheduleSave(after);
    this.emit({ label, op: { before, after } });
  };
  Store.prototype.undo = function () {
    const op = this.undoStack.pop(); if (!op) return null;
    this.apply(op.before, true); this.redoStack.push(op);
    this.reindex(); this.scheduleSave(op.before); this.emit({ label: op.label, undo: true, op: { before: op.after, after: op.before } });
    return op.label;
  };
  Store.prototype.redo = function () {
    const op = this.redoStack.pop(); if (!op) return null;
    this.apply(op.after, true); this.undoStack.push(op);
    this.reindex(); this.scheduleSave(op.after); this.emit({ label: op.label, redo: true, op });
    return op.label;
  };

  /** 수정 건수 (이 브라우저에 남은 것) */
  Store.prototype.editCount = function () {
    const o = this.ov || {};
    return Object.keys(o.entries || {}).length + Object.keys(o.speakers || {}).length + Object.keys(o.sessions || {}).length + Object.keys(o.book || {}).length;
  };

  Store.prototype.on = function (fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); };
  Store.prototype.emit = function (ev) { this.listeners.forEach((fn) => { try { fn(ev); } catch (e) { console.error(e); } }); };

  SL.Store = Store;
  SL.clone = clone;
})(typeof window !== 'undefined' ? window : globalThis);
