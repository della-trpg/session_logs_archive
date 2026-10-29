/*
 * 세션 기록 — 편집 모드 (관리자 전용. 데모에서는 누구나, 이 브라우저에만 저장)
 *
 * 한 줄 = 한 행: [선택] [끌기] [종류] [말한 사람] [글] [표시] [⋯]
 * 모든 수정은 store.commit()으로 → 되돌리기·다시·저장이 한곳에서 처리됨
 */
(function () {
  'use strict';
  const SL = window.SL;
  const A = SL.app;
  const { store, S, el, $ } = A;
  const clone = SL.clone;

  const KIND_OPTS = [
    ['dialogue', '대사'], ['narration', '나레이션'], ['chat', '사담'], ['dice', '주사위'],
    ['system', '진행 표시'], ['scene', '장면 제목'], ['meta', '회차 카드 (숨김)'], ['whisper', '귓속말 (숨김)'],
  ];
  const KIND_NAME = Object.fromEntries(KIND_OPTS.map(([k, v]) => [k, v.replace(/ \(숨김\)/, '')]));
  const ROLE_OPTS = [['pc', 'PC'], ['npc', 'NPC'], ['gm', 'GM'], ['pl', '플레이어']];

  const E = (SL.editor = {
    active: false,
    sel: new Set(),
    anchor: null,       // Shift 범위 선택의 시작
    moving: false,      // '옮기기' 모드
    trash: false,       // 휴지통 보기
    showHidden: A.prefs.get('edit:showHidden', true),
    drag: null,
  });

  const isChar = (s) => s && (s.role === 'pc' || s.role === 'npc');

  // ── 보이기 ──────────────────────────────
  E.rowVisible = function (e) {
    if (E.trash) return !!e.deleted;
    if (e.deleted) return false;
    if (e.kind === 'meta' || e.kind === 'whisper') return E.showHidden;
    if (e.kind === 'scene') return true;
    if (!S.filters[e.kind]) return false;
    if (S.focus && (e.kind === 'dialogue' || e.kind === 'dice' || e.kind === 'chat') && e.speaker !== S.focus) return false;
    return true;
  };
  E.sessionList = function () {
    // 편집 중에는 휴지통에만 줄이 남은 회차도 보여야 함
    return store.book.sessions.filter((s) => store.entries(s.no, true).length);
  };

  // ── 켜기 · 끄기 ─────────────────────────
  E.toggle = function () {
    E.active = !E.active;
    document.body.classList.toggle('editing', E.active);
    $('optEdit').setAttribute('aria-pressed', String(E.active));
    $('optEdit').textContent = E.active ? '편집 끝내기' : '편집하기';
    $('editBar').hidden = !E.active;
    if (!E.active) { E.sel.clear(); E.moving = false; E.trash = false; closeMenu(); }
    updateBulk();
    E.updateBar();
    A.render(true);
  };

  E.updateBar = function () {
    if (!E.active) return;
    $('eUndo').disabled = !store.undoStack.length;
    $('eRedo').disabled = !store.redoStack.length;
    $('eUndo').title = store.undoStack.length ? `되돌리기: ${store.undoStack[store.undoStack.length - 1].label} (Ctrl+Z)` : '되돌릴 것이 없어요';
    $('eRedo').title = store.redoStack.length ? `다시: ${store.redoStack[store.redoStack.length - 1].label} (Ctrl+Shift+Z)` : '다시 할 것이 없어요';
    const st = $('eStatus'); st.replaceChildren();
    if (store.mode === 'demo') {
      const n = store.editCount();
      st.textContent = store.saveError ? '저장하지 못했어요' : n ? `원본과 다른 곳 ${n.toLocaleString()}개 · 이 브라우저에 저장됨` : '원본 그대로';
    } else {
      const s = store.saveState();
      st.classList.toggle('is-error', s === 'error');
      st.append(document.createTextNode(s === 'saving' ? '저장 중…' : s === 'error' ? `저장하지 못했어요 (${store.saveError.message})` : '모두 저장됨'));
      if (s === 'error') { const b = el('button', 'btn-sm', '다시 시도'); b.type = 'button'; b.addEventListener('click', () => store.retry()); st.append(' ', b); }
    }
    $('eDelete').hidden = store.bookId === 'demo';
    const trashN = store.book.entries.filter((e) => e.deleted).length;
    $('eTrash').textContent = E.trash ? '휴지통 닫기' : `휴지통 ${trashN}`;
    $('eTrash').setAttribute('aria-pressed', String(E.trash));
    $('eHidden').setAttribute('aria-pressed', String(E.showHidden));
    $('eReset').hidden = store.mode !== 'demo';
  };

  // ── 그리기 ──────────────────────────────
  E.render = function (sessions) {
    closeMenu();
    const log = $('log'); log.replaceChildren();
    if (E.trash) log.append(el('p', 'edit-note', '휴지통에 있는 줄이에요. 복원하면 원래 자리로 돌아가요.'));
    else if (E.moving) log.append(el('p', 'edit-note is-move', `${E.sel.size}줄을 옮길 자리를 고르세요. 누른 줄 바로 아래로 들어가요. 회차 맨 앞으로 옮기려면 회차 제목 옆 '맨 앞으로'를 누르세요.`));
    let shown = 0;
    sessions.forEach((s) => {
      const sec = sectionFor(s);
      shown += sec.querySelectorAll('.er').length;
      log.append(sec);
    });
    if (!shown) log.append(el('p', 'empty', E.trash ? '휴지통이 비어 있어요.' : '고른 종류에 해당하는 줄이 없어요.'));
  };

  function sectionFor(s) {
    const sec = el('section', 'sess esess'); sec.dataset.no = s.no;
    sec.append(sessionHead(s));
    const frag = document.createDocumentFragment();
    store.entries(s.no, true).filter(E.rowVisible).forEach((e) => frag.append(row(e)));
    sec.append(frag);
    return sec;
  }

  function sessionHead(s) {
    const head = el('header', 'session-head ehead'); head.id = 's' + s.no; head.dataset.no = s.no;
    const t = el('input', 'ehead-title'); t.id = 'sess-title-' + s.no; t.value = A.sessionLabel(s); t.maxLength = 40;
    t.setAttribute('aria-label', '회차 이름');
    t.addEventListener('change', () => {
      const v = t.value.trim(); if (!v || v === A.sessionLabel(s)) { t.value = A.sessionLabel(s); return; }
      const next = clone(s); next.title = v; store.commit(`회차 이름 '${v}'`, { sessions: [next] });
    });
    const d = el('input', 'ehead-date'); d.type = 'date'; d.id = 'sess-date-' + s.no; d.value = s.date || '';
    d.setAttribute('aria-label', '회차 날짜');
    d.addEventListener('change', () => {
      const next = clone(s); next.date = d.value || null;
      store.commit(`${A.sessionLabel(s)} 날짜`, { sessions: [next], book: periodFrom(next) });
    });
    const n = store.entries(s.no, true);
    const meta = el('span', 'ehead-n', `${n.filter((e) => !e.deleted).length.toLocaleString()}줄`);
    head.append(t, d, meta);
    if (E.moving) {
      const b = el('button', 'btn-sm', '맨 앞으로'); b.type = 'button';
      b.addEventListener('click', () => moveSelected(s.no, null));
      head.append(b);
    }
    return head;
  }

  // 회차 날짜가 바뀌면 기록 기간도 다시
  function periodFrom(changed) {
    const dates = store.book.sessions.map((x) => (x.no === changed.no ? changed.date : x.date)).filter(Boolean).sort();
    return { period: { start: dates[0] || null, end: dates[dates.length - 1] || null } };
  }

  function speakerChip(e) {
    const s = A.spk(e.speaker);
    const b = el('button', 'er-who'); b.type = 'button';
    b.title = '말한 사람 바꾸기';
    if (s) {
      const d = el('span', 'dot'); d.style.setProperty('--c', s.color); b.append(d, el('span', null, s.name));
    } else b.append(el('span', 'muted', e.kind === 'narration' || e.kind === 'scene' || e.kind === 'system' ? '—' : '없음'));
    return b;
  }

  function diceSummary(e) {
    const d = e.dice || {};
    const bits = [];
    if (d.title) bits.push(d.title);
    if (d.kind === 'pick') bits.push(`${d.domain ? d.domain + ' → ' : ''}${d.pick}`);
    if (d.dice && d.dice.length) bits.push(d.dice.join('·') + (d.mod ? (d.mod > 0 ? ` +${d.mod}` : ` −${Math.abs(d.mod)}`) : '') + (d.sum != null ? ` = ${d.sum}` : ''));
    if (typeof d.target === 'number') bits.push(`목표치 ${d.target}`);
    const r = d.resultOverride === 'none' ? null : d.resultOverride || d.result;
    if (r) bits.push(A.RESULT_LABEL[r] + (d.resultOverride ? ' (직접)' : ''));
    if (d.kind === 'table' && d.tableText) bits.push(d.tableText);
    return bits.join('  ·  ');
  }

  function row(e) {
    const r = el('div', `er k-${e.kind}`); r.id = e.id; r.dataset.id = e.id;
    if (E.sel.has(e.id)) r.classList.add('is-sel');
    const cb = el('input', 'er-check'); cb.type = 'checkbox'; cb.checked = E.sel.has(e.id); cb.setAttribute('aria-label', '이 줄 선택');
    cb.addEventListener('click', (ev) => { ev.stopPropagation(); select(e.id, ev.shiftKey, cb.checked); });
    const h = el('span', 'er-handle', '⠿'); h.title = '끌어서 옮기기'; h.draggable = !E.trash;
    h.addEventListener('dragstart', (ev) => dragStart(ev, e));
    h.addEventListener('dragend', dragEnd);

    const k = el('button', 'er-kind', KIND_NAME[e.kind] || e.kind); k.type = 'button'; k.title = '종류 바꾸기';
    k.addEventListener('click', (ev) => { ev.stopPropagation(); kindMenu(k, [e.id]); });
    const w = speakerChip(e);
    w.addEventListener('click', (ev) => { ev.stopPropagation(); speakerMenu(w, [e.id]); });

    const t = el('div', 'er-text');
    if (e.kind === 'dice') {
      const lab = el('span', 'er-dlabel', A.diceLabel(e.dice || {}));
      t.append(lab, document.createTextNode(' ' + diceSummary(e)));
      t.title = '주사위 카드는 ⋯ 메뉴에서 이름표·판정을 바꿔요';
    } else {
      A.appendText(t, e.text || '');
      if (!e.text) t.append(el('span', 'muted', '(빈 줄)'));
      t.tabIndex = 0; t.title = '눌러서 고치기';
      t.addEventListener('click', () => { if (!E.moving) startEdit(r, e); });
      t.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); startEdit(r, e); } });
    }

    const flags = el('span', 'er-flags');
    if (e.created) flags.append(el('span', 'flag', '새 줄'));
    else if (e.orig != null && e.orig !== e.text) { const f = el('span', 'flag', '수정됨'); f.title = '원문: ' + e.orig; flags.append(f); }
    if (e.uncertain) { const f = el('span', 'flag warn', '화자 확인'); f.title = '나레이션 바로 뒤에 이름 없이 온 줄이라 말한 사람이 애매해요. 확인 후 말한 사람을 정하면 사라져요.'; flags.append(f); }

    const more = el('button', 'er-more', '⋯'); more.type = 'button'; more.setAttribute('aria-label', '이 줄 메뉴');
    more.addEventListener('click', (ev) => { ev.stopPropagation(); rowMenu(more, e); });

    if (E.trash) {
      const rb = el('button', 'btn-sm', '복원'); rb.type = 'button';
      rb.addEventListener('click', () => restore([e.id]));
      r.append(cb, h, k, w, t, flags, rb);
    } else r.append(cb, h, k, w, t, flags, more);

    // 옮기기 모드: 누른 줄 아래로
    r.addEventListener('click', (ev) => {
      if (!E.moving || ev.target.closest('.er-check')) return;
      ev.preventDefault(); moveSelected(e.session, e.id);
    });
    r.addEventListener('dragover', (ev) => dragOver(ev, r));
    r.addEventListener('dragleave', () => r.classList.remove('drop-before', 'drop-after'));
    r.addEventListener('drop', (ev) => drop(ev, r, e));
    return r;
  }

  // ── 바뀐 것만 다시 그리기 ───────────────
  E.onChange = function (ev) {
    E.updateBar();
    const op = ev.op;
    if (!op) { A.render(true); return; }
    if ((op.after.speakers || []).length || op.after.book || (op.after.sessions || []).some(([no, s]) => !s || !store.book.sessions.find((x) => x.no === no))) {
      A.render(true); return;
    }
    const pairs = new Map();
    (op.before.entries || []).forEach(([id, b]) => pairs.set(id, { b }));
    (op.after.entries || []).forEach(([id, a]) => { const p = pairs.get(id) || {}; p.a = a; pairs.set(id, p); });
    let structural = false;
    const touched = new Set();
    pairs.forEach(({ a, b }) => {
      if (!a || !b || a.session !== b.session || a.seq !== b.seq || !!a.deleted !== !!b.deleted || a.kind !== b.kind) structural = true;
      if (a) touched.add(a.session); if (b) touched.add(b.session);
    });
    (op.after.sessions || []).forEach(([no]) => { touched.add(no); });
    if ((op.after.sessions || []).length) structural = true;
    const anchor = A.topVisibleEntry();
    if (!structural) {
      pairs.forEach(({ a }, id) => {
        const old = document.getElementById(id);
        if (!old || !old.classList.contains('er')) return;
        if (a && E.rowVisible(a)) old.replaceWith(row(a)); else old.remove();
      });
    } else {
      if (pairs.size > 400 || touched.size > 3) { A.render(true); return; }
      touched.forEach((no) => {
        const sec = document.querySelector(`.esess[data-no="${no}"]`);
        const s = store.book.sessions.find((x) => x.no === no);
        if (sec && s) sec.replaceWith(sectionFor(s));
        else if (!sec && s && store.entries(no, true).length) { A.render(true); }
      });
    }
    if (anchor) A.restorePlace(anchor);
  };

  // ── 선택 ────────────────────────────────
  function visibleIds() { return Array.from($('log').querySelectorAll('.er')).map((r) => r.dataset.id); }
  function select(id, shift, on) {
    if (shift && E.anchor) {
      const ids = visibleIds(); const i = ids.indexOf(E.anchor); const j = ids.indexOf(id);
      if (i >= 0 && j >= 0) ids.slice(Math.min(i, j), Math.max(i, j) + 1).forEach((x) => E.sel.add(x));
    } else if (on) E.sel.add(id); else E.sel.delete(id);
    E.anchor = id;
    paintSelection();
  }
  function paintSelection() {
    $('log').querySelectorAll('.er').forEach((r) => {
      const on = E.sel.has(r.dataset.id);
      r.classList.toggle('is-sel', on);
      const cb = r.querySelector('.er-check'); if (cb) cb.checked = on;
    });
    updateBulk();
  }
  function clearSel() { E.sel.clear(); E.anchor = null; E.moving = false; paintSelection(); A.render(true); }
  function selectedInOrder() {
    const all = store.allEntries(true);
    return all.filter((e) => E.sel.has(e.id)).map((e) => e.id);
  }

  function updateBulk() {
    document.body.classList.toggle('edit-moving', E.active && E.moving);
    const bar = $('bulkBar');
    const n = E.sel.size;
    bar.hidden = !E.active || !n;
    if (!n) return;
    $('bulkCount').textContent = `${n.toLocaleString()}줄 선택`;
    $('bulkMove').textContent = E.moving ? '옮기기 취소' : '옮기기';
    $('bulkMove').hidden = E.trash;
    $('bulkKind').hidden = E.trash; $('bulkWho').hidden = E.trash; $('bulkDelete').hidden = E.trash;
    $('bulkRestore').hidden = !E.trash;
  }

  // ── 순서값 · 자리 정하기 ─────────────────
  // ids를 회차 no의 afterId 바로 뒤(null이면 회차 맨 앞)에 차례로 놓는 changes를 만든다
  function placeChanges(ids, no, afterId, newEntries) {
    const moving = new Set(ids);
    const order = store.allEntries(true).filter((e) => !moving.has(e.id));
    const items = ids.map((id) => (newEntries && newEntries[id]) || store.byId.get(id));
    // 들어갈 위치(전체 순서 기준)
    let at;
    if (afterId) at = order.findIndex((e) => e.id === afterId) + 1;
    else {
      const sessOrder = store.book.sessions.map((s) => s.no);
      const idx = sessOrder.indexOf(no);
      at = order.findIndex((e) => sessOrder.indexOf(e.session) >= idx);
      if (at < 0) at = order.length;
    }
    const lo = at > 0 ? order[at - 1].seq : 0;
    const hi = at < order.length ? order[at].seq : lo + (items.length + 1) * 1000;
    const changes = [];
    if (hi - lo > items.length) {
      const step = (hi - lo) / (items.length + 1);
      items.forEach((e, i) => { const n = clone(e); n.session = no; n.seq = Math.floor(lo + step * (i + 1)); changes.push(n); });
      return changes;
    }
    // 자리가 모자라면 전체를 1000 간격으로 다시 매김
    const full = order.slice(0, at).concat(items.map((e) => Object.assign(clone(e), { session: no }))).concat(order.slice(at));
    full.forEach((e, i) => {
      const seq = (i + 1) * 1000;
      const isMoved = moving.has(e.id);
      if (isMoved || e.seq !== seq) { const n = isMoved ? e : clone(e); n.seq = seq; changes.push(n); }
    });
    return changes;
  }

  function moveSelected(no, afterId) {
    const ids = selectedInOrder().filter((id) => id !== afterId);
    if (!ids.length) return;
    E.moving = false;
    store.commit(`${ids.length}줄 옮기기`, { entries: placeChanges(ids, no, afterId) });
    A.toast(`${ids.length}줄을 옮겼어요`, { label: '되돌리기', run: () => store.undo() });
    updateBulk();
  }

  // ── 끌어서 옮기기 (PC) ───────────────────
  function dragStart(ev, e) {
    const ids = E.sel.has(e.id) ? selectedInOrder() : [e.id];
    E.drag = { ids };
    ev.dataTransfer.effectAllowed = 'move';
    try { ev.dataTransfer.setData('text/plain', ids.join(',')); } catch (err) { /* 무시 */ }
    document.body.classList.add('dragging');
  }
  function dragEnd() { E.drag = null; document.body.classList.remove('dragging'); $('log').querySelectorAll('.drop-before, .drop-after').forEach((n) => n.classList.remove('drop-before', 'drop-after')); }
  function dragOver(ev, r) {
    if (!E.drag) return;
    ev.preventDefault();
    const rect = r.getBoundingClientRect();
    const after = ev.clientY > rect.top + rect.height / 2;
    r.classList.toggle('drop-after', after); r.classList.toggle('drop-before', !after);
  }
  function drop(ev, r, target) {
    if (!E.drag) return;
    ev.preventDefault();
    const after = r.classList.contains('drop-after');
    const ids = E.drag.ids.filter((id) => id !== target.id);
    dragEnd();
    if (!ids.length) return;
    let afterId = target.id;
    if (!after) {
      const list = store.entries(target.session, true);
      const i = list.findIndex((x) => x.id === target.id);
      afterId = i > 0 ? list[i - 1].id : null;
      if (afterId && ids.includes(afterId)) return;
    }
    store.commit(`${ids.length}줄 옮기기`, { entries: placeChanges(ids, target.session, afterId) });
  }

  // ── 글 고치기 ───────────────────────────
  function startEdit(r, e) {
    const t = r.querySelector('.er-text');
    if (!t || r.classList.contains('is-editing')) return;
    r.classList.add('is-editing');
    const box = el('div', 'er-edit');
    const ta = el('textarea'); ta.value = e.text || ''; ta.id = 'edit-' + e.id; ta.setAttribute('aria-label', '글 고치기');
    ta.rows = Math.min(8, Math.max(1, (e.text || '').split('\n').length));
    const acts = el('div', 'er-edit-acts');
    const save = el('button', 'btn-sm primary', '저장'); save.type = 'button';
    const cancel = el('button', 'btn-sm', '취소'); cancel.type = 'button';
    const split = el('button', 'btn-sm', '커서에서 나누기'); split.type = 'button';
    split.title = '커서 앞은 이 줄에, 뒤는 바로 아래 새 줄로';
    acts.append(save, cancel, split, el('span', 'hint', 'Enter 저장 · Shift+Enter 줄바꿈 · Esc 취소'));
    box.append(ta, acts);
    t.replaceWith(box);
    ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length);
    const fit = () => { ta.style.height = 'auto'; ta.style.height = ta.scrollHeight + 2 + 'px'; };
    fit(); ta.addEventListener('input', fit);

    let done = false;
    const finish = (mode) => {
      if (done) return; done = true;
      const v = ta.value.replace(/\s+$/, '');
      if (mode === 'save' && v !== (e.text || '')) setText(e, v);
      else if (mode === 'split') splitAt(e, ta.value, ta.selectionStart);
      else { r.replaceWith(row(store.byId.get(e.id) || e)); }
    };
    save.addEventListener('mousedown', (ev) => ev.preventDefault());
    split.addEventListener('mousedown', (ev) => ev.preventDefault());
    cancel.addEventListener('mousedown', (ev) => ev.preventDefault());
    save.addEventListener('click', () => finish('save'));
    cancel.addEventListener('click', () => finish('cancel'));
    split.addEventListener('click', () => finish('split'));
    ta.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing) { ev.preventDefault(); finish('save'); }
      else if (ev.key === 'Escape') { ev.preventDefault(); finish('cancel'); }
    });
    ta.addEventListener('blur', () => setTimeout(() => finish('save'), 0));
  }

  function withText(e, v) {
    const n = clone(e);
    if (n.orig == null && !n.created) n.orig = e.text || '';
    n.text = v;
    return n;
  }
  function setText(e, v) {
    store.commit('글 고치기', { entries: [withText(e, v)] });
  }
  function splitAt(e, value, pos) {
    const before = value.slice(0, pos).replace(/\s+$/, '');
    const after = value.slice(pos).replace(/^\s+/, '');
    if (!before || !after) { if (value !== e.text) setText(e, value.replace(/\s+$/, '')); else A.render(true); A.toast('커서를 글 가운데에 두고 나눠 주세요'); return; }
    const first = withText(e, before);
    const id = store.newId();
    const second = { id, seq: 0, session: e.session, kind: e.kind, speaker: e.speaker, text: after, ts: e.ts, created: true };
    const placed = placeChanges([id], e.session, e.id, { [id]: second });
    store.commit('줄 나누기', { entries: [first].concat(placed) });
  }

  // ── 줄 메뉴 ─────────────────────────────
  function rowMenu(btn, e) {
    const list = store.entries(e.session, true);
    const idx = list.findIndex((x) => x.id === e.id);
    const visPrev = prevVisible(e);
    const sessions = store.book.sessions;
    const si = sessions.findIndex((s) => s.no === e.session);
    const items = [
      { label: '아래에 새 줄', run: () => insertNear(e, true) },
      { label: '위에 새 줄', run: () => insertNear(e, false) },
      '-',
      { label: '위 줄과 합치기', disabled: !visPrev || e.kind === 'dice' || visPrev.kind === 'dice', run: () => mergeUp(e, visPrev),
        hint: visPrev ? `위 줄(${KIND_NAME[visPrev.kind]})에 이어 붙여요` : '' },
      { label: '한 칸 위로', disabled: idx <= 0, run: () => nudge(e, -1) },
      { label: '한 칸 아래로', disabled: idx >= list.length - 1, run: () => nudge(e, 1) },
      '-',
      { label: '이 줄부터 다음 회차로', run: () => toNextSession(e), hint: si === sessions.length - 1 ? '새 회차를 만들어요' : '' },
      { label: '이 줄까지 이전 회차로', disabled: si <= 0, run: () => toPrevSession(e) },
    ];
    if (e.kind === 'dice') {
      items.push('-', { label: '카드 이름표 바꾸기', run: () => askDiceLabel([e.id]) }, { label: '판정 결과 바꾸기', run: () => resultMenu(btn, e) });
    }
    if (e.orig != null && e.orig !== e.text) items.push('-', { label: '원문으로 되돌리기', hint: e.orig.slice(0, 40), run: () => store.commit('원문으로', { entries: [Object.assign(clone(e), { text: e.orig })] }) });
    items.push('-', { label: '링크 복사', run: () => copy(location.href.split('#')[0] + '#' + e.id) });
    items.push({ label: '휴지통으로', danger: true, run: () => trash([e.id]) });
    openMenu(btn, items);
  }

  function prevVisible(e) {
    const r = document.getElementById(e.id);
    let p = r && r.previousElementSibling;
    while (p && !p.classList.contains('er')) p = p.previousElementSibling;
    return p ? store.byId.get(p.dataset.id) : null;
  }

  function insertNear(e, below) {
    const id = store.newId();
    const kind = e.kind === 'dice' ? (A.spk(e.speaker) && isChar(A.spk(e.speaker)) ? 'dialogue' : 'chat') : e.kind;
    const ne = { id, seq: 0, session: e.session, kind, speaker: e.speaker, text: '', ts: e.ts, created: true };
    let afterId = e.id;
    if (!below) { const list = store.entries(e.session, true); const i = list.findIndex((x) => x.id === e.id); afterId = i > 0 ? list[i - 1].id : null; }
    store.commit('새 줄', { entries: placeChanges([id], e.session, afterId, { [id]: ne }) });
    requestAnimationFrame(() => { const r = document.getElementById(id); if (r) { r.scrollIntoView({ block: 'center' }); startEdit(r, store.byId.get(id)); } });
  }

  function mergeUp(e, prev) {
    const merged = withText(prev, [prev.text, e.text].filter(Boolean).join('\n'));
    const gone = clone(e); gone.deleted = true;
    store.commit('위 줄과 합치기', { entries: [merged, gone] });
  }

  function nudge(e, dir) {
    const list = store.entries(e.session, true);
    const i = list.findIndex((x) => x.id === e.id);
    const j = i + dir;
    if (j < 0 || j >= list.length) return;
    const a = clone(e); const b = clone(list[j]);
    [a.seq, b.seq] = [b.seq, a.seq];
    store.commit(dir < 0 ? '한 칸 위로' : '한 칸 아래로', { entries: [a, b] });
  }

  function toNextSession(e) {
    const sessions = store.book.sessions;
    const si = sessions.findIndex((s) => s.no === e.session);
    const ch = { entries: [], sessions: [] };
    let target = sessions[si + 1];
    if (!target) {
      const no = Math.max(...sessions.map((s) => s.no)) + 1;
      target = { no, title: `${no}회차`, date: null };
      ch.sessions.push(target);
    }
    store.entries(e.session, true).filter((x) => x.seq >= e.seq).forEach((x) => { const n = clone(x); n.session = target.no; ch.entries.push(n); });
    store.commit(`${ch.entries.length}줄을 ${A.sessionLabel(target)}로`, ch);
    A.toast(`${ch.entries.length}줄을 ${A.sessionLabel(target)}로 옮겼어요`, { label: '되돌리기', run: () => store.undo() });
  }
  function toPrevSession(e) {
    const sessions = store.book.sessions;
    const si = sessions.findIndex((s) => s.no === e.session);
    const target = sessions[si - 1];
    if (!target) return;
    const ch = store.entries(e.session, true).filter((x) => x.seq <= e.seq).map((x) => Object.assign(clone(x), { session: target.no }));
    store.commit(`${ch.length}줄을 ${A.sessionLabel(target)}로`, { entries: ch });
    A.toast(`${ch.length}줄을 ${A.sessionLabel(target)}로 옮겼어요`, { label: '되돌리기', run: () => store.undo() });
  }

  function trash(ids) {
    const ch = ids.map((id) => Object.assign(clone(store.byId.get(id)), { deleted: true }));
    ids.forEach((id) => E.sel.delete(id));
    store.commit(`${ids.length}줄 휴지통으로`, { entries: ch });
    A.toast(`${ids.length}줄을 휴지통으로 옮겼어요`, { label: '되돌리기', run: () => store.undo() });
    updateBulk();
  }
  function restore(ids) {
    const ch = ids.map((id) => { const n = clone(store.byId.get(id)); delete n.deleted; return n; });
    ids.forEach((id) => E.sel.delete(id));
    store.commit(`${ids.length}줄 복원`, { entries: ch });
    A.toast(`${ids.length}줄을 복원했어요`);
    updateBulk();
  }

  // ── 종류 · 말한 사람 ────────────────────
  function kindMenu(btn, ids) {
    const items = KIND_OPTS.filter(([k]) => k !== 'dice').map(([k, label]) => ({
      label, run: () => {
        const ch = ids.map((id) => store.byId.get(id)).filter((e) => e.kind !== 'dice' && e.kind !== k).map((e) => Object.assign(clone(e), { kind: k }));
        if (ch.length) store.commit(`${ch.length}줄 종류 → ${KIND_NAME[k]}`, { entries: ch });
        else if (ids.some((id) => store.byId.get(id).kind === 'dice')) A.toast('주사위 줄은 종류를 바꿀 수 없어요');
      },
    }));
    openMenu(btn, items);
  }
  function speakerMenu(btn, ids) {
    const sp = store.book.speakers;
    const chars = sp.filter(isChar); const others = sp.filter((s) => !isChar(s));
    const mk = (s) => ({
      label: s ? s.name : '없음', color: s && s.color, run: () => {
        const ch = ids.map((id) => store.byId.get(id)).map((e) => {
          const n = clone(e); n.speaker = s ? s.id : null; delete n.uncertain;
          // 대사↔사담은 말한 사람에 맞춰 같이 바꿈
          if (s && (n.kind === 'dialogue' || n.kind === 'chat')) n.kind = isChar(s) ? 'dialogue' : 'chat';
          return n;
        });
        store.commit(`${ch.length}줄 말한 사람 → ${s ? s.name : '없음'}`, { entries: ch });
      },
    });
    openMenu(btn, [{ heading: '캐릭터' }].concat(chars.map(mk), [{ heading: '플레이어 · GM' }], others.map(mk), ['-', mk(null)]));
  }

  // ── 주사위 ──────────────────────────────
  function resultMenu(btn, e) {
    const set = (v) => { const n = clone(e); n.dice = Object.assign({}, n.dice); if (v) n.dice.resultOverride = v; else delete n.dice.resultOverride; store.commit('판정 결과', { entries: [n] }); };
    const auto = e.dice.result ? A.RESULT_LABEL[e.dice.result] : '없음';
    openMenu(btn, [
      { label: `자동 (${auto})`, run: () => set(null) },
      { label: '성공', run: () => set('success') }, { label: '실패', run: () => set('fail') },
      { label: '스페셜', run: () => set('special') }, { label: '펌블', run: () => set('fumble') },
      { label: '표시 안 함', run: () => set('none') },
    ]);
  }
  function askDiceLabel(ids) {
    const first = store.byId.get(ids[0]);
    ask({
      title: '카드 이름표', note: '이 카드에만 쓰는 이름표예요. 비우면 기본 이름표로 돌아가요. (기본값은 \'기록 정보\'에서)',
      fields: [{ id: 'ask-dlabel', label: '이름표', value: (first.dice && first.dice.label) || '', placeholder: A.diceLabel(Object.assign({}, first.dice, { label: null })), max: 16 }],
      ok: '바꾸기',
      run: ([v]) => {
        const ch = ids.map((id) => { const n = clone(store.byId.get(id)); n.dice = Object.assign({}, n.dice); if (v.trim()) n.dice.label = v.trim(); else delete n.dice.label; return n; });
        store.commit('카드 이름표', { entries: ch });
      },
    });
  }

  // ── 기록 정보 ───────────────────────────
  function openBookInfo() {
    const b = store.book;
    const labels = Object.assign({}, b.diceLabels || {});
    const L = A.DICE_LABELS;
    const spellTypes = Array.from(new Set(b.entries.filter((e) => e.kind === 'dice' && e.dice && e.dice.spellType).map((e) => e.dice.spellType)));
    const labelFields = [['roll', L.roll], ['check', L.check]].concat(spellTypes.map((t) => ['spell:' + t, t]), [['equip', L.equip], ['table', L.table], ['pick', L.pick]])
      .map(([k, def]) => ({ id: 'dl-' + k.replace(/[^a-z0-9]/gi, '_'), key: k, label: `카드 이름표: ${def}`, value: labels[k] || '', placeholder: def, max: 16, group: '주사위 카드 기본 이름표' }));
    ask({
      title: '기록 정보', note: '제목·GM·PL·기간은 위쪽 머리말에 나와요.',
      fields: [
        { id: 'bi-vis', label: '공개 상태', type: 'select', value: b.visibility || 'draft', options: [['draft', '초안 (관리자만 보임)'], ['public', '공개 (세계관 멤버에게 보임)']] },
        { id: 'bi-title', label: '제목', value: b.title || '', max: 60 },
        { id: 'bi-system', label: '시스템', value: b.system || '', max: 30 },
        { id: 'bi-gm', label: 'GM', value: b.gm || '', max: 40 },
        { id: 'bi-pl', label: 'PL (쉼표로 구분)', value: (b.players || []).join(', '), max: 200 },
        { id: 'bi-start', label: '시작일', type: 'date', value: (b.period && b.period.start) || '' },
        { id: 'bi-end', label: '종료일', type: 'date', value: (b.period && b.period.end) || '' },
      ].concat(labelFields),
      ok: '저장',
      run: (v) => {
        const dl = {};
        const [vis, ...w] = v;
        labelFields.forEach((f, i) => { const x = w[6 + i].trim(); if (x) dl[f.key] = x; });
        store.commit('기록 정보', { book: {
          visibility: vis,
          title: w[0].trim() || b.title, system: w[1].trim() || null, gm: w[2].trim() || null,
          players: w[3].split(',').map((x) => x.trim()).filter(Boolean),
          period: { start: w[4] || null, end: w[5] || null }, diceLabels: dl,
        } });
      },
    });
  }

  // 인물 설정 (A.openPeople이 편집 중일 때 행마다 붙임)
  E.personFields = function (s) {
    const box = el('div', 'person-edit');
    const name = el('input'); name.id = 'pn-' + s.id; name.value = s.name; name.maxLength = 40; name.setAttribute('aria-label', '표시 이름');
    name.addEventListener('change', () => { const v = name.value.trim(); if (!v || v === s.name) { name.value = s.name; return; } store.commit(`이름 '${v}'`, { speakers: [Object.assign(clone(s), { name: v })] }); });
    const role = el('select'); role.id = 'pr-' + s.id; role.setAttribute('aria-label', '역할');
    ROLE_OPTS.forEach(([k, v]) => { const o = el('option', null, v); o.value = k; o.selected = s.role === k; role.append(o); });
    role.addEventListener('change', () => changeRole(s, role.value));
    box.append(name, role);
    if (s.role === 'pc' || s.role === 'npc') {
      const pl = el('select'); pl.id = 'pp-' + s.id; pl.setAttribute('aria-label', '플레이어');
      const none = el('option', null, s.role === 'npc' ? '(NPC)' : 'PL 미정'); none.value = ''; pl.append(none);
      store.book.speakers.filter((x) => x.role === 'pl' || x.role === 'gm').forEach((x) => { const o = el('option', null, x.name); o.value = x.id; o.selected = s.player === x.id; pl.append(o); });
      pl.addEventListener('change', () => store.commit(`${s.name} 플레이어`, { speakers: [Object.assign(clone(s), { player: pl.value || null })] }));
      box.append(pl);
      const chars = (A.ctx().worldChars || []);
      if (chars.length) {
        const cs = el('select'); cs.id = 'pc-' + s.id; cs.setAttribute('aria-label', '사분면 캐릭터 이미지');
        const n0 = el('option', null, '사분면 캐릭터 연결 안 함'); n0.value = ''; cs.append(n0);
        chars.forEach((c) => { const o = el('option', null, `이미지: ${c.name}`); o.value = c.id; o.selected = s.charId === c.id; cs.append(o); });
        cs.addEventListener('change', () => store.commit(`${s.name} 이미지`, { speakers: [Object.assign(clone(s), { charId: cs.value || null })] }));
        box.append(cs);
      }
      if (store.mode === 'server') {
        const ip = el('input'); ip.id = 'pi-' + s.id; ip.value = s.image || ''; ip.placeholder = '이미지 경로 (예: ARCANA/NPC_01.webp)';
        ip.setAttribute('aria-label', '이미지 경로 (world-assets 안)');
        ip.title = 'Supabase Storage world-assets 안의 경로. 비우면 사분면 캐릭터 이미지나 첫 글자로 보여요.';
        ip.addEventListener('change', () => {
          const v = ip.value.trim();
          if (v && !/^[A-Za-z0-9_]+\/[A-Za-z0-9_.-]+$/.test(v)) { A.toast('경로는 세계관ID/파일이름 모양이에요 (영어·숫자·_·-·.)'); ip.value = s.image || ''; return; }
          store.commit(`${s.name} 이미지 경로`, { speakers: [Object.assign(clone(s), { image: v || null })] });
        });
        box.append(ip);
      }
    }
    return box;
  };
  function changeRole(s, role) {
    store.commit(`${s.name} 역할`, { speakers: [Object.assign(clone(s), { role })] });
    const want = role === 'pc' || role === 'npc' ? 'dialogue' : 'chat';
    const lines = store.book.entries.filter((e) => e.speaker === s.id && (e.kind === 'dialogue' || e.kind === 'chat') && e.kind !== want);
    if (lines.length) {
      A.toast(`${s.name}의 줄 ${lines.length}개가 아직 ${KIND_NAME[want === 'dialogue' ? 'chat' : 'dialogue']}예요`, {
        label: `${KIND_NAME[want]}로 바꾸기`,
        run: () => store.commit(`${s.name} 줄 종류`, { entries: lines.map((e) => Object.assign(clone(e), { kind: want })) }),
      });
    }
  }

  // ── 떠 있는 메뉴 ────────────────────────
  let menuEl = null;
  function openMenu(anchor, items) {
    closeMenu();
    menuEl = el('div', 'emenu'); menuEl.setAttribute('role', 'menu');
    items.forEach((it) => {
      if (it === '-') { menuEl.append(el('div', 'emenu-sep')); return; }
      if (it.heading) { menuEl.append(el('div', 'emenu-h', it.heading)); return; }
      const b = el('button', 'emenu-item' + (it.danger ? ' danger' : '')); b.type = 'button'; b.setAttribute('role', 'menuitem');
      if (it.color) { const d = el('span', 'dot'); d.style.setProperty('--c', it.color); b.append(d); }
      b.append(el('span', null, it.label));
      if (it.hint) b.append(el('small', null, it.hint));
      b.disabled = !!it.disabled;
      b.addEventListener('click', (ev) => { ev.stopPropagation(); closeMenu(); it.run(); });
      menuEl.append(b);
    });
    document.body.append(menuEl);
    const r = anchor.getBoundingClientRect();
    const mw = menuEl.offsetWidth; const mh = menuEl.offsetHeight;
    let left = Math.min(r.left, window.innerWidth - mw - 12); left = Math.max(12, left);
    let top = r.bottom + 4; if (top + mh > window.innerHeight - 12) top = Math.max(12, r.top - mh - 4);
    menuEl.style.left = left + 'px'; menuEl.style.top = top + 'px';
    const first = menuEl.querySelector('.emenu-item:not([disabled])'); if (first) first.focus();
  }
  function closeMenu() { if (menuEl) { menuEl.remove(); menuEl = null; } }
  document.addEventListener('click', (ev) => { if (menuEl && !menuEl.contains(ev.target)) closeMenu(); });
  // 메뉴를 연 뒤 실제로 스크롤했을 때만 닫기 (자리 맞춤으로 생기는 작은 움직임은 무시)
  // 줄이 그려지며 생기는 자동 스크롤은 무시하고, 사람이 휠·터치로 움직일 때만 닫기
  const userScroll = (ev) => { if (menuEl && !menuEl.contains(ev.target)) closeMenu(); };
  window.addEventListener('wheel', userScroll, { passive: true });
  window.addEventListener('touchmove', userScroll, { passive: true });

  // ── 작은 입력 창 (prompt 대신) ───────────
  function ask(o) {
    const back = $('ask'); const form = $('askForm');
    $('askTitle').textContent = o.title; $('askNote').textContent = o.note || '';
    const box = $('askFields'); box.replaceChildren();
    let group = null;
    const inputs = o.fields.map((f) => {
      if (f.group && f.group !== group) { group = f.group; box.append(el('h3', 'ask-group', group)); }
      const lab = el('label', 'ask-field'); lab.htmlFor = f.id;
      lab.append(el('span', null, f.label));
      let inp;
      if (f.type === 'select') {
        inp = el('select'); inp.id = f.id;
        f.options.forEach(([v, t]) => { const o = el('option', null, t); o.value = v; o.selected = v === (f.value || ''); inp.append(o); });
      } else {
        inp = el('input'); inp.id = f.id; inp.type = f.type || 'text'; inp.value = f.value || '';
        if (f.placeholder) inp.placeholder = f.placeholder; if (f.max) inp.maxLength = f.max;
      }
      lab.append(inp); box.append(lab);
      return inp;
    });
    $('askOk').textContent = o.ok || '확인';
    form.onsubmit = (ev) => { ev.preventDefault(); back.hidden = true; o.run(inputs.map((i) => i.value)); };
    back.hidden = false;
    inputs[0].focus();
  }

  function copy(text) {
    try { navigator.clipboard.writeText(text).then(() => A.toast('링크를 복사했어요'), () => A.toast('복사하지 못했어요')); } catch (e) { A.toast('복사하지 못했어요'); }
  }

  // ── 연결 ────────────────────────────────
  function bind() {
    $('optEdit').textContent = '편집하기';
    $('optEdit').title = store.mode === 'demo' ? '데모에서는 누구나 편집할 수 있고, 이 브라우저에만 저장돼요' : '관리자 편집';
    $('optEdit').addEventListener('click', E.toggle);
    $('eUndo').addEventListener('click', () => { const l = store.undo(); if (l) A.toast(`되돌림: ${l}`); });
    $('eRedo').addEventListener('click', () => { const l = store.redo(); if (l) A.toast(`다시: ${l}`); });
    $('eTrash').addEventListener('click', () => { E.trash = !E.trash; E.sel.clear(); E.moving = false; updateBulk(); E.updateBar(); A.render(); });
    $('eHidden').addEventListener('click', () => { E.showHidden = !E.showHidden; A.prefs.set('edit:showHidden', E.showHidden); E.updateBar(); A.render(true); });
    $('ePeople').addEventListener('click', A.openPeople);
    $('eDelete').addEventListener('click', deleteBook);
    $('eBook').addEventListener('click', openBookInfo);
    let armed = 0;
    $('eReset').addEventListener('click', () => {
      if (!armed) { $('eReset').textContent = '정말 모두 지울까요? 한 번 더'; armed = setTimeout(() => { armed = 0; $('eReset').textContent = '수정 모두 지우기'; }, 3500); return; }
      clearTimeout(armed); armed = 0; $('eReset').textContent = '수정 모두 지우기';
      store.resetLocal(); A.renderHead(); A.render(); A.toast('이 브라우저의 수정을 모두 지웠어요');
    });

    $('bulkKind').addEventListener('click', (ev) => { ev.stopPropagation(); kindMenu($('bulkKind'), selectedInOrder()); });
    $('bulkWho').addEventListener('click', (ev) => { ev.stopPropagation(); speakerMenu($('bulkWho'), selectedInOrder()); });
    $('bulkMove').addEventListener('click', () => { E.moving = !E.moving; updateBulk(); A.render(true); });
    $('bulkDelete').addEventListener('click', () => trash(selectedInOrder()));
    $('bulkRestore').addEventListener('click', () => restore(selectedInOrder()));
    $('bulkClear').addEventListener('click', clearSel);

    $('askCancel').addEventListener('click', () => { $('ask').hidden = true; });
    $('ask').addEventListener('click', (ev) => { if (ev.target === $('ask')) $('ask').hidden = true; });

    document.addEventListener('keydown', (ev) => {
      if (!E.active) return;
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement && document.activeElement.tagName);
      if (ev.key === 'Escape') {
        if (menuEl) { closeMenu(); return; }
        if (!$('ask').hidden) { $('ask').hidden = true; return; }
        if (E.moving) { E.moving = false; updateBulk(); A.render(true); return; }
      }
      if (typing) return;
      const mod = ev.ctrlKey || ev.metaKey;
      if (mod && ev.key.toLowerCase() === 'z') { ev.preventDefault(); const l = ev.shiftKey ? store.redo() : store.undo(); if (l) A.toast(`${ev.shiftKey ? '다시' : '되돌림'}: ${l}`); }
      else if (mod && ev.key.toLowerCase() === 'y') { ev.preventDefault(); const l = store.redo(); if (l) A.toast(`다시: ${l}`); }
    });
    window.addEventListener('beforeunload', (ev) => {
      if (store.mode === 'demo') { clearTimeout(store.saveTimer); try { store.prune(); localStorage.setItem(store.key, JSON.stringify(store.ov)); } catch (e) { /* 무시 */ } return; }
      if (store.saveState() !== 'saved') { ev.preventDefault(); ev.returnValue = ''; } // 아직 안 보낸 수정이 있으면 나가기 전에 확인
    });
  }

  // 기록을 열 때마다 (site.js → app.openBook → 여기). 데모: 누구나 / 서버: 관리자만
  let boundOnce = false;
  E.ready = function () {
    const can = store.mode === 'demo' || store.isAdmin;
    if (can && !boundOnce) { bind(); boundOnce = true; }
    $('optEdit').hidden = !can;
  };

  // 기록 지우기 (두 번 눌러 확인)
  let delArmed = 0;
  function deleteBook() {
    const btn = $('eDelete');
    if (!delArmed) { btn.textContent = '정말 지울까요? 한 번 더'; delArmed = setTimeout(() => { delArmed = 0; btn.textContent = '기록 지우기'; }, 3500); return; }
    clearTimeout(delArmed); delArmed = 0; btn.textContent = '기록 지우기';
    store.api.deleteBook(store.bookId).then(() => { A.toast('기록을 지웠어요'); if (SL.site) SL.site.nav(''); }, (e) => A.toast(e.message));
  }
  E.deleteBook = deleteBook;
})();
