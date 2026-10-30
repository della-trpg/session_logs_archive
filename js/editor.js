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
  const SAY_NAME = { act: '지문', thought: '생각', speech: '말' };
  const ROLE_OPTS = [['pc', 'PC'], ['npc', 'NPC'], ['enemy', '에너미'], ['gm', 'GM'], ['pl', '플레이어']];

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
    const anchor = A.topVisibleEntry();   // 화면 모양을 바꾸기 전에 기준 줄부터
    E.active = !E.active;
    document.body.classList.toggle('editing', E.active);
    $('optEdit').setAttribute('aria-pressed', String(E.active));
    $('optEdit').textContent = E.active ? '편집 끝내기' : '편집하기';
    $('editBar').hidden = !E.active;
    if (!E.active) { E.sel.clear(); E.moving = false; E.trash = false; closeMenu(); }
    updateBulk();
    E.updateBar();
    A.render(anchor || true);
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
    if (E.moving) head.append(frontButton(s.no));
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
      const d = A.paint(el('span', 'dot'), s); b.append(d, el('span', null, s.name));
    } else b.append(el('span', 'muted', e.kind === 'narration' || e.kind === 'scene' || e.kind === 'system' ? '—' : '알 수 없음'));
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
    if (e.say && e.kind === 'dialogue') { const f = el('span', 'flag', SAY_NAME[e.say] + ' 고정'); f.title = '표시 방식을 직접 정한 줄 (⋯ 메뉴 → 표시 방식)'; flags.append(f); }
    if (e.nvHide) { const f = el('span', 'flag', '노벨 숨김'); f.title = '노벨 보기에서는 건너뛰어요. 채팅 로그에는 그대로 보여요.'; flags.append(f); }
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
    // 인물만 바뀐 경우(이름·역할·색 등): 그 인물의 줄만 다시 그림 (전체 6천여 줄을 다시 그리지 않게)
    const spOnly = (op.after.speakers || []).length && !(op.after.entries || []).length && !op.after.book && !(op.after.sessions || []).length;
    if (spOnly) {
      const ids = new Set(op.after.speakers.map(([id]) => id));
      const added = op.after.speakers.some(([id]) => !(op.before.speakers || []).some(([b, x]) => b === id && x));
      if (!added) {
        const anchor = A.topVisibleEntry();
        for (const r of $('log').querySelectorAll('.er')) {
          const e = store.byId.get(r.dataset.id);
          if (e && ids.has(e.speaker)) r.replaceWith(row(e));
        }
        if (anchor) A.restorePlace(anchor);
        return;
      }
    }
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
    // 기준 줄: 끌어 놓기·옮기기는 '놓은 자리', 그 밖에는 화면 맨 위 줄 → 수정 뒤에도 그 줄이 같은 높이에 있게
    const anchor = E.anchorNext || A.topVisibleEntry();
    E.anchorNext = null;
    if (!structural) {
      pairs.forEach(({ a }, id) => {
        const old = document.getElementById(id);
        if (!old || !old.classList.contains('er')) return;
        if (a && E.rowVisible(a)) old.replaceWith(row(a)); else old.remove();
      });
    } else if (!(op.after.sessions || []).length && onlyMoves(pairs) && reorderRows(pairs)) {
      // 순서만 바뀐 경우: 다시 그리지 않고 그 줄만 옮김 (화면이 튀지 않게)
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

  // 화면(고정 도구줄 아래)에 보이는 줄 중, 옮기는 줄을 뺀 가장 위 줄 → { id, off }
  function topAnchor(exclude) {
    const skip = new Set(exclude || []);
    const top = $('toolbar').getBoundingClientRect().bottom + 4;
    for (const n of $('log').querySelectorAll('.er, .ehead')) {
      if (skip.has(n.dataset.id)) continue;
      const rect = n.getBoundingClientRect();
      if (rect.bottom > top) return { id: n.id, off: rect.top };
    }
    return null;
  }

  // 바뀐 게 순서값·회차뿐인지
  function onlyMoves(pairs) {
    for (const { a, b } of pairs.values()) {
      if (!a || !b || a.kind !== b.kind || !!a.deleted !== !!b.deleted || a.text !== b.text || a.speaker !== b.speaker) return false;
    }
    return true;
  }
  // 바뀐 줄을 새 순서에 맞는 자리로 옮김. 못 하면 false (→ 회차를 다시 그림)
  function reorderRows(pairs) {
    const moved = [];
    pairs.forEach(({ a, b }) => { if (a.seq !== b.seq || a.session !== b.session) moved.push(a); });
    if (moved.length > 300) return false;
    const order = store.book.sessions.map((x) => x.no);
    moved.sort((x, y) => (order.indexOf(x.session) - order.indexOf(y.session)) || (x.seq - y.seq));
    const sessions = new Set();
    for (const m of moved) {
      const e = store.byId.get(m.id);
      const old = document.getElementById(m.id);
      if (!E.rowVisible(e)) { if (old) old.remove(); continue; }
      const sec = document.querySelector(`.esess[data-no="${e.session}"]`);
      if (!sec) return false;
      const node = old && old.classList.contains('er') ? old : row(e);
      const list = store.entries(e.session, true).filter(E.rowVisible);
      const i = list.findIndex((x) => x.id === e.id);
      const prev = i > 0 ? document.getElementById(list[i - 1].id) : sec.querySelector('.ehead');
      if (!prev || prev === node) return false;
      prev.after(node);
      sessions.add(e.session);
      if (old && old !== node) sessions.add(Number(old.closest('.esess') && old.closest('.esess').dataset.no));
    }
    // 회차 머리의 줄 수
    pairs.forEach(({ b }) => sessions.add(b.session));
    sessions.forEach((no) => {
      const h = document.querySelector(`.esess[data-no="${no}"] .ehead-n`);
      if (h) h.textContent = `${store.entries(no).length.toLocaleString()}줄`;
    });
    return true;
  }

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
  function clearSel() { E.sel.clear(); E.anchor = null; setMoving(false); paintSelection(); }

  // 옮기기 모드 켜고 끄기: 목록은 그대로 두고 안내 문구와 회차 머리의 '맨 앞으로' 버튼만 넣고 뺌
  function setMoving(on) {
    if (E.moving === on && !(on && !document.querySelector('.edit-note.is-move'))) { updateBulk(); return; }
    const a = A.topVisibleEntry();
    E.moving = on;
    document.querySelectorAll('.edit-note.is-move, .ehead .btn-front').forEach((n) => n.remove());
    if (on) {
      const note = el('p', 'edit-note is-move', `${E.sel.size}줄을 옮길 자리를 고르세요. 누른 줄 바로 아래로 들어가요. 회차 맨 앞으로 옮기려면 회차 제목 옆 '맨 앞으로'를 누르세요.`);
      $('log').prepend(note);
      document.querySelectorAll('.ehead').forEach((h) => h.append(frontButton(Number(h.dataset.no))));
    }
    updateBulk();
    if (a) A.restorePlace(a);
  }
  function frontButton(no) {
    const b = el('button', 'btn-sm btn-front', '맨 앞으로'); b.type = 'button';
    b.addEventListener('click', () => moveSelected(no, null));
    return b;
  }
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
    $('bulkKind').hidden = E.trash; $('bulkWho').hidden = E.trash; $('bulkDelete').hidden = E.trash; $('bulkNovel').hidden = E.trash;
    $('bulkRestore').hidden = !E.trash;
    const allHidden = Array.from(E.sel).every((id) => { const x = store.byId.get(id); return x && x.nvHide; });
    $('bulkNovel').textContent = allHidden ? '노벨에 다시 보이기' : '노벨 숨김';
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
    document.querySelectorAll('.edit-note.is-move, .ehead .btn-front').forEach((n) => n.remove());
    E.anchorNext = topAnchor(ids);
    store.commit(`${ids.length}줄 옮기기`, { entries: placeChanges(ids, no, afterId) });
    A.toast(`${ids.length}줄을 옮겼어요`, { label: '되돌리기', run: () => store.undo() });
    updateBulk();
  }

  // ── 끌어서 옮기기 (PC) ───────────────────
  function dragStart(ev, e) {
    const ids = E.sel.has(e.id) ? selectedInOrder() : [e.id];
    E.drag = { ids, y: null };   // 첫 dragover에서 실제 위치를 받기 전엔 스크롤하지 않음
    ev.dataTransfer.effectAllowed = 'move';
    try { ev.dataTransfer.setData('text/plain', ids.join(',')); } catch (err) { /* 무시 */ }
    const r = document.getElementById(e.id);
    if (r && ev.dataTransfer.setDragImage) ev.dataTransfer.setDragImage(r, 24, Math.min(16, r.offsetHeight / 2));
    document.body.classList.add('dragging');
    autoScroll();
  }
  function dragEnd() {
    E.drag = null; document.body.classList.remove('dragging');
    $('log').querySelectorAll('.drop-before, .drop-after').forEach((n) => n.classList.remove('drop-before', 'drop-after'));
  }
  // 끄는 동안 화면 가장자리에 가까우면 부드럽게 스크롤. 위쪽 기준은 고정 도구줄 바로 아래.
  document.addEventListener('dragover', (ev) => { if (E.drag) E.drag.y = ev.clientY; });
  function autoScroll() {
    const step = () => {
      if (!E.drag) return;
      const top = $('toolbar').getBoundingClientRect().bottom;
      const bottom = window.innerHeight;
      const zone = 60; const y = E.drag.y;
      let v = 0;
      if (y == null) v = 0;
      else if (y < top + zone) v = -Math.ceil(((top + zone - Math.max(y, top - 20)) / zone) * 14);
      else if (y > bottom - zone) v = Math.ceil(((y - (bottom - zone)) / zone) * 14);
      if (v) window.scrollBy(0, v);
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }
  function dragOver(ev, r) {
    if (!E.drag) return;
    ev.preventDefault();
    ev.dataTransfer.dropEffect = 'move';
    const rect = r.getBoundingClientRect();
    const after = ev.clientY > rect.top + rect.height / 2;
    if (r.classList.contains(after ? 'drop-after' : 'drop-before')) return;
    $('log').querySelectorAll('.drop-before, .drop-after').forEach((n) => { if (n !== r) n.classList.remove('drop-before', 'drop-after'); });
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
    // 화면이 스크롤되지 않고 줄만 자리를 바꾸도록: 옮기지 않은 줄 중 화면 맨 위 줄을 고정
    E.anchorNext = topAnchor(ids) || { id: target.id, off: r.getBoundingClientRect().top };
    store.commit(`${ids.length}줄 옮기기`, { entries: placeChanges(ids, target.session, afterId) });
  }

  // ── 글 고치기 ───────────────────────────
  function startEdit(r, e) {
    const t = r.querySelector('.er-text');
    if (!t || r.classList.contains('is-editing')) return;
    r.classList.add('is-editing');
    const box = el('div', 'er-edit');
    const ta = el('textarea'); ta.value = e.text || ''; ta.id = 'edit-' + e.id; ta.setAttribute('aria-label', '글 고치기'); ta.maxLength = 5000;
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
      { label: '아래에 새 주사위 줄', run: () => insertDice(e) },
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
    if (e.kind !== 'dice') items.push('-', { label: '주사위 줄로 바꾸기…', run: () => editDice(e) });
    if (e.kind === 'dice') {
      items.push('-', { label: '주사위 고치기…', run: () => editDice(e) }, { label: '카드 이름표 바꾸기', run: () => askDiceLabel([e.id]) }, { label: '판정 결과 바꾸기', run: () => resultMenu(btn, e) });
    }
    if (e.orig != null && e.orig !== e.text) items.push('-', { label: '원문으로 되돌리기', hint: e.orig.slice(0, 40), run: () => store.commit('원문으로', { entries: [Object.assign(clone(e), { text: e.orig })] }) });
    if (e.kind === 'dialogue') {
      const cur = e.say || '';
      items.push('-', { heading: '표시 방식' });
      [['', '자동 (괄호·작은따옴표로 판단)'], ['act', '지문'], ['thought', '생각'], ['speech', '말 (괄호가 있어도 그냥 말)']].forEach(([v, l]) => {
        items.push({ label: (cur === v ? '✓ ' : '　') + l, run: () => setSay([e.id], v) });
      });
    }
    items.push('-', e.nvHide
      ? { label: '노벨 보기에 다시 보이기', run: () => setNovelHide([e.id], false) }
      : { label: '노벨 보기에서 숨기기', hint: '채팅 로그에는 그대로 보여요', run: () => setNovelHide([e.id], true) });
    items.push({ label: '링크 복사', run: () => copy(location.href.split('#')[0] + '#' + e.id) });
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

  // 아래에 새 주사위 줄: 먼저 눈을 적는 창 → 확인하면 그 자리에 주사위 카드
  function insertDice(e) {
    const id = store.newId();
    const ne = { id, seq: 0, session: e.session, kind: 'chat', speaker: e.speaker, text: '', ts: e.ts, created: true };
    editDice(ne, { place: e.id, isNew: true });
  }

  // 줄바꿈 없이 이어 붙임. 낱말이 붙지 않게 띄어쓰기 한 칸 (위 글이 공백으로 끝나거나 아래 글이 문장부호로 시작하면 그대로)
  function joinText(a, b) {
    a = (a || '').replace(/\s+$/, ''); b = (b || '').replace(/^\s+/, '');
    if (!a) return b; if (!b) return a;
    return /^[.,!?~…)\]」』'"”’]/.test(b) ? a + b : a + ' ' + b;
  }
  function mergeUp(e, prev) {
    const merged = withText(prev, joinText(prev.text, e.text));
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
  // 대사 표시 방식 고정: 'act' 지문 · 'thought' 생각 · 'speech' 말 · '' 자동
  function setSay(ids, v) {
    const ch = ids.map((id) => { const n = clone(store.byId.get(id)); if (v) n.say = v; else delete n.say; return n; });
    store.commit(v ? `표시 방식: ${SAY_NAME[v]}` : '표시 방식: 자동', { entries: ch });
  }
  // 노벨 보기에서 숨기기/보이기 (채팅 로그는 그대로)
  function setNovelHide(ids, on) {
    const ch = ids.map((id) => { const n = clone(store.byId.get(id)); if (on) n.nvHide = true; else delete n.nvHide; return n; });
    store.commit(on ? `${ids.length}줄 노벨에서 숨김` : `${ids.length}줄 노벨에 보이기`, { entries: ch });
    A.toast(on ? `${ids.length}줄을 노벨 보기에서 숨겼어요` : `${ids.length}줄을 노벨 보기에 다시 보여요`, { label: '되돌리기', run: () => store.undo() });
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
    const items = KIND_OPTS.map(([k, label]) => ({
      label, run: () => {
        if (k === 'dice') {
          // 주사위로: 눈·목표치 등을 적는 창 (한 줄씩)
          const list = ids.map((id) => store.byId.get(id)).filter((e) => e.kind !== 'dice');
          if (!list.length) return;
          if (list.length > 1) { A.toast('주사위로 바꾸기는 한 줄씩 해 주세요'); return; }
          editDice(list[0]);
          return;
        }
        const ch = ids.map((id) => store.byId.get(id)).filter((e) => e.kind !== k).map((e) => {
          const n = Object.assign(clone(e), { kind: k });
          if (e.kind === 'dice') { if (!n.text) n.text = diceAsText(e.dice); delete n.dice; }   // 주사위 → 글 줄: 굴림 내용을 글로
          return n;
        });
        if (ch.length) store.commit(`${ch.length}줄 종류 → ${KIND_NAME[k]}`, { entries: ch });
      },
    }));
    openMenu(btn, items);
  }
  function diceAsText(d) {
    d = d || {};
    const faces = (d.dice || []).join(', ');
    const sum = d.sum != null ? d.sum : d.total;
    return [d.title, faces ? `${(d.rolls || []).join('+').toUpperCase() || '주사위'} → ${faces}${sum != null && (d.dice || []).length > 1 ? ` = ${sum}` : ''}` : null,
      typeof d.target === 'number' ? `목표치 ${d.target}` : null].filter(Boolean).join(' · ');
  }

  // 주사위 줄 만들기·고치기: 이름표·제목·눈·면 수·수정치·목표치·결과
  const RESULT_OPTS = [['', '자동 (목표치가 있으면 계산)'], ['success', '성공'], ['fail', '실패'], ['special', '스페셜'], ['fumble', '펌블'], ['none', '표시 안 함']];
  function editDice(e, opts) {
    opts = opts || {};
    const d = e.kind === 'dice' && e.dice ? e.dice : {};
    const sides0 = (d.sides && d.sides.find((x) => x)) || 6;
    ask({
      title: opts.isNew ? '새 주사위 줄' : e.kind === 'dice' ? '주사위 고치기' : '주사위 줄로 바꾸기',
      note: opts.isNew ? '고른 줄 바로 아래에 주사위 카드를 넣어요. 굴린 사람은 그 줄과 같아요 (나중에 바꿀 수 있어요).'
        : e.kind === 'dice' ? '눈을 바꾸면 합계와 (자동일 때) 판정 결과도 다시 계산해요.'
        : '이 줄을 주사위 카드로 바꿔요. 지금 글은 원문으로 남아서 나중에 되돌릴 수 있어요. 말한 사람은 그대로예요.',
      fields: [
        { id: 'dz-faces', label: '주사위 눈 (띄어쓰기로)', value: (d.dice || []).join(' '), placeholder: '예: 3 5' },
        { id: 'dz-sides', label: '면 수', type: 'select', value: String(sides0), options: [4, 6, 8, 10, 12, 20, 100].map((n) => [String(n), 'd' + n]) },
        { id: 'dz-mod', label: '수정치 (없으면 비움)', value: d.mod ? String(d.mod) : '', placeholder: '예: -1' },
        { id: 'dz-target', label: '목표치 (없으면 비움)', value: typeof d.target === 'number' ? String(d.target) : '', placeholder: '예: 5' },
        { id: 'dz-title', label: '판정·주문 이름 (없으면 비움)', value: d.title || '', max: 60 },
        { id: 'dz-label', label: '카드 이름표 (비우면 기본)', value: d.label || '', max: 16 },
        { id: 'dz-result', label: '판정 결과', type: 'select', value: d.resultOverride || '', options: RESULT_OPTS },
      ],
      ok: opts.isNew ? '넣기' : e.kind === 'dice' ? '고치기' : '주사위로 바꾸기',
      cancel: opts.cancel,
      run: ([fv, sv, mv, tv, title, label, res]) => {
        const sides = Number(sv);
        const faces = fv.split(/[\s,，、+]+/).filter(Boolean).map(Number);
        if (!faces.length || faces.some((n) => !Number.isInteger(n) || n < 1 || n > sides)) { A.toast(`주사위 눈은 1~${sides} 사이 숫자를 띄어쓰기로 적어 주세요`); return; }
        const mod = mv.trim() ? Number(mv.trim().replace(/^\+/, '')) : 0;
        const target = tv.trim() ? Number(tv.trim()) : null;
        if (!Number.isFinite(mod) || (target != null && !Number.isFinite(target))) { A.toast('수정치·목표치는 숫자로 적어 주세요'); return; }
        const n = clone(e);
        const nd = Object.assign({}, e.kind === 'dice' ? d : { template: 'manual' });
        const same = (nd.dice || []).join() === faces.join() && (nd.sides || []).every((x) => !x || x === sides);
        nd.dice = faces; nd.sides = faces.map(() => sides);
        if (!same || !nd.rolls || nd.template === 'manual') nd.rolls = [`${faces.length}d${sides}`];
        const raw = faces.reduce((a, b) => a + b, 0);
        if (mod) nd.mod = mod; else delete nd.mod;
        if (faces.length > 1 || mod) nd.sum = raw + mod; else delete nd.sum;
        nd.total = raw + mod;
        if (target != null) nd.target = target; else delete nd.target;
        if (title.trim()) nd.title = title.trim(); else delete nd.title;
        if (label.trim()) nd.label = label.trim(); else delete nd.label;
        if (!nd.kind || nd.kind === 'roll' || nd.kind === 'check') nd.kind = target != null ? 'check' : 'roll';
        // 자동 판정: 2D6 12 스페셜·2 펌블, 그 밖에는 달성치 ≥ 목표치
        delete nd.result;
        if (target != null || nd.kind === 'check' || nd.kind === 'spell') {
          if (faces.length === 2 && sides === 6 && raw === 12) nd.result = 'special';
          else if (faces.length === 2 && sides === 6 && raw === 2) nd.result = 'fumble';
          else if (target != null) nd.result = raw + mod >= target ? 'success' : 'fail';
        }
        if (res) nd.resultOverride = res; else delete nd.resultOverride;
        n.dice = nd;
        if (e.kind !== 'dice') { if (n.orig == null && !n.created && e.text) n.orig = e.text; n.kind = 'dice'; n.text = ''; delete n.imgs; delete n.say; }
        if (opts.place) store.commit('새 주사위 줄', { entries: placeChanges([n.id], n.session, opts.place, { [n.id]: n }) });
        else store.commit(e.kind === 'dice' ? '주사위 고치기' : '주사위 줄로 바꾸기', { entries: [n] });
        if (opts.done) opts.done();
      },
    });
  }
  function speakerMenu(btn, ids) {
    const sp = store.book.speakers;
    const chars = sp.filter(isChar); const others = sp.filter((s) => !isChar(s));
    const mk = (s) => ({
      label: s ? s.name : '알 수 없음 / 없음', color: s && s.color, run: () => {
        const ch = ids.map((id) => store.byId.get(id)).map((e) => {
          const n = clone(e); n.speaker = s ? s.id : null; delete n.uncertain;
          // 대사↔사담은 말한 사람에 맞춰 같이 바꿈
          if (s && (n.kind === 'dialogue' || n.kind === 'chat')) n.kind = isChar(s) ? 'dialogue' : 'chat';
          return n;
        });
        store.commit(`${ch.length}줄 말한 사람 → ${s ? s.name : '알 수 없음'}`, { entries: ch });
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
    // 목록에 보일 대표 NPC: 에너미가 아닌 NPC를 대사 많은 순으로. 비우면 자동(가장 많은 사람)
    const lines = new Map();
    b.entries.forEach((e) => { if (e.kind === 'dialogue' && !e.deleted && e.speaker) lines.set(e.speaker, (lines.get(e.speaker) || 0) + 1); });
    const friends = b.speakers.filter((s) => s.role === 'npc' && !s.enemy && lines.get(s.id)).sort((x, y) => lines.get(y.id) - lines.get(x.id));
    const leadOpts = [['', friends.length ? `자동: 대사가 가장 많은 NPC (지금은 ${friends[0].name})` : '자동 (대사가 있는 NPC가 아직 없어요)']]
      .concat(friends.map((s) => [s.id, `${s.name} · 대사 ${lines.get(s.id).toLocaleString()}줄`]));
    const leadNow = b.leadNpc && friends.some((s) => s.id === b.leadNpc) ? b.leadNpc : '';
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
        { id: 'bi-lead', label: '목록의 대표 NPC', type: 'select', value: leadNow, options: leadOpts },
      ].concat(labelFields),
      ok: '저장',
      extra: [{ label: '원본 로그로 다시 맞추기…', run: reapplyRules }],
      run: (v) => {
        const dl = {};
        const [vis, ...w] = v;
        labelFields.forEach((f, i) => { const x = w[7 + i].trim(); if (x) dl[f.key] = x; });
        store.commit('기록 정보', { book: {
          visibility: vis,
          title: w[0].trim() || b.title, system: w[1].trim() || null, gm: w[2].trim() || null,
          players: w[3].split(',').map((x) => x.trim()).filter(Boolean),
          period: { start: w[4] || null, end: w[5] || null }, diceLabels: dl, leadNpc: w[6] || null,
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
    const cur = s.role === 'npc' && s.enemy ? 'enemy' : s.role;
    ROLE_OPTS.forEach(([k, v]) => { const o = el('option', null, v); o.value = k; o.selected = cur === k; role.append(o); });
    role.title = '에너미: 금서·단장처럼 적으로 나오는 NPC. 기록 목록의 대표 NPC에서 빠져요.';
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
  function changeRole(s, pick) {
    const role = pick === 'enemy' ? 'npc' : pick;
    const next = Object.assign(clone(s), { role });
    if (pick === 'enemy') next.enemy = true; else delete next.enemy;
    store.commit(`${s.name} 역할`, { speakers: [next] });
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
      if (it.color) { const d = A.paint(el('span', 'dot'), { color: it.color }); b.append(d); }
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
  let askCancelFn = null;
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
    // 왼쪽에 붙는 추가 버튼 (예: 기록 정보의 '원본 로그로 다시 적용')
    document.querySelectorAll('#askForm .ask-extra').forEach((n) => n.remove());
    (o.extra || []).forEach((x) => {
      const b = el('button', 'btn-sm ask-extra', x.label); b.type = 'button';
      b.addEventListener('click', () => { back.hidden = true; x.run(); });
      $('askCancel').before(b);
    });
    form.onsubmit = (ev) => { ev.preventDefault(); askCancelFn = null; back.hidden = true; o.run(inputs.map((i) => i.value)); };
    askCancelFn = o.cancel || null;
    back.hidden = false;
    (inputs[0] || $('askOk')).focus();
  }

  // ── 원본 로그로 화자 규칙 다시 적용 ───────
  // 이미 가져와서 고치던 기록에 새 가져오기 규칙(이름 빠진 사담 → 알 수 없음, 내보낸 사람 줄 확정)을 소급 적용.
  // 줄은 Roll20 메시지 ID(src)로 짝을 맞추고, 예전 규칙과 새 규칙의 결과가 다른 줄만,
  // 그리고 말한 사람을 직접 고치지 않은 줄(지금 값 = 예전 규칙 결과)만 바꿈.
  let reapplyFromImages = false;
  function reapplyRules(fromImages) {
    reapplyFromImages = fromImages === true;
    const input = el('input'); input.type = 'file'; input.accept = '.html,.htm,text/html';
    input.addEventListener('cancel', backToImages);   // 파일 고르기를 취소하면 그림 목록으로
    input.addEventListener('change', () => {
      const f = input.files[0]; if (!f) { backToImages(); return; }
      const r = new FileReader();
      r.onload = () => { try { planReapply(String(r.result)); } catch (e) { A.toast(e.message || '원본 로그를 읽지 못했어요'); backToImages(); } };
      r.readAsText(f, 'utf-8');
    });
    input.click();
  }
  function backToImages() { if (reapplyFromImages) { reapplyFromImages = false; openImages(); } }
  E.planReapply = planReapply;
  function planReapply(html) {
    const raw = SL.parseRoll20(html);
    // 가져올 때 인물 id는 원본에 나온 순서대로 p1, p2… → 지금 역할을 그대로 써서 두 규칙으로 다시 만들어 봄
    const roles = {};
    raw.speakers.forEach((s, i) => { const b = store.spk.get('p' + (i + 1)); if (b) roles[s.key] = { role: b.role }; });
    const before = SL.buildBook(raw, { speakers: roles, unknownNameless: false });
    const after = SL.buildBook(raw, { speakers: roles, unknownNameless: true });
    const bySrc = new Map();
    before.entries.forEach((o, i) => {
      if (o.kind === 'system' || o.kind === 'meta' || !o.src) return;   // 컷인 진행 표시는 같은 메시지 ID를 나눠 씀
      bySrc.set(o.src, { o, n: after.entries[i] });
    });
    // 같은 메시지에서 나온 줄이 여럿(긴 글 나눔 등)이면 글은 건드리지 않음
    const srcCount = (list) => { const c = new Map(); list.forEach((x) => { if (x.src) c.set(x.src, (c.get(x.src) || 0) + 1); }); return c; };
    const nowCount = srcCount(store.book.entries); const newCount = srcCount(after.entries);
    const withSrc = store.book.entries.filter((e) => e.src && e.kind !== 'system' && e.kind !== 'meta');
    let matched = 0; let kept = 0; let nSpk = 0; let nText = 0; let nImg = 0;
    const changes = new Map();
    const get = (e) => changes.get(e.id) || clone(e);
    const PH = /\(그림\)/g;
    withSrc.forEach((e) => {
      const m = bySrc.get(e.src); if (!m) return;
      matched++;
      const { o, n } = m;
      // 1) 말한 사람: 규칙이 바꾸는 줄 중 직접 고치지 않은 줄만
      if (o.speaker !== n.speaker || !!o.uncertain !== !!n.uncertain) {
        if ((e.speaker || null) !== (o.speaker || null)) kept++;
        else {
          const c = get(e);
          c.speaker = n.speaker;
          if (e.kind === o.kind) c.kind = n.kind;
          if (n.uncertain) c.uncertain = true; else delete c.uncertain;
          changes.set(e.id, c); nSpk++;
        }
      }
      if (nowCount.get(e.src) !== 1 || newCount.get(e.src) !== 1 || e.kind === 'dice') return;
      // 2) 글 정리: 한 번도 고치지 않은 줄만 새 가져오기 결과로 (군더더기 링크 글자 빼기, 굵게·기울임 등)
      if (e.orig == null && !e.created && !e.deleted && n.text !== e.text && n.text) {
        const c = get(e); c.text = n.text; if (n.imgs) c.imgs = n.imgs; changes.set(e.id, c); nText++;
      }
      // 3) 그림 주소: '(그림)' 자리 수가 맞으면 주소를 붙임 (그림 목록에서 보고 글로 바꿀 수 있게)
      const cur = changes.get(e.id) || e;
      const holes = (cur.text.match(PH) || []).length;
      if (!cur.imgs && n.imgs && holes && holes === n.imgs.length) { const c = get(e); c.imgs = n.imgs; changes.set(e.id, c); nImg++; }
    });
    if (!withSrc.length || matched < withSrc.length * 0.5) {
      A.toast('이 기록을 가져온 원본 로그가 아닌 것 같아요. 같은 Roll20 파일을 골라 주세요.');
      backToImages();
      return;
    }
    const list = Array.from(changes.values());
    if (!list.length) { A.toast(kept ? `바꿀 줄이 없어요 (직접 고친 ${kept}줄은 그대로)` : '이미 원본과 맞아요. 바꿀 줄이 없어요.'); backToImages(); return; }
    const parts = [];
    if (nSpk) parts.push(`말한 사람 ${nSpk.toLocaleString()}줄 (이름이 빠진 사담 → 알 수 없음 등)`);
    if (nText) parts.push(`글 정리 ${nText.toLocaleString()}줄 (군더더기 글자 빼기, 굵게·기울임 살리기 — 직접 고친 적 없는 줄만)`);
    if (nImg) parts.push(`그림 주소 ${nImg.toLocaleString()}줄 ('그림 목록'에서 보고 글로 바꿀 수 있게)`);
    ask({
      title: '원본 로그로 다시 맞추기',
      note: parts.join(' · ') + '이 바뀌어요.' + (kept ? ` 말한 사람을 직접 고친 ${kept.toLocaleString()}줄은 그대로 둬요.` : '') + ' 적용한 뒤 되돌리기로 한 번에 취소할 수 있어요.',
      fields: [], ok: `${list.length.toLocaleString()}줄 적용`,
      cancel: backToImages,
      run: () => {
        store.commit(`원본 로그로 다시 맞추기 (${list.length}줄)`, { entries: list });
        A.toast(`${list.length.toLocaleString()}줄을 원본에 맞췄어요`, { label: '되돌리기', run: () => store.undo() });
        backToImages();
      },
    });
  }

  // ── 그림 목록: 로그 속 그림을 보고 글로 바꾸거나, 그림만 있는 줄을 휴지통으로 ──
  // 같은 그림(주소)이 여러 줄에 나오면 한꺼번에. 그림은 원래 주소(imgur·Roll20)에서 바로 보여 줌 (저장하지 않음)
  function imageGroups() {
    const groups = new Map();
    let missing = 0;
    store.book.entries.forEach((e) => {
      if (e.deleted) return;
      const holes = (e.text || '').match(/\(그림\)/g);
      if (!e.imgs || !e.imgs.length) { if (holes) missing += holes.length; return; }
      e.imgs.forEach((im, k) => {
        const key = im.src || 'alt:' + (im.alt || '') + ':' + e.id;
        let g = groups.get(key);
        if (!g) { g = { src: im.src, alt: im.alt, uses: [] }; groups.set(key, g); }
        g.uses.push({ e, k });
      });
    });
    return { groups: Array.from(groups.values()), missing };
  }
  function openImages() {
    const back = $('imgs') || makeImgSheet();
    const body = $('imgsBody'); body.replaceChildren();
    const { groups, missing } = imageGroups();
    const total = groups.reduce((a, g) => a + g.uses.length, 0);
    $('imgsNote').textContent = groups.length
      ? `그림 ${total.toLocaleString()}개 (서로 다른 그림 ${groups.length.toLocaleString()}개). 그림을 보고 글을 적으면 그 그림이 나온 모든 줄의 '(그림)' 자리에 들어가요. 그림은 원래 주소에서 불러와 보여 줄 뿐 저장하지 않아요.`
      : '그림 주소가 있는 줄이 없어요.';
    if (missing) {
      const box = el('div', 'img-missing');
      box.append(el('p', null, `주소를 모르는 '(그림)'이 ${missing.toLocaleString()}개 있어요. 예전에 가져온 기록이면 원본 Roll20 로그를 다시 골라 주소를 찾을 수 있어요.`));
      const b = el('button', 'btn-sm', '원본 로그에서 그림 주소 찾기…'); b.type = 'button';
      b.addEventListener('click', () => { $('imgs').hidden = true; reapplyRules(true); });   // 그림 목록은 닫고, 끝나면 다시 열림
      box.append(b); body.append(box);
    }
    groups.forEach((g, gi) => body.append(imageRow(g, gi)));
    if (back.hidden) { back.hidden = false; $('imgsClose').focus(); }
  }
  function makeImgSheet() {
    const back = el('div', 'sheet-backdrop'); back.id = 'imgs'; back.hidden = true;
    const sh = el('div', 'sheet sheet-wide'); sh.setAttribute('role', 'dialog'); sh.setAttribute('aria-modal', 'true'); sh.setAttribute('aria-labelledby', 'imgsTitle');
    const head = el('div', 'sheet-head'); const h = el('h2', null, '그림 목록'); h.id = 'imgsTitle';
    const x = el('button', 'icon-btn', '✕'); x.type = 'button'; x.id = 'imgsClose'; x.setAttribute('aria-label', '닫기');
    x.addEventListener('click', () => { back.hidden = true; });
    head.append(h, x);
    const note = el('p', 'sheet-note'); note.id = 'imgsNote';
    const body = el('div', 'img-list'); body.id = 'imgsBody';
    sh.append(head, note, body); back.append(sh);
    back.addEventListener('click', (ev) => { if (ev.target === back) back.hidden = true; });
    document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape' && !back.hidden) back.hidden = true; });
    document.body.append(back);
    return back;
  }
  function imageRow(g, gi) {
    const row = el('div', 'img-row'); row.dataset.src = g.src || '';
    const th = el('div', 'img-thumb');
    if (g.src) {
      const a = el('a'); a.href = g.src; a.target = '_blank'; a.rel = 'noopener noreferrer'; a.title = '원래 크기로 보기 (새 탭)';
      const img = el('img'); img.src = g.src; img.alt = g.alt && !/^(img|image|그림|이미지)$/i.test(g.alt) ? g.alt : '로그 속 그림'; img.loading = 'lazy'; img.referrerPolicy = 'no-referrer';
      img.addEventListener('error', () => {
        const l = el('a', 'small', '불러오지 못했어요 · 새 탭에서 열기'); l.href = g.src; l.target = '_blank'; l.rel = 'noopener noreferrer';
        th.replaceChildren(l);
      }, { once: true });
      a.append(img); th.append(a);
    } else th.append(el('span', 'muted small', '주소 없음'));
    const info = el('div', 'img-info');
    const first = g.uses[0].e;
    const who = first.speaker ? (store.spk.get(first.speaker) || {}).name : KIND_NAME[first.kind];
    const where = el('p', 'img-where');
    where.append(el('b', null, `${g.uses.length}곳`), document.createTextNode(` · 처음: ${A.sessionLabel(A.sessionOf(first.session))} · ${who || ''}`));
    if (g.alt && !/^(img|image|그림|이미지)$/i.test(g.alt)) where.append(document.createTextNode(` · 설명 '${g.alt}'`));
    const go = el('button', 'linkish', '그 줄로'); go.type = 'button';
    go.addEventListener('click', () => { $('imgs').hidden = true; const n = document.getElementById(first.id); if (n) { n.scrollIntoView({ block: 'center' }); n.classList.add('is-target'); } });
    where.append(document.createTextNode(' '), go);
    const ctx = el('p', 'img-ctx'); ctx.textContent = first.text.length > 90 ? first.text.slice(0, 90) + '…' : first.text;
    const form = el('form', 'img-form');
    const inp = el('input'); inp.id = 'imgTxt-' + gi; inp.placeholder = "그림 대신 넣을 글 (예: [지도] 제헤스트 시내)"; inp.maxLength = 500;
    inp.setAttribute('aria-label', '그림 대신 넣을 글');
    const ok = el('button', 'btn-sm primary', '글로 바꾸기'); ok.type = 'submit';
    form.append(inp, ok);
    form.addEventListener('submit', (ev) => { ev.preventDefault(); const v = inp.value.trim(); if (!v) { inp.focus(); return; } replaceImage(g, v); });
    // 주사위 그림이면: 눈을 적어 주사위로 (그림만 있는 줄은 주사위 카드로, 글 사이에 있으면 주사위 눈 글자로)
    const dform = el('form', 'img-form img-dice');
    const dv = el('input'); dv.id = 'imgDice-' + gi; dv.placeholder = '주사위 눈 (예: 3 또는 2 5)'; dv.inputMode = 'numeric'; dv.maxLength = 60;
    dv.setAttribute('aria-label', '주사위 눈');
    const ds = el('select'); ds.id = 'imgSides-' + gi; ds.setAttribute('aria-label', '주사위 면 수');
    [4, 6, 8, 10, 12, 20, 100].forEach((n) => { const o = el('option', null, 'd' + n); o.value = String(n); o.selected = n === 6; ds.append(o); });
    const dm = el('select'); dm.id = 'imgDiceMode-' + gi; dm.setAttribute('aria-label', '글 사이에 있을 때');
    [['card', '카드로 (글 사이면 줄을 나눔)'], ['glyph', '글 사이에는 눈 글자로']].forEach(([v, t]) => { const o = el('option', null, t); o.value = v; dm.append(o); });
    const dok = el('button', 'btn-sm', '주사위로 바꾸기'); dok.type = 'submit';
    dform.append(dv, ds, dm, dok);
    dform.addEventListener('submit', (ev) => {
      ev.preventDefault();
      const sides = Number(ds.value);
      const faces = dv.value.split(/[\s,，、+]+/).filter(Boolean).map(Number);
      if (!faces.length || faces.some((n) => !Number.isInteger(n) || n < 1 || n > sides)) { A.toast(`1~${sides} 사이 숫자를 띄어쓰기로 적어 주세요`); dv.focus(); return; }
      diceFromImage(g, faces, sides, dm.value);
    });
    info.append(where, ctx, form, dform);
    const onlyImg = g.uses.filter(({ e }) => e.text.trim() === '(그림)');
    if (onlyImg.length) {
      const del = el('button', 'btn-sm danger', `그림만 있는 줄 ${onlyImg.length}개 휴지통으로`); del.type = 'button';
      del.addEventListener('click', () => {
        const ch = onlyImg.map(({ e }) => Object.assign(clone(e), { deleted: true }));
        store.commit(`그림 줄 휴지통으로 (${ch.length}줄)`, { entries: ch });
        A.toast(`${ch.length}줄을 휴지통으로 옮겼어요`, { label: '되돌리기', run: () => { store.undo(); openImages(); } });
        openImages();
      });
      info.append(del);
    }
    row.append(th, info);
    return row;
  }
  const DIE_CHAR = ['⚀', '⚁', '⚂', '⚃', '⚄', '⚅'];
  function manualDice(faces, sides) {
    const sum = faces.reduce((a, b) => a + b, 0);
    const d = { template: 'manual', kind: 'roll', rolls: [`${faces.length}d${sides}`], dice: faces.slice(), sides: faces.map(() => sides), total: sum };
    if (faces.length > 1) d.sum = sum;
    return d;
  }
  // 글 사이의 그림 → 줄을 나눠 [앞 글] [주사위 카드] [뒤 글]. 앞 조각이 원래 줄 id를 이어받음
  function splitForDice(e, ks, dice) {
    const parts = []; let buf = ''; let bufImgs = []; let last = 0; let occ = -1;
    const re = /\(그림\)/g; let m;
    while ((m = re.exec(e.text))) {
      occ++;
      const before = e.text.slice(last, m.index); last = m.index + m[0].length;
      if (ks.has(occ)) { buf += before; parts.push({ t: 'text', text: buf, imgs: bufImgs }); parts.push({ t: 'dice' }); buf = ''; bufImgs = []; }
      else { buf += before + m[0]; if (e.imgs && e.imgs[occ]) bufImgs.push(e.imgs[occ]); }
    }
    buf += e.text.slice(last); parts.push({ t: 'text', text: buf, imgs: bufImgs });
    const items = parts.filter((p) => p.t === 'dice' || p.text.trim());
    const out = []; const newIds = []; const map = {};
    items.forEach((p, i) => {
      const n = i === 0 ? clone(e) : { id: store.newId(), seq: 0, session: e.session, kind: e.kind, speaker: e.speaker, text: '', ts: e.ts, created: true };
      if (i === 0 && n.orig == null && !n.created) n.orig = e.text;
      delete n.imgs; delete n.dice;
      if (p.t === 'dice') { n.kind = 'dice'; n.text = ''; n.dice = Object.assign({}, dice); delete n.say; }
      else { n.kind = e.kind; n.text = p.text.trim(); if (p.imgs.length) n.imgs = p.imgs; }
      if (i === 0) out.push(n); else { newIds.push(n.id); map[n.id] = n; }
    });
    return newIds.length ? out.concat(placeChanges(newIds, e.session, e.id, map)) : out;
  }
  function diceFromImage(g, faces, sides, mode) {
    const byE = new Map();
    g.uses.forEach(({ e, k }) => { if (!byE.has(e.id)) byE.set(e.id, new Set()); byE.get(e.id).add(k); });
    const inline = sides === 6 ? faces.map((n) => DIE_CHAR[n - 1]).join('') : `[d${sides}: ${faces.join(', ')}]`;
    const dice = manualDice(faces, sides);
    const ch = []; let cards = 0;
    byE.forEach((ks, id) => {
      const e = store.byId.get(id); const n = clone(e);
      const onlyImg = e.text.trim() === '(그림)' && (e.imgs || []).length === 1;
      if (onlyImg || mode !== 'glyph') {
        // 주사위 카드로 (그림만 있는 줄은 그 줄이, 글 사이면 줄을 나눠서). 말한 사람은 그대로
        splitForDice(e, ks, dice).forEach((x) => ch.push(x));
        cards++;
        return;
      }
      {
        let occ = -1;
        n.text = e.text.replace(/\(그림\)/g, (m0) => { occ++; return ks.has(occ) ? inline : m0; });
        n.imgs = (e.imgs || []).filter((_, k) => !ks.has(k));
        if (!n.imgs.length) delete n.imgs;
        if (n.orig == null && !n.created) n.orig = e.text;
      }
      ch.push(n);
    });
    store.commit(`그림 → 주사위 (${ch.length}줄)`, { entries: ch });
    const glyphs = byE.size - cards;
    A.toast(glyphs ? `${byE.size}줄을 바꿨어요 (주사위 카드 ${cards}줄, 글 사이 주사위 눈 ${glyphs}줄)` : `${cards}줄의 그림을 주사위 카드로 바꿨어요`,
      { label: '되돌리기', run: () => { store.undo(); openImages(); } });
    openImages();
  }
  function replaceImage(g, text) {
    const byE = new Map();
    g.uses.forEach(({ e, k }) => { if (!byE.has(e.id)) byE.set(e.id, new Set()); byE.get(e.id).add(k); });
    const ch = [];
    byE.forEach((ks, id) => {
      const e = store.byId.get(id); const n = clone(e);
      let occ = -1;
      n.text = e.text.replace(/\(그림\)/g, (m0) => { occ++; return ks.has(occ) ? text : m0; });
      n.imgs = (e.imgs || []).filter((_, k) => !ks.has(k));
      if (!n.imgs.length) delete n.imgs;
      if (n.orig == null && !n.created) n.orig = e.text;   // '원문으로 되돌리기' 가능하게
      ch.push(n);
    });
    store.commit(`그림 → 글 (${ch.length}줄)`, { entries: ch });
    A.toast(`${ch.length}줄의 그림을 글로 바꿨어요`, { label: '되돌리기', run: () => { store.undo(); openImages(); } });
    openImages();
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
    $('eImages').addEventListener('click', openImages);
    let armed = 0;
    $('eReset').addEventListener('click', () => {
      if (!armed) { $('eReset').textContent = '정말 모두 지울까요? 한 번 더'; armed = setTimeout(() => { armed = 0; $('eReset').textContent = '수정 모두 지우기'; }, 3500); return; }
      clearTimeout(armed); armed = 0; $('eReset').textContent = '수정 모두 지우기';
      store.resetLocal(); A.renderHead(); A.render(); A.toast('이 브라우저의 수정을 모두 지웠어요');
    });

    $('bulkKind').addEventListener('click', (ev) => { ev.stopPropagation(); kindMenu($('bulkKind'), selectedInOrder()); });
    $('bulkWho').addEventListener('click', (ev) => { ev.stopPropagation(); speakerMenu($('bulkWho'), selectedInOrder()); });
    $('bulkMove').addEventListener('click', () => setMoving(!E.moving));
    $('bulkDelete').addEventListener('click', () => trash(selectedInOrder()));
    $('bulkNovel').addEventListener('click', () => { const ids = selectedInOrder(); setNovelHide(ids, !ids.every((id) => store.byId.get(id).nvHide)); });
    $('bulkRestore').addEventListener('click', () => restore(selectedInOrder()));
    $('bulkClear').addEventListener('click', clearSel);

    $('askCancel').addEventListener('click', () => { $('ask').hidden = true; const f = askCancelFn; askCancelFn = null; if (f) f(); });
    $('ask').addEventListener('click', (ev) => { if (ev.target === $('ask')) $('ask').hidden = true; });

    document.addEventListener('keydown', (ev) => {
      if (!E.active) return;
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement && document.activeElement.tagName);
      if (ev.key === 'Escape') {
        if (menuEl) { closeMenu(); return; }
        if (!$('ask').hidden) { $('ask').hidden = true; return; }
        if (E.moving) { setMoving(false); return; }
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
