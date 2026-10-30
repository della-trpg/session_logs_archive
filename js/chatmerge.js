/*
 * 사담 로그 끼워 넣기 — 대사 로그와 따로 남은 사담 로그(시각만 있는 텍스트, 또는 Roll20 HTML)를
 * 시간순으로 기록 사이에 끼워 넣음. 편집(관리자) 전용. 되돌리기 한 번으로 취소.
 *
 * 텍스트 모양:  21:19:32        또는  [21:19:32] 리스: 저 왔어요
 *              리스: 저 왔어요
 * 날짜가 없어서: 시각이 3시간 넘게 끊기면 '묶음'(보통 세션 하루)으로 나누고, 묶음마다
 * 기록의 어느 날짜와 시간이 가장 많이 겹치는지 찾아 자동으로 고름 → 사람이 확인·변경.
 * 사용자 글은 전부 textContent로.
 */
(function () {
  'use strict';
  const SL = window.SL;
  const A = () => SL.app;
  const el = (...a) => A().el(...a);
  const $ = (id) => document.getElementById(id);

  const GAP = 3 * 3600;          // 이보다 오래 끊기면 다른 묶음
  const NEAR = 3;                // 같은 사담으로 볼 시간 차 (분)
  const PL_COLORS = ['#7d8a96', '#8e8597', '#8a8f7c', '#977f7f', '#7c8f95', '#8f8a7a'];
  const ZW = /[​-‍⁠﻿]/g;
  const pad = (n) => String(n).padStart(2, '0');

  // ── 읽기 ────────────────────────────────
  // → [{ sec, name, text }] (sec = 그날 0시부터 초) 또는 HTML이면 [{ min(절대 분), name, text }]
  function parseText(text) {
    const lines = text.replace(/\r/g, '').split('\n');
    const msgs = []; let t = null; let afterTime = false;
    lines.forEach((raw) => {
      const l = raw.replace(ZW, '');
      const tm = l.trim().match(/^\[?(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?\]?$/);
      if (tm) { t = Number(tm[1]) * 3600 + Number(tm[2]) * 60 + Number(tm[3] || 0); afterTime = true; return; }
      const one = l.match(/^\[?(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?\]?\s+([^:]{1,40}?)\s*:\s?(.*)$/);   // 한 줄 모양
      if (one) { msgs.push({ sec: Number(one[1]) * 3600 + Number(one[2]) * 60 + Number(one[3] || 0), name: one[4].trim(), text: one[5] }); afterTime = false; return; }
      const m = l.match(/^([^:]{1,40}?)\s*:\s?(.*)$/);
      if (afterTime && m && t != null) { msgs.push({ sec: t, name: m[1].trim(), text: m[2] }); afterTime = false; return; }
      if (msgs.length && l.trim()) msgs[msgs.length - 1].text += '\n' + l;   // 여러 줄 메시지
      afterTime = false;
    });
    return msgs.map((x) => Object.assign(x, { text: x.text.trim() })).filter((x) => x.text && x.name);
  }
  function parseHtml(html) {
    const raw = SL.parseRoll20(html);
    const names = new Map(raw.speakers.map((s) => [s.key, s.name]));
    return raw.entries.filter((e) => (e.kind === 'talk' || e.kind === 'narration') && e.text && e.ts)
      .map((e) => ({ min: tsMin(e.ts), name: (e.speaker && names.get(e.speaker)) || '알 수 없음', text: e.text }));
  }
  function tsMin(ts) {
    const m = String(ts || '').match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/);
    return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) / 60000 : null;
  }
  const dayMin = (d) => { const [y, m, dd] = d.split('-').map(Number); return Date.UTC(y, m - 1, dd) / 60000; };
  const minTs = (min) => { const d = new Date(min * 60000); return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`; };
  const fmtSec = (s) => `${Math.floor(s / 3600) % 24}:${pad(Math.floor(s / 60) % 60)}`;

  // 시각만 있는 메시지 → 묶음 (자정을 넘기면 다음 날로 이어 셈)
  function blocksOf(msgs) {
    const blocks = []; let cur = null; let day = 0; let last = null;
    msgs.forEach((x) => {
      if (last != null && x.sec < last) day++;
      const abs = day * 86400 + x.sec;
      if (!cur || abs - cur.lastAbs > GAP) { cur = { msgs: [], startDay: day, lastAbs: abs }; blocks.push(cur); }
      cur.msgs.push(Object.assign({}, x, { off: abs - cur.startDay * 86400 })); cur.lastAbs = abs;
      last = x.sec;
    });
    return blocks;
  }

  // ── 기록 쪽 시간표 ───────────────────────
  function timeline() {
    const store = A().store;
    const main = store.allEntries(true);
    let carry = null;
    const mins = main.map((e) => { const m = tsMin(e.ts); if (m != null) carry = m; return carry; });
    const sorted = mins.filter((m) => m != null).sort((a, b) => a - b);
    // 기록의 '밤'(플레이한 날): 3시간 넘게 끊긴 곳에서 나눔. 자정을 넘겨도 같은 밤
    const nights = [];
    const idx = main.map((e, i) => i).filter((i) => mins[i] != null && tsMin(main[i].ts) != null).sort((a, b) => mins[a] - mins[b]);
    let cur = null;
    idx.forEach((i) => {
      const m = mins[i];
      if (!cur || m - cur.end > GAP / 60) { cur = { start: m, end: m, sess: new Map() }; nights.push(cur); }
      cur.end = m;
      if (main[i].kind !== 'meta') cur.sess.set(main[i].session, (cur.sess.get(main[i].session) || 0) + 1);
    });
    nights.forEach((n) => {
      n.date = minTs(n.start).slice(0, 10);
      n.base = dayMin(n.date);
      let best = null; let c = -1; n.sess.forEach((v, k) => { if (v > c) { c = v; best = k; } }); n.session = best;
    });
    return { main, mins, sorted, nights };
  }
  const near = (sorted, m) => {   // m 근처(±NEAR분)에 기록 줄이 있나
    let lo = 0; let hi = sorted.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (sorted[mid] < m - NEAR) lo = mid + 1; else hi = mid; }
    return lo < sorted.length && sorted[lo] <= m + NEAR;
  };
  // 묶음이 그 밤에 있었다고 볼 때 얼마나 맞나: 기록 줄과 시간이 겹치는 비율 × 시작~끝 구간이 겹치는 정도
  function scoreOn(block, night, tl) {
    let hit = 0;
    block.msgs.forEach((x) => { if (near(tl.sorted, night.base + Math.floor(x.off / 60))) hit++; });
    const dens = hit / block.msgs.length;
    const bs = night.base + Math.floor(block.msgs[0].off / 60) - 5; const be = night.base + Math.floor(block.msgs[block.msgs.length - 1].off / 60) + 5;
    const inter = Math.max(0, Math.min(be, night.end + 5) - Math.max(bs, night.start - 5));
    const uni = Math.max(be, night.end + 5) - Math.min(bs, night.start - 5);
    const iou = uni > 0 ? inter / uni : 0;
    return dens * (0.4 + 0.6 * iou);
  }
  // 묶음들을 시간 순서를 지키며(뒤 묶음이 앞 묶음보다 이른 밤으로 가지 않게) 가장 잘 맞는 밤에
  function assign(blocks, tl) {
    const B = blocks.length; const N = tl.nights.length;
    const sc = blocks.map((b) => tl.nights.map((n) => scoreOn(b, n, tl)));
    const memo = new Map();
    const go = (i, j) => {   // 묶음 i부터, 앞에서 쓴 마지막 밤이 j일 때 최고 점수
      if (i === B) return { v: 0, pick: [] };
      const key = i + ':' + j; if (memo.has(key)) return memo.get(key);
      const skip = go(i + 1, j);
      let res = { v: skip.v, pick: [-1].concat(skip.pick) };   // 넣지 않기
      for (let k = Math.max(0, j); k < N; k++) {
        if (sc[i][k] < 0.2) continue;
        const r = go(i + 1, k);
        if (r.v + sc[i][k] > res.v) res = { v: r.v + sc[i][k], pick: [k].concat(r.pick) };
      }
      memo.set(key, res); return res;
    };
    const picks = go(0, -1).pick;
    blocks.forEach((b, i) => { b.scores = sc[i]; b.best = picks[i]; b.score = picks[i] >= 0 ? sc[i][picks[i]] : 0; });
  }

  // ── 열기 ────────────────────────────────
  SL.chatMerge = { open: pickFile, parseText, blocksOf };
  function pickFile() {
    const input = el('input'); input.type = 'file'; input.accept = '.txt,.html,.htm,text/plain,text/html';
    input.addEventListener('change', () => {
      const f = input.files[0]; if (!f) return;
      const r = new FileReader();
      r.onload = () => { try { plan(String(r.result), f.name); } catch (e) { A().toast(e.message || '사담 로그를 읽지 못했어요'); } };
      r.readAsText(f, 'utf-8');
    });
    input.click();
  }

  let state = null;
  function plan(text, fileName) {
    const tl = timeline();
    const isHtml = /class="message/.test(text);
    let blocks;
    if (isHtml) {
      // Roll20 HTML: 날짜가 있으니 날짜마다 한 묶음, 그 날짜에 바로 맞춤
      const msgs = parseHtml(text);
      const byDay = new Map();
      msgs.forEach((x) => { const d = minTs(x.min).slice(0, 10); if (!byDay.has(d)) byDay.set(d, []); byDay.get(d).push(x); });
      blocks = Array.from(byDay.entries()).map(([d, list]) => ({ exact: true, date: d,
        msgs: list.map((x) => Object.assign({}, x, { off: (x.min - dayMin(d)) * 60 })) }));
    } else blocks = blocksOf(parseText(text));
    const total = blocks.reduce((a, b) => a + b.msgs.length, 0);
    if (!total) { A().toast('사담을 찾지 못했어요. "시각 줄 + 이름: 글" 모양의 텍스트나 Roll20 HTML을 골라 주세요.'); return; }
    if (!blocks.some((b) => b.exact)) assign(blocks, tl);
    blocks.forEach((b) => {
      if (b.exact) { b.choice = 'date:' + b.date; return; }
      b.choice = b.best >= 0 ? 'night:' + b.best : 'skip';
    });
    // 이름 → 인물
    const names = Array.from(new Set(blocks.flatMap((b) => b.msgs.map((x) => x.name))));
    const byName = new Map(A().store.book.speakers.map((s) => [s.name.replace(ZW, '').trim().toLowerCase(), s.id]));
    const who = {}; names.forEach((n) => { who[n] = byName.get(n.toLowerCase()) || '+new'; });
    state = { tl, blocks, who, fileName, dedupe: true };
    draw();
  }

  // ── 확인 창 ─────────────────────────────
  function sheet() {
    let back = $('cmerge'); if (back) return back;
    back = el('div', 'sheet-backdrop'); back.id = 'cmerge'; back.hidden = true;
    const sh = el('div', 'sheet sheet-wide'); sh.setAttribute('role', 'dialog'); sh.setAttribute('aria-modal', 'true'); sh.setAttribute('aria-labelledby', 'cmTitle');
    const head = el('div', 'sheet-head'); const h = el('h2', null, '사담 로그 끼워 넣기'); h.id = 'cmTitle';
    const x = el('button', 'icon-btn', '✕'); x.type = 'button'; x.setAttribute('aria-label', '닫기'); x.addEventListener('click', () => { back.hidden = true; });
    head.append(h, x);
    const note = el('p', 'sheet-note'); note.id = 'cmNote';
    const body = el('div', 'cm-body'); body.id = 'cmBody';
    const acts = el('div', 'ask-acts');
    const cancel = el('button', 'btn-sm', '취소'); cancel.type = 'button'; cancel.addEventListener('click', () => { back.hidden = true; });
    const ok = el('button', 'btn-sm primary', '끼워 넣기'); ok.type = 'button'; ok.id = 'cmOk'; ok.addEventListener('click', apply);
    acts.append(cancel, ok);
    sh.append(head, note, body, acts); back.append(sh);
    back.addEventListener('click', (ev) => { if (ev.target === back) back.hidden = true; });
    document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape' && !back.hidden) back.hidden = true; });
    document.body.append(back);
    return back;
  }
  function draw() {
    const back = sheet();
    const { blocks, tl } = state;
    const book = A().store.book;
    const total = blocks.reduce((a, b) => a + b.msgs.length, 0);
    $('cmNote').textContent = `${state.fileName} · 사담 ${total.toLocaleString()}줄, 묶음 ${blocks.length}개. ` +
      '시각이 3시간 넘게 끊긴 곳에서 묶음을 나눴어요. 묶음마다 기록에서 시간이 가장 많이 겹치는 날짜를 골라 뒀으니 확인해 주세요. 끼워 넣은 뒤 되돌리기 한 번으로 취소할 수 있어요.';
    const body = $('cmBody'); body.replaceChildren();
    const sessLabel = (no) => (no == null ? '' : A().sessionLabel(A().sessionOf(no)));
    blocks.forEach((b, i) => {
      const row = el('div', 'cm-block');
      const first = b.msgs[0]; const last = b.msgs[b.msgs.length - 1];
      const title = el('p', 'cm-title');
      title.append(el('b', null, `묶음 ${i + 1}`), document.createTextNode(` · ${b.exact ? b.date + ' ' : ''}${fmtSec(first.off)} ~ ${fmtSec(last.off)}${last.off >= 86400 ? ' (다음 날)' : ''} · ${b.msgs.length.toLocaleString()}줄`));
      const peek = el('p', 'cm-peek'); peek.textContent = b.msgs.slice(0, 3).map((x) => `${x.name}: ${x.text}`).join(' / ').slice(0, 140);
      const sel = el('select'); sel.id = 'cmSel-' + i; sel.setAttribute('aria-label', `묶음 ${i + 1} 넣을 곳`);
      const opts = [];
      if (b.exact) opts.push(['date:' + b.date, `${b.date} 시간 맞춰 끼우기 (로그에 날짜가 있음)`]);
      else tl.nights.forEach((n, k) => {
        const s = b.scores[k];
        if (s < 0.05 && k !== b.best) return;   // 거의 안 맞는 밤은 목록에서 뺌
        opts.push(['night:' + k, `${n.date} ${minTs(n.start).slice(11)}~${minTs(n.end).slice(11)} (${sessLabel(n.session)}) 시간 맞춰 끼우기 · 맞음 ${Math.round(s * 100)}%${k === b.best ? ' · 추천' : ''}`]);
      });
      book.sessions.forEach((s) => { if (A().store.entries(s.no).length) opts.push(['start:' + s.no, `${A().sessionLabel(s)} 맨 앞에 (시간 무시)`]); });
      book.sessions.forEach((s) => { if (A().store.entries(s.no).length) opts.push(['end:' + s.no, `${A().sessionLabel(s)} 맨 뒤에 (시간 무시)`]); });
      opts.push(['skip', '넣지 않기']);
      opts.forEach(([v, t]) => { const o = el('option', null, t); o.value = v; o.selected = v === b.choice; sel.append(o); });
      sel.addEventListener('change', () => { b.choice = sel.value; count(); });
      row.append(title, peek, sel);
      body.append(row);
    });
    // 이름 → 인물
    const names = Object.keys(state.who);
    const ppl = el('div', 'cm-people');
    ppl.append(el('h3', 'ask-group', '사담 로그의 이름 → 인물'));
    names.forEach((n, i) => {
      const r = el('label', 'ask-field'); r.htmlFor = 'cmWho-' + i;
      r.append(el('span', null, n));
      const s = el('select'); s.id = 'cmWho-' + i;
      [['+new', '새 플레이어로 추가']].concat(A().orderedSpeakers().map((x) => [x.id, x.name])).forEach(([v, t]) => { const o = el('option', null, t); o.value = v; o.selected = state.who[n] === v; s.append(o); });
      s.addEventListener('change', () => { state.who[n] = s.value; });
      r.append(s); ppl.append(r);
    });
    const dd = el('label', 'cm-check'); const cb = el('input'); cb.type = 'checkbox'; cb.id = 'cmDedupe'; cb.checked = state.dedupe;
    cb.addEventListener('change', () => { state.dedupe = cb.checked; });
    dd.append(cb, document.createTextNode(` 기록에 이미 있는 같은 사담은 건너뛰기 (같은 사람·같은 글, ±${NEAR}분)`));
    ppl.append(dd);
    body.append(ppl);
    count();
    if (back.hidden) { back.hidden = false; $('cmSel-0') && $('cmSel-0').focus(); }
  }
  function count() {
    const n = state.blocks.filter((b) => b.choice !== 'skip').reduce((a, b) => a + b.msgs.length, 0);
    $('cmOk').textContent = n ? `${n.toLocaleString()}줄 끼워 넣기` : '끼워 넣기';
    $('cmOk').disabled = !n;
  }

  // ── 끼워 넣기 ───────────────────────────
  function apply() {
    const store = A().store;
    const { tl } = state;
    const main = tl.main;
    // 새 인물
    const speakers = [];
    let maxP = Math.max(0, ...store.book.speakers.map((s) => Number(String(s.id).replace(/\D/g, '')) || 0));
    const nameToId = {};
    Object.entries(state.who).forEach(([n, v]) => {
      if (v !== '+new') { nameToId[n] = v; return; }
      const id = 'p' + (++maxP);
      speakers.push({ id, name: n.slice(0, 40), role: 'pl', player: null, color: PL_COLORS[speakers.length % PL_COLORS.length], charId: null, image: null });
      nameToId[n] = id;
    });
    // 이미 있는 사담 (같은 사람·같은 글 → 분 목록)
    const have = new Map();
    if (state.dedupe) main.forEach((e, i) => {
      if (e.kind !== 'chat' || e.deleted || tl.mins[i] == null) return;
      const k = (e.speaker || '') + '|' + (e.text || '').replace(/\s+/g, '');
      if (!have.has(k)) have.set(k, []); have.get(k).push(tl.mins[i]);
    });
    // 기록 줄 i 앞에 넣을 사담들
    const before = new Map(); const push = (i, x) => { if (!before.has(i)) before.set(i, []); before.get(i).push(x); };
    let skipped = 0; let added = 0;
    state.blocks.forEach((b) => {
      if (b.choice === 'skip') return;
      const [how, arg] = b.choice.split(':');
      if (how === 'date' || how === 'night') {
        const base = how === 'date' ? dayMin(arg) : tl.nights[Number(arg)].base;
        let j = 0;
        b.msgs.forEach((x) => {
          const m = base + Math.floor(x.off / 60);
          const sid = nameToId[x.name] || null;
          const k = (sid || '') + '|' + x.text.replace(/\s+/g, '');
          if (state.dedupe && (have.get(k) || []).some((t) => Math.abs(t - m) <= NEAR)) { skipped++; return; }
          while (j < main.length && (tl.mins[j] == null || tl.mins[j] <= m)) j++;   // 같은 분의 기록 줄 뒤에
          push(j, { x, min: m, sid }); added++;
        });
      } else {
        const no = Number(arg);
        let at = main.findIndex((e) => e.session === no);
        if (how === 'end') { let last = -1; main.forEach((e, i) => { if (e.session === no) last = i; }); at = last + 1; }
        if (at < 0) return;
        b.msgs.forEach((x) => { push(at, { x, min: null, sid: nameToId[x.name] || null, sess: no }); added++; });
      }
    });
    if (!added) { A().toast(skipped ? `넣을 사담이 없어요 (이미 있는 ${skipped}줄은 건너뜀)` : '넣을 사담이 없어요'); return; }
    // 합친 순서대로 순서값을 다시 매김
    const merged = [];
    const fit = SL._fit;
    const make = (y) => {
      const parts = fit && y.x.text.length > fit.MAX_TEXT ? fit.splitText(y.x.text) : [y.x.text];
      return parts.map((t) => ({ id: store.newId(), seq: 0, session: null, kind: 'chat', speaker: y.sid, text: t, ts: y.min != null ? minTs(y.min) : null, src: null, from: 'chatlog', _sess: y.sess }));
    };
    for (let i = 0; i <= main.length; i++) {
      (before.get(i) || []).forEach((y) => make(y).forEach((n) => merged.push(n)));
      if (i < main.length) merged.push(main[i]);
    }
    // 회차: '맨 앞에/뒤에'로 고른 건 그 회차. 시간으로 끼운 건 앞뒤 기록 줄 중 시간이 더 가까운 쪽의 회차
    // (세션 시작 전 사담이 지난 회차 끝에 붙지 않게)
    const isNew = (e) => e.from === 'chatlog' && e.seq === 0;
    const minOf = new Map(main.map((e, i) => [e.id, tl.mins[i]]));
    const prevMain = []; let pm = null;
    merged.forEach((e, k) => { prevMain[k] = pm; if (!isNew(e)) pm = e; });
    const nextMain = []; let nm = null;
    for (let k = merged.length - 1; k >= 0; k--) { nextMain[k] = nm; if (!isNew(merged[k])) nm = merged[k]; }
    merged.forEach((e, k) => {
      if (!isNew(e)) return;
      if (e._sess != null) { e.session = e._sess; return; }
      const p = prevMain[k]; const n = nextMain[k];
      if (!p || !n) { e.session = (p || n || { session: 0 }).session; return; }
      const tm = tsMin(e.ts); const pt = minOf.get(p.id); const nt = minOf.get(n.id);
      e.session = tm != null && pt != null && nt != null && nt - tm < tm - pt ? n.session : p.session;
    });
    const changes = [];
    merged.forEach((e, k) => {
      const seq = (k + 1) * 1000;
      if (e.from === 'chatlog' && e.seq === 0) { const n = Object.assign({}, e, { seq }); delete n._sess; if (n.session == null) n.session = 0; changes.push(n); }
      else if (e.seq !== seq) changes.push(Object.assign(SL.clone(e), { seq }));
    });
    $('cmerge').hidden = true;
    store.commit(`사담 로그 끼워 넣기 (${added}줄)`, { entries: changes, speakers });
    A().toast(`사담 ${added.toLocaleString()}줄을 끼워 넣었어요${skipped ? ` (이미 있던 ${skipped.toLocaleString()}줄은 건너뜀)` : ''}`, { label: '되돌리기', run: () => store.undo() });
  }
})();
