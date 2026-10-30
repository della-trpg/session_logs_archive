/*
 * 세션 기록 — 채팅 로그 보기
 * 사용자 글은 전부 textContent/텍스트 노드로 넣는다. (innerHTML 금지)
 */
(function () {
  'use strict';

  const SL = window.SL;
  const CFG = window.SL_CONFIG || {};
  const $ = (id) => document.getElementById(id);
  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };

  const prefs = {
    get(k, d) { try { const v = localStorage.getItem('sl:' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem('sl:' + k, JSON.stringify(v)); } catch (e) { /* 저장 안 돼도 화면은 동작 */ } },
  };

  const KINDS = [
    { key: 'dialogue', label: '대사' },
    { key: 'narration', label: '나레이션' },
    { key: 'dice', label: '주사위' },
    { key: 'system', label: '진행 표시' },
    { key: 'chat', label: '사담' },
  ];
  const DEFAULT_FILTERS = { dialogue: true, narration: true, dice: true, system: true, chat: false };
  const WEEK = ['일', '월', '화', '수', '목', '금', '토'];
  const RESULT_LABEL = { success: '성공', fail: '실패', special: '스페셜', fumble: '펌블' };
  // 주사위 카드 이름표 기본값. 기록마다 book.diceLabels로, 카드마다 dice.label로 바꿀 수 있음
  const DICE_LABELS = { roll: '굴림', check: '특기 판정', spell: '마법', equip: '장비', table: '표', pick: '특기 결정', other: '판정' };
  const PIPS = { 1: [5], 2: [1, 9], 3: [1, 5, 9], 4: [1, 3, 7, 9], 5: [1, 3, 5, 7, 9], 6: [1, 3, 4, 6, 7, 9] };
  const SWATCHES = ['#3f8f7a', '#b4664a', '#6d6bc4', '#b08a2e', '#4f84b8', '#a85a8e', '#6f8f3a', '#c0504d', '#3d7ea6', '#8a6d5a', '#7d8a96', '#5c5f6b'];

  const store = new SL.Store();
  const S = {
    view: prefs.get('view', 'all'),           // all = 전체 로그, session = 회차별
    session: 1,
    active: null,                              // 전체 보기에서 지금 화면에 있는 회차
    filters: Object.assign({}, DEFAULT_FILTERS, prefs.get('filters', {})),
    focus: null,
    showTime: prefs.get('showTime', false),
    size: prefs.get('size', 'm'),
    theme: prefs.get('theme', 'auto'),
    castOpen: prefs.get('castOpen', false),
    q: '', marks: [], mi: -1,
  };

  // 받침에 따라 을/를
  function withObj(w) {
    const c = w.charCodeAt(w.length - 1) - 0xac00;
    return w + (c >= 0 && c < 11172 && c % 28 ? '을' : '를');
  }

  // ── 날짜·시간 ──────────────────────────
  function fmtDate(d, withWeek) {
    if (!d) return '';
    const [y, m, dd] = d.split('-');
    let s = `${y}.${m}.${dd}`;
    if (withWeek) { const w = new Date(`${d}T00:00:00`).getDay(); if (!Number.isNaN(w)) s += ` (${WEEK[w]})`; }
    return s;
  }
  function fmtPeriod(p) {
    if (!p || !p.start) return '';
    if (!p.end || p.end === p.start) return fmtDate(p.start);
    const [y1] = p.start.split('-'); const [y2, m2, d2] = p.end.split('-');
    return `${fmtDate(p.start)} – ${y1 === y2 ? `${m2}.${d2}` : fmtDate(p.end)}`;
  }
  function fmtTime(ts, sessionDate) {
    if (!ts) return '';
    const [d, t] = ts.split(' ');
    if (sessionDate && d !== sessionDate) { const [, m, dd] = d.split('-'); return `${m}.${dd} ${t}`; }
    return t;
  }

  // ── 인물 색 → 테마마다 읽히는 글자색 ─────────────
  // 고른 색(--c)은 아바타·점에 그대로 쓰고, 이름 글자는 배경과의 대비가 4.5:1이 되도록 밝기만 조절한
  // 밝은 테마용(--cl)·어두운 테마용(--cd)을 씀. 아바타 첫 글자는 흰색/검정 중 잘 보이는 쪽(--con).
  const BG_LIGHT = ['#eef0f3', '#fbfbfc', '#f6f3ea'];   // style.css 밝은 테마 --bg · --surface · --narr-bg
  const BG_DARK = ['#12151d', '#191d28', '#221f18'];    // 어두운 테마 같은 자리
  const hexRgb = (h) => { const m = String(h || '').replace('#', '').match(/^([0-9a-f]{6})$/i); if (!m) return null; const n = parseInt(m[1], 16); return [n >> 16, (n >> 8) & 255, n & 255]; };
  const lum = ([r, g, b]) => { const f = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
  const contrast = (a, b) => { const x = lum(a); const y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  function rgbHsl([r, g, b]) {
    r /= 255; g /= 255; b /= 255;
    const mx = Math.max(r, g, b); const mn = Math.min(r, g, b); const l = (mx + mn) / 2;
    if (mx === mn) return [0, 0, l];
    const d = mx - mn; const s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
    const h = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return [h / 6, s, l];
  }
  function hslRgb([h, s, l]) {
    if (!s) return [l, l, l].map((v) => Math.round(v * 255));
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s; const p = 2 * l - q;
    const t = (x) => { x = (x + 1) % 1; return x < 1 / 6 ? p + (q - p) * 6 * x : x < 1 / 2 ? q : x < 2 / 3 ? p + (q - p) * (2 / 3 - x) * 6 : p; };
    return [t(h + 1 / 3), t(h), t(h - 1 / 3)].map((v) => Math.round(v * 255));
  }
  const toHex = (rgb) => '#' + rgb.map((v) => v.toString(16).padStart(2, '0')).join('');
  function readable(rgb, bgs, dir) {
    const hsl = rgbHsl(rgb);
    let cur = rgb;
    for (let i = 0; i < 100; i++) {
      if (bgs.every((bg) => contrast(cur, hexRgb(bg)) >= 4.5)) break;
      hsl[2] = Math.min(1, Math.max(0, hsl[2] + dir * 0.01));
      cur = hslRgb(hsl);
    }
    return toHex(cur);
  }
  const colorCache = new Map();
  function colorVars(hex) {
    if (colorCache.has(hex)) return colorCache.get(hex);
    const rgb = hexRgb(hex);
    const v = rgb
      ? { c: hex, cl: readable(rgb, BG_LIGHT, -1), cd: readable(rgb, BG_DARK, +1),
        con: contrast(rgb, [255, 255, 255]) >= contrast(rgb, [20, 23, 31]) ? '#ffffff' : '#14171f' }
      : { c: '', cl: '', cd: '', con: '' };
    colorCache.set(hex, v);
    return v;
  }
  function paint(node, s) {
    const v = colorVars(s ? s.color : null);
    node.style.setProperty('--c', v.c); node.style.setProperty('--cl', v.cl);
    node.style.setProperty('--cd', v.cd); node.style.setProperty('--con', v.con);
    return node;
  }

  const book = () => store.book;
  // 인물 순서: PC → NPC → 에너미 → GM → 플레이어, 같은 무리 안에서는 인물 설정에서 정한 순서(없으면 처음 나온 순)
  const roleRank = (s) => (s.role === 'pc' ? 0 : s.role === 'npc' ? (s.enemy ? 2 : 1) : s.role === 'gm' ? 3 : 4);
  const idNum = (s) => Number(String(s.id).replace(/\D/g, '')) || 0;
  function orderedSpeakers(list) {
    return (list || store.book.speakers).slice().sort((a, b) => roleRank(a) - roleRank(b)
      || (a.order ?? 1e9) - (b.order ?? 1e9) || idNum(a) - idNum(b));
  }
  const spk = (id) => (id ? store.spk.get(id) : null);
  const sessionList = () => book().sessions.filter((s) => store.entries(s.no).length);
  const sessionLabel = (s) => (s.no === 0 ? s.title || '준비' : s.title || `${s.no}회차`);
  const sessionOf = (no) => book().sessions.find((s) => s.no === no) || { no };

  // 머리말이 상단바 밑으로 지나가면 상단바에 제목·룰·진행 날짜
  function updateBarBook() {
    const bar = document.querySelector('.site-bar');
    const on = !$('bookPage').hidden && $('bookHead').getBoundingClientRect().bottom < bar.getBoundingClientRect().bottom;
    bar.classList.toggle('show-book', on);
  }

  // ── 머리말 ────────────────────────────
  function renderHead() {
    const b = book();
    const bb = $('barBook'); bb.replaceChildren(el('b', null, b.title));
    if (b.system) bb.append(el('span', null, b.system));
    if (b.period && b.period.start) bb.append(el('span', 'num', fmtPeriod(b.period)));
    updateBarBook();
    document.title = `${b.title} · 세션 기록`;
    $('bookSystem').textContent = b.system ? `${b.system} · 세션 기록` : '세션 기록';
    $('bookTitle').textContent = b.title;
    const meta = $('bookMeta'); meta.replaceChildren();
    const played = b.sessions.filter((s) => s.no > 0 && store.entries(s.no).length).length;
    meta.append(el('span', 'num', fmtPeriod(b.period)), el('span', null, `${played}회차`));
    if (b.gm) meta.append(el('span', null, `GM ${b.gm}`));
    if (b.players && b.players.length) meta.append(el('span', null, `PL ${b.players.join(' · ')}`));

    const cast = $('cast'); cast.replaceChildren();
    // PC는 늘 보이고, NPC(에너미 포함)는 'NPC n명' 단추로 펼치고 접음. 보고 있는 인물이 NPC면 펼친 채로
    const ordered = orderedSpeakers();
    const pcs = ordered.filter((s) => s.role === 'pc');
    const npcs = ordered.filter((s) => s.role === 'npc');
    const focusNpc = S.focus && npcs.some((s) => s.id === S.focus);
    const open = S.castOpen || focusNpc;
    const chars = pcs.concat(open ? npcs : []);
    chars.forEach((s) => {
      const li = el('li');
      const btn = el('button', 'cast-btn');
      btn.type = 'button';
      btn.setAttribute('aria-pressed', String(S.focus === s.id));
      btn.title = `${s.name}의 대사만 보기`;
      btn.append(avatar(s));
      const txt = el('span');
      const player = spk(s.player);
      txt.append(el('span', 'cast-name', s.name),
        el('span', 'cast-sub', s.role === 'npc' ? (s.enemy ? '에너미' : 'NPC') : player ? `PL ${player.name}` : 'PL 미정'));
      btn.append(txt);
      btn.addEventListener('click', () => setFocus(S.focus === s.id ? null : s.id));
      li.append(btn); cast.append(li);
    });
    if (npcs.length) {
      const li = el('li');
      const t = el('button', 'cast-more', open ? `NPC 접기 ▴` : `NPC ${npcs.length}명 ▾`); t.type = 'button';
      t.setAttribute('aria-expanded', String(!!open));
      t.disabled = !!focusNpc && open;   // 보고 있는 NPC가 있으면 접지 않음
      t.addEventListener('click', () => { S.castOpen = !open; prefs.set('castOpen', S.castOpen); renderHead(); });
      li.append(t); cast.append(li);
    }
    const na = $('novelActs');
    if (na && SL.novel) na.replaceChildren(SL.novel.headActions());
  }

  function avatar(s) {
    const a = el('span', 'avatar');
    paint(a, s);
    a.setAttribute('aria-hidden', 'true');
    if (s && s.imageUrl) { const img = el('img'); img.alt = ''; img.src = s.imageUrl; a.append(img); } else a.textContent = s ? Array.from(s.name)[0] || '?' : '?';
    return a;
  }

  // ── 도구줄 ────────────────────────────
  function renderTabs() {
    const box = $('sessionTabs'); box.replaceChildren();
    const cur = S.view === 'all' ? S.active : S.session;
    sessionList().forEach((s) => {
      const t = el('button', 'tab', sessionLabel(s));
      t.type = 'button'; t.setAttribute('role', 'tab'); t.dataset.no = s.no;
      t.setAttribute('aria-selected', String(s.no === cur));
      if (s.date) t.append(el('span', 'num', fmtDate(s.date).slice(5)));
      t.addEventListener('click', () => goSession(s.no));
      box.append(t);
    });
    revealActiveTab();
  }
  function revealActiveTab() {
    const box = $('sessionTabs');
    const t = box.querySelector('[aria-selected="true"]');
    if (!t) return;
    requestAnimationFrame(() => {
      const l = t.offsetLeft - box.offsetLeft; const r = l + t.offsetWidth;
      if (l < box.scrollLeft) box.scrollLeft = Math.max(0, l - 8);
      else if (r > box.scrollLeft + box.clientWidth) box.scrollLeft = r - box.clientWidth + 8;
    });
  }
  // 지금 읽는 장면: 화면 위쪽(도구줄 아래 조금)을 이미 지난 장면 제목 중 마지막 것. 같은 회차 안에서만.
  let sceneTick = 0;
  function spyScene() {
    if (sceneTick) return;
    sceneTick = requestAnimationFrame(() => {
      sceneTick = 0;
      if ($('bookPage').hidden) return;
      const tb = $('toolbar').getBoundingClientRect().bottom;
      const line = tb + Math.min(160, (window.innerHeight - tb) * 0.25);
      // 회차: 기준선을 지난 마지막 회차 (전체 이어 보기에서만)
      if (S.view === 'all') {
        let no = null;
        for (const sec of $('log').querySelectorAll('.sess')) {
          if (sec.getBoundingClientRect().top <= line || no == null) no = Number(sec.dataset.no); else break;
        }
        if (no != null && no !== S.active) setActive(no);
      }
      let cur = null;
      for (const n of $('log').querySelectorAll('.g-scene, .er.k-scene')) {
        if (n.getBoundingClientRect().top <= line) cur = n.id; else break;
      }
      // 장면 제목 뒤에 다음 회차가 시작됐으면 그 장면은 끝난 것
      const e = cur && store.byId.get(cur);
      const sessNow = S.view === 'all' ? S.active : S.session;
      if (e && sessNow != null && e.session !== sessNow) cur = null;
      setScene(cur);
    });
  }
  function setScene(id) {
    if (S.scene === id) return;
    S.scene = id;
    document.querySelectorAll('[data-scene]').forEach((a) => a.classList.toggle('is-match', a.dataset.scene === id));
    // 목차가 길어 스크롤되면 지금 장면이 보이게
    const a = id && $('toc').querySelector(`[data-scene="${id}"]`);
    const toc = $('toc');
    if (a && toc.scrollHeight > toc.clientHeight) {
      const r = a.getBoundingClientRect(); const t = toc.getBoundingClientRect();
      if (r.top < t.top || r.bottom > t.bottom) toc.scrollTop += r.top - t.top - toc.clientHeight / 2;
    }
  }

  function setActive(no) {
    if (S.active === no) return;
    S.active = no;
    $('sessionTabs').querySelectorAll('.tab').forEach((t) => t.setAttribute('aria-selected', String(Number(t.dataset.no) === no)));
    $('toc').querySelectorAll('[data-sess]').forEach((a) => a.classList.toggle('is-match', Number(a.dataset.sess) === no));
    revealActiveTab();
    spyScene();
  }

  function renderFilters(counts) {
    const box = $('filters'); box.replaceChildren();
    KINDS.forEach((k) => {
      const c = el('button', 'chip', k.label);
      c.type = 'button';
      c.setAttribute('aria-pressed', String(!!S.filters[k.key]));
      c.title = S.filters[k.key] ? `${k.label} 숨기기` : `${k.label} 보이기`;
      c.append(el('span', 'n', (counts[k.key] || 0).toLocaleString()));
      c.addEventListener('click', () => { S.filters[k.key] = !S.filters[k.key]; prefs.set('filters', S.filters); render(true); });
      box.append(c);
    });
  }

  // 보기 설정 창: 항목마다 고를 수 있는 값을 모두 보여 주고, 지금 값을 칠해 둔다
  const OPTS = [
    { key: 'view', label: '보기 방식', values: [['all', '전체 이어 보기'], ['session', '회차별']] },
    { key: 'showTime', label: '시간', values: [[false, '숨김'], [true, '표시']] },
    { key: 'size', label: '글자 크기', values: [['s', '작게'], ['m', '보통'], ['l', '크게']] },
    { key: 'theme', label: '화면 테마', values: [['auto', '시스템'], ['light', '밝게'], ['dark', '어둡게']] },
  ];
  function renderOpts() {
    const box = $('viewOpts'); box.replaceChildren();
    OPTS.forEach((o) => {
      const row = el('div', 'vp-row');
      const lab = el('span', 'vp-label', o.label); lab.id = 'vp-' + o.key;
      const seg = el('div', 'seg'); seg.setAttribute('role', 'radiogroup'); seg.setAttribute('aria-labelledby', lab.id);
      o.values.forEach(([v, text]) => {
        const b = el('button', 'seg-btn', text); b.type = 'button';
        b.setAttribute('role', 'radio'); b.setAttribute('aria-checked', String(S[o.key] === v));
        if (o.key === 'size') b.classList.add('seg-size-' + v);
        b.addEventListener('click', () => setOpt(o.key, v));
        seg.append(b);
      });
      row.append(lab, seg); box.append(row);
    });
    document.body.classList.remove('size-s', 'size-l');
    if (S.size !== 'm') document.body.classList.add('size-' + S.size);
    if (S.theme === 'auto') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', S.theme);
    $('q').placeholder = S.view === 'all' ? '전체에서 찾기' : '이 회차에서 찾기';
  }
  function setOpt(key, v) {
    if (S[key] === v) return;
    const a = topVisibleEntry();
    S[key] = v; prefs.set(key, v);
    if (key === 'view' && v === 'session' && S.active != null) S.session = S.active;
    renderOpts();
    if (key === 'view') render(a || false);
    else if (key === 'showTime') render(true);
    else if (a) restorePlace(a);
  }
  function togglePanel(open) {
    const p = $('viewPanel');
    const want = open == null ? p.hidden : open;
    p.hidden = !want;
    $('optOpen').setAttribute('aria-expanded', String(want));
  }

  function setFocus(id) {
    S.focus = id;
    renderHead();
    const pill = $('focusPill'); pill.replaceChildren();
    if (id) {
      pill.append(el('span', null, `${spk(id).name}의 대사·주사위만 보는 중 (나레이션과 진행 표시는 그대로)`));
      const x = el('button', null, '모두 보기'); x.type = 'button'; x.addEventListener('click', () => setFocus(null));
      pill.append(x);
    }
    pill.hidden = !id;
    render(true);
  }

  // ── 보이기 규칙 ───────────────────────
  function visible(e) {
    if (e.deleted || e.kind === 'meta' || e.kind === 'whisper') return false;
    if (e.kind === 'scene') return true;
    if (!S.filters[e.kind]) return false;
    if (S.focus && (e.kind === 'dialogue' || e.kind === 'dice' || e.kind === 'chat') && e.speaker !== S.focus) return false;
    return true;
  }
  function groupKey(e) {
    if (e.kind === 'dialogue') return 'd:' + e.speaker;
    if (e.kind === 'chat') return 'c';
    if (e.kind === 'narration') return 'n';
    return null; // 주사위·진행 표시·장면은 하나씩
  }

  // ── 글 + 찾기 표시 ────────────────────
  function appendText(node, text) {
    const q = S.q;
    if (!q) { node.append(document.createTextNode(text)); return; }
    const low = text.toLowerCase(); const ql = q.toLowerCase();
    let i = 0; let j;
    while ((j = low.indexOf(ql, i)) !== -1) {
      if (j > i) node.append(document.createTextNode(text.slice(i, j)));
      const m = el('mark', null, text.slice(j, j + q.length));
      node.append(m); S.marks.push(m);
      i = j + q.length;
    }
    if (i < text.length) node.append(document.createTextNode(text.slice(i)));
  }

  // ── 마크다운 서식: **굵게** *기울임* ~~취소선~~ (찾기 표시는 글 조각마다 그대로) ──
  const MD = /\*\*([^*\n](?:[^\n]*?[^*\s])?)\*\*|~~([^~\n](?:[^\n]*?[^~\s])?)~~|\*([^*\s](?:[^*\n]*?[^*\s])?)\*/g;
  function fmtInto(node, text, add) {
    add = add || appendText;
    let i = 0; let m;
    MD.lastIndex = 0;
    const parts = [];
    while ((m = MD.exec(text))) {
      // 기울임 '*'는 글자 바로 뒤에 붙은 별표(예: 2*3)는 서식으로 보지 않음
      if (m[3] != null && m.index > 0 && /[\w*]/.test(text[m.index - 1])) continue;
      parts.push([m.index, m[0].length, m[1] != null ? 'strong' : m[2] != null ? 's' : 'em', m[1] ?? m[2] ?? m[3]]);
    }
    parts.forEach(([at, len, tag, inner]) => {
      if (at > i) add(node, text.slice(i, at));
      const w = el(tag); fmtInto(w, inner, add); node.append(w);
      i = at + len;
    });
    if (i < text.length) add(node, text.slice(i));
  }
  const stripMd = (t) => String(t || '').replace(MD, (m0, a, b, c) => a ?? b ?? c ?? m0);

  // 대사 한 줄을 조각으로: (지문) — 괄호 안 괄호도 짝을 맞춰서 · '생각'(작은따옴표) · 나머지는 말
  // say: 편집에서 고른 표시 방식 'act' | 'thought' | 'speech' (없으면 자동)
  function sayParts(text, say) {
    const t = String(text || '').trim();
    if (say === 'act' || say === 'thought') return { whole: say, parts: [{ cls: say, text: t }] };
    if (say === 'speech') return { whole: null, parts: [{ cls: null, text: t }] };
    const parts = [];
    const push = (cls, s) => { if (!s) return; const last = parts[parts.length - 1]; if (!cls && last && !last.cls) last.text += s; else parts.push({ cls, text: s }); };
    const OPEN = '(（'; const CLOSE = ')）';
    let i = 0;
    while (i < t.length) {
      const c = t[i];
      if (OPEN.includes(c)) {
        let d = 0; let j = i;
        for (; j < t.length; j++) { if (OPEN.includes(t[j])) d++; else if (CLOSE.includes(t[j]) && --d === 0) break; }
        if (j < t.length) { push('act', t.slice(i, j + 1)); i = j + 1; continue; }
      }
      if (c === "'" || c === '‘') {
        let j = i + 1;
        while (j < t.length && t[j] !== '\n' && t[j] !== '‘' && t[j] !== "'" && t[j] !== '’') j++;
        if (j < t.length && (t[j] === "'" || t[j] === '’') && j > i + 1) { push('thought', t.slice(i, j + 1)); i = j + 1; continue; }
      }
      push(null, c); i++;
    }
    // 줄 전체가 지문 하나·생각 하나면 줄 모양으로
    const whole = parts.length === 1 && parts[0].cls ? parts[0].cls : null;
    return { whole, parts };
  }
  function sayLine(e) {
    const line = el('div', 'line'); line.id = e.id;
    const { whole, parts } = sayParts(e.text, e.say);
    if (whole) { line.classList.add('say-' + whole); fmtInto(line, parts[0].text); return line; }
    parts.forEach((p) => { if (p.cls) { const s = el('span', p.cls); fmtInto(s, p.text); line.append(s); } else fmtInto(line, p.text); });
    return line;
  }
  function plainLine(e) {
    const line = el('div', 'line'); line.id = e.id;
    fmtInto(line, e.text);
    return line;
  }

  function groupShell(cls, first) {
    const g = el('div', 'g ' + cls);
    g.dataset.first = first.id;
    const tools = el('div', 'g-tools');
    const nv = el('button', null, '▶ 여기부터'); nv.type = 'button'; nv.title = '여기서부터 노벨로 보기';
    nv.addEventListener('click', () => SL.novel.start(first.id));
    const b = el('button', null, '링크'); b.type = 'button'; b.title = '이 부분 링크 복사';
    b.addEventListener('click', () => copyLink(first.id));
    tools.append(nv, b); g.append(tools);
    return g;
  }
  function timeEl(e) {
    if (!S.showTime || !e.ts) return null;
    return el('span', 'g-time', fmtTime(e.ts, sessionOf(e.session).date));
  }

  function renderGroup(list) {
    const e = list[0];
    const s = spk(e.speaker);
    if (e.kind === 'dialogue') {
      const g = groupShell('g-say', e);
      paint(g, s);
      g.append(avatar(s));
      const body = el('div');
      const who = el('div', 'who'); who.append(el('span', 'name', s ? s.name : '알 수 없음'));
      const t = timeEl(e); if (t) who.append(t);
      const lines = el('div', 'lines'); list.forEach((x) => lines.append(sayLine(x)));
      body.append(who, lines); g.append(body);
      return g;
    }
    if (e.kind === 'chat') {
      const g = groupShell('g-chat', e);
      let prev = null;
      list.forEach((x) => {
        const xs = spk(x.speaker);
        const row = el('div', 'chat-row');
        const who = el('span', 'who');
        if (x.speaker !== prev) {
          const d = paint(el('span', xs ? 'dot' : 'dot unknown'), xs);
          who.append(d, el('b', xs ? null : 'unknown', xs ? xs.name : '알 수 없음'));
          if (xs && xs.role === 'gm') who.append(el('span', 'tag', 'GM'));
          const t = timeEl(x); if (t) who.append(t);
        }
        row.append(who, plainLine(x));
        g.append(row);
        prev = x.speaker;
      });
      return g;
    }
    if (e.kind === 'narration') {
      const g = groupShell('g-narr', e);
      const head = el('div', 'narr-head');
      head.append(el('span', 'narr-tag', 'GM 나레이션'));
      const t = timeEl(e); if (t) head.append(t);
      g.append(head);
      list.forEach((x) => g.append(plainLine(x)));
      return g;
    }
    if (e.kind === 'scene') {
      const g = el('div', 'g g-scene'); g.id = e.id; g.dataset.first = e.id;
      const h = el('h3'); appendText(h, e.text); g.append(h);
      return g;
    }
    if (e.kind === 'system') {
      const g = el('div', 'g g-sys'); g.dataset.first = e.id;
      const sp = el('span', 'line'); sp.id = e.id; appendText(sp, e.text); g.append(sp);
      return g;
    }
    if (e.kind === 'dice') {
      const g = groupShell('g-dice', e);
      const card = diceCard(e, s); card.id = e.id; card.classList.add('line');
      g.append(card);
      return g;
    }
    return plainLine(e);
  }

  // ── 주사위 카드 ───────────────────────
  function dieFace(v, d6, sides) {
    if (d6 && v >= 1 && v <= 6) {
      const d = el('span', 'die'); d.setAttribute('role', 'img'); d.setAttribute('aria-label', String(v));
      PIPS[v].forEach((c) => { const i = el('i'); i.style.gridRow = String(Math.ceil(c / 3)); i.style.gridColumn = String(((c - 1) % 3) + 1); d.append(i); });
      return d;
    }
    const n = el('span', 'die-num', String(v));
    if (sides) n.title = 'd' + sides;
    return n;
  }
  function diceLabel(d) {
    if (d.label) return d.label;
    const map = Object.assign({}, DICE_LABELS, book().diceLabels || {});
    if (d.kind === 'spell') return map['spell:' + d.spellType] || d.spellType || map.spell;
    return map[d.kind] || map.other;
  }
  function diceCard(e, s) {
    const d = e.dice || {};
    const card = el('div', 'dice');
    const top = el('div', 'dice-top');
    const whoName = d.who && !/님\s*PC$/i.test(d.who) ? d.who : s ? s.name : '';
    const whoSp = book().speakers.find((x) => x.name === whoName) || s;
    if (whoSp) paint(top, whoSp);
    top.append(el('b', null, whoName), el('span', 'dice-kind', diceLabel(d)));
    const t = timeEl(e); if (t) top.append(t);
    card.append(top);

    const main = el('div', 'dice-main');
    if (d.title) { const ti = el('span', 'dice-title'); appendText(ti, d.title); main.append(ti); }
    if (d.kind === 'pick') { const ti = el('span', 'dice-title'); appendText(ti, `${d.domain ? d.domain + ' → ' : ''}${d.pick}`); main.append(ti); }
    if (d.dice && d.dice.length) {
      const exprs = d.rolls || [];
      const allD6 = exprs.length > 0 && exprs.every((x) => /^\d*d6$/i.test(x));   // 예전 데이터(면 수 없음)용
      if (!d.title && d.kind === 'roll' && exprs.length) main.append(el('span', 'dice-target', exprs.join(' + ').toUpperCase()));
      const faces = el('span', 'dice-faces');
      d.dice.forEach((v, i) => faces.append(dieFace(v, d.sides ? d.sides[i] === 6 : allD6, d.sides && d.sides[i])));
      main.append(faces);
      if (d.mod) main.append(el('span', 'dice-sum', d.mod > 0 ? `+${d.mod}` : `−${Math.abs(d.mod)}`));
      const total = d.sum != null ? d.sum : d.total;
      if (total != null && (d.dice.length > 1 || total !== d.dice[0])) main.append(el('span', 'dice-sum', `= ${total}`));
    }
    if (d.kind === 'spell' || d.kind === 'check') {
      if (typeof d.target === 'number') main.append(el('span', 'dice-target', `목표치 ${d.target}`));
      else if (d.variable) main.append(el('span', 'dice-target', '목표치 가변'));
      const result = d.resultOverride === 'none' ? null : d.resultOverride || d.result;
      if (result) {
        const bdg = el('span', 'badge ' + result, RESULT_LABEL[result]);
        if (!d.resultOverride) bdg.title = '로그에 남은 주사위와 목표치로 계산했어요. 수정치는 반영되지 않았어요.';
        main.append(bdg);
      }
    }
    if (main.childNodes.length) card.append(main);
    // 표 굴림은 결과 문구가 곧 결과. (주문·장비의 효과 문구는 보여 주지 않음)
    if (d.kind === 'table' && (d.tableText || d.info)) {
      const p = el('p', 'dice-table');
      appendText(p, [d.info, d.tableText].filter(Boolean).join(' — '));
      card.append(p);
    }
    if (d.kind === 'other' && d.text) { const p = el('p', 'dice-table'); appendText(p, d.text); card.append(p); }
    return card;
  }

  // ── 기록 그리기 ───────────────────────
  function groupsOf(list) {
    const groups = [];
    list.forEach((e) => {
      const k = groupKey(e);
      const last = groups[groups.length - 1];
      if (k && last && last.key === k) last.list.push(e); else groups.push({ key: k, list: [e] });
    });
    return groups;
  }

  function sessionHead(cur, vis, all) {
    const head = el('header', 'session-head'); head.id = 's' + cur.no; head.dataset.no = cur.no;
    head.append(el('h2', null, sessionLabel(cur)));
    const sub = el('p');
    if (cur.no === 0) sub.append(document.createTextNode('1회차 전 · 캐릭터 소개와 준비'));
    else sub.append(el('span', 'num', fmtDate(cur.date, true)));
    sub.append(document.createTextNode(` · ${vis.toLocaleString()}줄 보임 / 전체 ${all.toLocaleString()}줄`));
    head.append(sub);
    return head;
  }

  function counts(list) {
    const c = {};
    list.forEach((e) => {
      if (e.deleted) return;
      if (S.focus && (e.kind === 'dialogue' || e.kind === 'dice' || e.kind === 'chat') && e.speaker !== S.focus) return;
      c[e.kind] = (c[e.kind] || 0) + 1;
    });
    return c;
  }

  // keepPlace: true = 지금 화면 맨 위 줄을 기준으로 / { id, off } = 미리 잡아 둔 기준 줄
  function render(keepPlace) {
    const anchor = keepPlace && typeof keepPlace === 'object' ? keepPlace : keepPlace ? topVisibleEntry() : null;
    S.marks = []; S.mi = -1;
    const editing = SL.editor && SL.editor.active;
    const sessions = S.view === 'all' ? (editing ? SL.editor.sessionList() : sessionList()) : [sessionOf(S.session)];
    const all = sessions.flatMap((s) => store.entries(s.no));
    renderFilters(counts(all));
    if (editing) {
      SL.editor.render(sessions);
    } else renderLog(sessions, all);
    if (S.view === 'session') S.active = S.session;
    renderTabs();
    renderToc();
    renderSessionNav();
    updateSearchCount(all);
    watchSessions();
    if (anchor) restorePlace(anchor);
    spyScene();
  }

  function renderLog(sessions, all) {
    const log = $('log'); log.replaceChildren();
    const scenesAll = all.filter((e) => e.kind === 'scene');
    if (scenesAll.length) log.append(sceneJump(sessions));
    let shown = 0;
    sessions.forEach((cur) => {
      const list = store.entries(cur.no);
      const vis = list.filter(visible);
      shown += vis.length;
      const sec = el('section', 'sess'); sec.dataset.no = cur.no;
      sec.append(sessionHead(cur, vis.length, list.length));
      const frag = document.createDocumentFragment();
      groupsOf(vis).forEach((gr) => frag.append(renderGroup(gr.list)));
      sec.append(frag);
      log.append(sec);
    });
    if (!shown) log.append(el('p', 'empty', '고른 종류에 해당하는 줄이 없어요. 위쪽에서 종류를 켜 보세요.'));
  }

  // 다시 그려도 읽던 자리를 지키기
  function topVisibleEntry() {
    const top = $('toolbar').getBoundingClientRect().bottom + 4;
    const nodes = $('log').querySelectorAll('.line, .g-scene, .er');
    for (const n of nodes) { const r = n.getBoundingClientRect(); if (r.bottom > top) return { id: n.id, off: r.top }; }
    return null;
  }
  function restorePlace(a) {
    let n = document.getElementById(a.id);
    if (!n) {
      // 그 줄이 숨겨졌으면 가까운 보이는 줄로
      const e = store.byId.get(a.id);
      if (!e) return;
      const vis = SL.editor && SL.editor.active ? SL.editor.rowVisible : visible;
      const list = store.entries(e.session, true).filter(vis);
      const near = list.find((x) => x.seq >= e.seq) || list[list.length - 1];
      n = near && document.getElementById(near.id);
      if (!n) return;
    }
    settle(n, a.off);
    holdAnchor({ id: n.id, off: a.off });
  }

  // 기준 줄을 off 높이로. 스크롤하면 화면 밖 줄 높이가 다시 바뀔 수 있어서 맞을 때까지 몇 번 반복
  function settle(n, off) {
    for (let i = 0; i < 8; i++) {
      const d = n.getBoundingClientRect().top - off;
      if (Math.abs(d) < 1) return;
      window.scrollBy(0, d);
    }
  }

  // 다시 그린 직후 잠깐 동안 기준 줄을 같은 높이에 붙잡아 둔다.
  // (화면 밖 줄은 다음 프레임에 어림 높이로 바뀌어 위쪽 길이가 달라지므로, 바뀌는 즉시 그리기 전에 바로잡음)
  // 사람이 직접 스크롤(휠·터치·키·스크롤바)하면 바로 놓아 줌.
  let hold = null;
  function holdAnchor(a) {
    releaseAnchor();
    const fix = () => {
      const n = document.getElementById(a.id);
      if (n && n.isConnected) settle(n, a.off);
    };
    const ro = new ResizeObserver(fix);
    ro.observe($('log'));
    let alive = true;
    const tick = () => { if (!alive) return; fix(); requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
    const stop = () => releaseAnchor();
    const keys = (ev) => { if (/^(Arrow|Page|Home|End|\s)/.test(ev.key) || ev.key === ' ') stop(); };
    window.addEventListener('wheel', stop, { passive: true });
    window.addEventListener('touchstart', stop, { passive: true });
    window.addEventListener('keydown', keys);
    window.addEventListener('pointerdown', stop);
    const timer = setTimeout(stop, 700);
    hold = () => {
      alive = false; ro.disconnect(); clearTimeout(timer);
      window.removeEventListener('wheel', stop); window.removeEventListener('touchstart', stop);
      window.removeEventListener('keydown', keys); window.removeEventListener('pointerdown', stop);
    };
  }
  function releaseAnchor() { if (hold) { const h = hold; hold = null; h(); } }

  // 지금 회차는 spyScene이 장면과 같은 기준선으로 정함 (스크롤할 때마다)
  function watchSessions() {
    if (S.view !== 'all') return;
    const first = $('log').querySelector('.sess');
    if (S.active == null && first) setActive(Number(first.dataset.no));
  }

  function sceneLink(s) {
    const a = el('a', null, s.text); a.href = '#' + s.id; a.dataset.scene = s.id;
    if (s.id === S.scene) a.classList.add('is-match');
    a.addEventListener('click', (ev) => { ev.preventDefault(); if (S.view === 'session' && s.session !== S.session) { S.session = s.session; render(); } scrollToId(s.id); });
    return a;
  }
  function sceneJump(sessions) {
    const det = el('details', 'scene-jump');
    det.append(el('summary', null, '목차'));
    const ol = el('ol');
    sessions.forEach((s) => {
      const scenes = store.entries(s.no).filter((e) => e.kind === 'scene');
      if (!scenes.length) return;
      scenes.forEach((sc) => { const li = el('li'); li.append(sceneLink(sc)); if (S.view === 'all') li.prepend(el('span', 'toc-sess', sessionLabel(s) + ' · ')); ol.append(li); });
    });
    det.append(ol);
    return det;
  }

  function renderToc() {
    const toc = $('toc'); toc.replaceChildren();
    toc.append(el('h2', null, '목차'));
    const ol = el('ol');
    sessionList().forEach((s) => {
      const li = el('li');
      const a = el('a', null, sessionLabel(s) + (s.date ? `  ${fmtDate(s.date).slice(5)}` : ''));
      a.href = '#s' + s.no; a.dataset.sess = s.no;
      if (s.no === (S.view === 'all' ? S.active : S.session)) a.classList.add('is-match');
      a.addEventListener('click', (ev) => { ev.preventDefault(); goSession(s.no); });
      li.append(a);
      const scenes = store.entries(s.no).filter((e) => e.kind === 'scene');
      if (scenes.length && (S.view === 'all' || s.no === S.session)) {
        const sub = el('ol', 'toc-sub');
        scenes.forEach((sc) => { const l2 = el('li'); l2.append(sceneLink(sc)); sub.append(l2); });
        li.append(sub);
      }
      ol.append(li);
    });
    toc.append(ol);
  }

  function renderSessionNav() {
    const nav = $('sessionNav'); nav.replaceChildren();
    if (S.view === 'all') { nav.hidden = true; return; }
    nav.hidden = false;
    const list = sessionList(); const i = list.findIndex((s) => s.no === S.session);
    const mk = (s, dir) => {
      const b = el('button'); b.type = 'button';
      b.append(el('small', null, dir < 0 ? '← 이전 회차' : '다음 회차 →'), document.createTextNode(sessionLabel(s)));
      b.addEventListener('click', () => goSession(s.no));
      return b;
    };
    if (i > 0) nav.append(mk(list[i - 1], -1));
    if (i >= 0 && i < list.length - 1) nav.append(mk(list[i + 1], 1));
  }

  // ── 찾기 ──────────────────────────────
  function updateSearchCount(all) {
    const c = $('qCount');
    if (!S.q) { c.textContent = ''; c.title = ''; return; }
    let hidden = 0;
    const ql = S.q.toLowerCase();
    all.forEach((e) => { if (!visible(e) && !e.deleted && e.kind !== 'meta' && e.kind !== 'whisper' && e.text.toLowerCase().includes(ql)) hidden++; });
    c.textContent = S.marks.length ? `${Math.max(S.mi + 1, 0)}/${S.marks.length}` : '없음';
    c.title = hidden ? `숨긴 종류(사담 등)에 ${hidden}줄 더 있어요` : '';
    if (hidden) c.textContent += ` (+${hidden} 숨김)`;
  }
  function stepSearch(dir) {
    if (!S.marks.length) return;
    if (S.mi >= 0) S.marks[S.mi].classList.remove('is-current');
    S.mi = (S.mi + dir + S.marks.length) % S.marks.length;
    const m = S.marks[S.mi]; m.classList.add('is-current');
    m.scrollIntoView({ block: 'center', behavior: 'smooth' });
    const sessions = S.view === 'all' ? sessionList() : [sessionOf(S.session)];
    updateSearchCount(sessions.flatMap((s) => store.entries(s.no)));
  }

  // ── 이동 · 링크 ───────────────────────
  function goSession(no) {
    if (S.view === 'all') { scrollToId('s' + no); setActive(no); return; }
    S.session = no; render();
    window.scrollTo({ top: $('toolbar').offsetTop, behavior: 'auto' });
  }
  function scrollToId(id) {
    const n = document.getElementById(id);
    if (!n) return;
    // 멀리 갈 때는 바로 이동 (부드럽게 가면 회차 몇 개를 지나며 오래 걸림)
    const far = Math.abs(n.getBoundingClientRect().top) > window.innerHeight * 2;
    n.scrollIntoView({ block: 'start', behavior: far ? 'auto' : 'smooth' });
  }
  function openEntry(id) {
    const e = store.byId.get(id);
    if (!e || e.deleted) return false;
    if (e.kind !== 'scene' && e.kind !== 'meta' && e.kind !== 'whisper' && !S.filters[e.kind]) {
      S.filters[e.kind] = true;
      toast(`${withObj(KINDS.find((k) => k.key === e.kind).label)} 켰어요`);
    }
    if (S.focus && e.speaker !== S.focus) { S.focus = null; renderHead(); $('focusPill').hidden = true; }
    S.session = e.session;
    render();
    const n = document.getElementById(id);
    if (n) { n.classList.add('is-target'); requestAnimationFrame(() => n.scrollIntoView({ block: 'center' })); }
    return true;
  }
  function route() {
    const h = decodeURIComponent(location.hash.slice(1));
    if (/^e\d+$/.test(h) && openEntry(h)) return;
    const m = h.match(/^s(\d+)$/);
    const first = sessionList()[0];
    const want = m && store.bySession.has(Number(m[1])) ? Number(m[1]) : null;
    S.session = want != null ? want : (store.entries(1).length ? 1 : first ? first.no : 0);
    render();
    if (want != null && S.view === 'all') requestAnimationFrame(() => scrollToId('s' + want));
  }
  // 주소의 # 이 바뀔 때: #n… = 노벨 보기, 노벨이 열려 있는데 다른 주소가 되면(뒤로 가기) 노벨만 닫기
  const NOVEL_HASH = /^n(?:-(e\d+))?$/;
  function onHash() {
    const m = decodeURIComponent(location.hash.slice(1)).match(NOVEL_HASH);
    if (m) { SL.novel.openAt(m[1] || null); return; }
    if (SL.novel && SL.novel.open) { SL.novel.close(); return; }
    route();
  }
  // 노벨에서 돌아올 때: 그 줄(또는 회차 머리)로
  function goTo(id) {
    if (/^s\d+$/.test(id)) { goSession(Number(id.slice(1))); return; }
    if (!openEntry(id)) render(true);
  }
  function copyLink(id) {
    const url = location.href.split('#')[0] + '#' + id;
    const fallback = () => { history.replaceState(null, '', '#' + id); toast('주소창의 링크를 복사해 주세요'); };
    try { navigator.clipboard.writeText(url).then(() => toast('이 부분 링크를 복사했어요'), fallback); } catch (err) { fallback(); }
  }
  let toastTimer = 0;
  function toast(msg, action) {
    const t = $('toast'); t.replaceChildren(el('span', null, msg));
    if (action) { const b = el('button', 'toast-act', action.label); b.type = 'button'; b.addEventListener('click', () => { action.run(); t.hidden = true; }); t.append(b); }
    t.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, action ? 5000 : 2200);
  }

  // ── 인물 색 ───────────────────────────
  let peopleOrder = null;
  let peopleFlash = null;   // 방금 바꾼 사람 (잠깐 표시)
  function openPeople() {
    const dlg = $('people');
    const list = $('peopleList');
    // 다시 그려도 창 스크롤 위치와 지금 만지던 칸(포커스)을 그대로
    const sheet = dlg.querySelector('.sheet');
    const keep = { top: sheet ? sheet.scrollTop : 0, listTop: list.scrollTop, focus: !dlg.hidden && document.activeElement && dlg.contains(document.activeElement) ? document.activeElement.id : null };
    list.replaceChildren();
    const order = { pc: 0, npc: 1, gm: 2, pl: 3 };
    const roleName = { pc: 'PC', npc: 'NPC', gm: 'GM', pl: '플레이어' };
    // 줄 순서는 창을 열 때 한 번만 정함: 열어 둔 채 역할을 바꿔도 그 사람이 다른 자리로 튀지 않게
    if (dlg.hidden || !peopleOrder) peopleOrder = orderedSpeakers().map((s) => s.id);
    const byId = new Map(book().speakers.map((s) => [s.id, s]));
    const ids = peopleOrder.filter((id) => byId.has(id)).concat(book().speakers.filter((s) => !peopleOrder.includes(s.id)).map((s) => s.id));
    ids.map((id) => byId.get(id)).forEach((s) => {
      const row = el('div', 'person');
      const isChar = s.role === 'pc' || s.role === 'npc';
      const sw = isChar ? avatar(s) : el('span', 'dot big');
      paint(sw, s);
      const name = el('div', 'person-name');
      name.append(el('b', null, s.name), el('span', null, s.role === 'npc' && s.enemy ? '에너미' : roleName[s.role] || ''));
      // 이름이 밝은·어두운 테마에서 어떻게 보이는지 (자동으로 밝기를 맞춘 글자색)
      const pv = paint(el('span', 'name-preview'), s);
      pv.title = '이름 글자는 테마마다 읽히도록 밝기를 자동으로 맞춰요';
      pv.append(el('span', 'np-l', s.name), el('span', 'np-d', s.name));
      if (isChar) name.append(pv);   // 플레이어·GM 이름은 색 글자로 쓰이지 않음
      const pick = el('div', 'swatches');
      SWATCHES.forEach((c) => {
        const b = el('button', 'swatch'); b.type = 'button'; b.style.background = c; b.title = c;
        b.setAttribute('aria-label', `${s.name} 색을 ${c}로`);
        if (c.toLowerCase() === String(s.color).toLowerCase()) b.setAttribute('aria-current', 'true');
        b.addEventListener('click', () => setColor(s, c));
        pick.append(b);
      });
      const custom = el('input'); custom.type = 'color'; custom.value = /^#[0-9a-f]{6}$/i.test(s.color) ? s.color : '#888888';
      custom.id = 'color-' + s.id; custom.title = '직접 고르기'; custom.setAttribute('aria-label', `${s.name} 색 직접 고르기`);
      custom.addEventListener('change', () => setColor(s, custom.value));
      pick.append(custom);
      row.dataset.sp = s.id;
      if (peopleFlash === s.id) row.classList.add('just-changed');
      row.append(sw, name, pick);
      if (SL.editor && SL.editor.active) row.append(SL.editor.personFields(s));
      list.append(row);
    });
    const editing = SL.editor && SL.editor.active;
    $('peopleTitle').textContent = editing ? '인물 설정' : '인물 색';
    $('peopleNote').textContent = editing
      ? '이름·역할·플레이어·색을 바꿔요. 역할은 줄 종류(대사/사담)를 자동으로 바꾸지 않아요.'
      : '대사의 이름, 아바타, 사담의 점 색이 바뀌어요.' + (store.mode === 'demo' ? ' 데모에서는 이 브라우저에만 저장돼요.' : '');
    if (dlg.hidden) { dlg.hidden = false; $('peopleClose').focus(); return; }
    if (sheet) sheet.scrollTop = keep.top;
    list.scrollTop = keep.listTop;
    const f = keep.focus && document.getElementById(keep.focus);
    if (f) f.focus({ preventScroll: true });
  }
  function setColor(s, c) {
    const next = SL.clone(s); next.color = c;
    store.commit(`${s.name} 색 바꾸기`, { speakers: [next] });
    toast(`${s.name} 색을 바꿨어요`, { label: '되돌리기', run: () => store.undo() });
  }

  // ── 시작 ──────────────────────────────
  function bind() {
    let timer = 0;
    $('q').addEventListener('input', (ev) => {
      clearTimeout(timer);
      timer = setTimeout(() => { S.q = ev.target.value.trim(); render(); if (S.marks.length) stepSearch(1); }, 250);
    });
    $('q').addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); stepSearch(ev.shiftKey ? -1 : 1); } });
    $('qNext').addEventListener('click', () => stepSearch(1));
    $('qPrev').addEventListener('click', () => stepSearch(-1));
    $('optOpen').addEventListener('click', (ev) => { ev.stopPropagation(); togglePanel(); });
    $('viewPanelClose').addEventListener('click', () => togglePanel(false));
    $('viewPanel').addEventListener('click', (ev) => ev.stopPropagation()); // 안에서 누른 건 '바깥 누르기'로 치지 않음
    document.addEventListener('click', (ev) => { if (!$('viewPanel').hidden && !$('viewPanel').contains(ev.target)) togglePanel(false); });
    document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape' && !$('viewPanel').hidden) { togglePanel(false); $('optOpen').focus(); } });
    $('peopleClose').addEventListener('click', () => { $('people').hidden = true; });
    $('people').addEventListener('click', (ev) => { if (ev.target === $('people')) $('people').hidden = true; });
    document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape' && !$('people').hidden) $('people').hidden = true; });
    $('toolToggle').addEventListener('click', () => {
      const open = $('toolbar').classList.toggle('is-open');
      $('toolToggle').setAttribute('aria-expanded', String(open));
    });
    window.addEventListener('hashchange', onHash);
    $('novelOpen').addEventListener('click', () => { const a = topVisibleEntry(); SL.novel.start(a && /^e\d+$/.test(a.id) ? a.id : null); });
    window.addEventListener('scroll', spyScene, { passive: true });
    // 고정된 상단바·도구줄 높이를 CSS에 알려 줌 (목차 위치, 링크로 이동할 때 멈출 자리)
    const bars = new ResizeObserver(() => {
      const sb = document.querySelector('.site-bar').offsetHeight; const tb = $('toolbar').offsetHeight;
      const r = document.documentElement.style;
      r.setProperty('--sitebar-h', sb + 'px'); r.setProperty('--toolbar-h', tb + 'px'); r.setProperty('--stick-h', (sb + tb + 8) + 'px');
    });
    bars.observe($('toolbar')); bars.observe(document.querySelector('.site-bar'));
    window.addEventListener('scroll', updateBarBook, { passive: true });
    $('barBook').addEventListener('click', () => window.scrollTo({ top: 0, behavior: window.scrollY > window.innerHeight * 2 ? 'auto' : 'smooth' }));
    window.addEventListener('resize', spyScene);
    store.on((ev) => {
      if (ev.saved === false) toast(store.mode === 'demo' ? '이 브라우저에 저장하지 못했어요. 저장 공간이 부족할 수 있어요.' : `저장하지 못했어요: ${store.saveError ? store.saveError.message : ''}`);
      if (ev.saved != null || ev.saving) { if (SL.editor) SL.editor.updateBar(); return; }
      if (ev.op && (ev.op.after.speakers || []).length) resolveImages();
      renderHead();
      if (!$('people').hidden) {
        const sp = ev.op && ev.op.after.speakers;
        peopleFlash = peopleFlash || (sp && sp.length === 1 && sp[0][1] ? sp[0][0] : null);
        openPeople();
        peopleFlash = null;
      }
      if (SL.editor && SL.editor.active) SL.editor.onChange(ev); else render(true);
    });
  }

  // ── 기록 열기 (js/site.js가 부름) ─────────
  let bound = false;
  let ctx = { api: null, worldChars: [] };
  async function openBook(opts) {
    if (!bound) { renderOpts(); bind(); bound = true; }
    ctx = opts;
    S.focus = null; S.q = ''; S.active = null; S.session = 1;
    $('q').value = ''; $('focusPill').hidden = true;
    if (SL.editor && SL.editor.active) SL.editor.toggle();
    $('bookTitle').textContent = '불러오는 중…'; $('bookMeta').textContent = ''; $('cast').replaceChildren(); $('log').replaceChildren();
    await store.open({ api: opts.api, bookId: opts.bookId, isAdmin: opts.isAdmin });
    renderHead();
    route();
    resolveImages();
    const nm = decodeURIComponent(location.hash.slice(1)).match(NOVEL_HASH);
    if (nm) SL.novel.openAt(nm[1] || null);
    if (SL.editor) SL.editor.ready();
  }

  // PC는 사분면 캐릭터 이미지(world_characters), NPC는 직접 넣은 경로(world-assets)
  async function resolveImages() {
    if (!ctx.api) return;
    const chars = new Map((ctx.worldChars || []).map((c) => [c.id, c]));
    let changed = false;
    await Promise.all(store.book.speakers.map(async (s) => {
      const path = s.image || (s.charId && chars.get(s.charId) ? chars.get(s.charId).imagePath : null);
      const url = path ? await ctx.api.imageUrl(path).catch(() => null) : null;
      if ((s.imageUrl || null) !== url) { s.imageUrl = url; changed = true; }
    }));
    if (changed) { renderHead(); render(true); }
  }

  // 편집기(js/editor.js)가 쓰는 것들
  SL.app = { store, S, el, $, render, renderHead, toast, avatar, spk, sessionList, sessionLabel, sessionOf, fmtDate, fmtTime,
    diceCard, diceLabel, appendText, topVisibleEntry, restorePlace, holdAnchor, releaseAnchor, KINDS, DICE_LABELS, RESULT_LABEL, SWATCHES, prefs, openPeople, withObj, visible,
    openBook, ctx: () => ctx, paint, updateBarBook, goTo, openEntry, fmtPeriod, sayParts, fmtInto, stripMd,
    orderedSpeakers, roleRank, resetPeopleOrder: () => { peopleOrder = null; }, flashPerson: (id) => { peopleFlash = id; } };
})();
