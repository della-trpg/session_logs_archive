/*
 * 세션 기록 — 사이트 틀
 * 로그인 → 닉네임 → 초대 코드 → 세계관 → 기록 목록 → 기록 보기   (사분면과 같은 흐름·같은 계정)
 * 주소: ./            기록 목록
 *       ./?b=<id>     기록 보기 (#e123, #s2 는 기록 안 위치)
 *       ./?import     Roll20 로그 가져오기 (관리자)
 *       ./?worlds     세계관 고르기 · ./?code  코드 입력
 */
(function () {
  'use strict';
  const SL = window.SL;
  const CFG = window.SL_CONFIG || {};
  const $ = (id) => document.getElementById(id);
  const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
  const WORLD_KEY = 'sl:last-world';

  const site = (SL.site = { api: null, profile: null, worlds: [], world: null, chars: new Map() });
  const page = $('page');

  // ── 이동 ──────────────────────────────
  // 새로고침 없이 주소만 바꾸고 다시 그림 (주소를 못 바꾸는 환경이면 그냥 다시 그림)
  let params = new URLSearchParams(location.search);
  site.nav = function (search, hash) {
    params = new URLSearchParams(search || '');
    const url = location.pathname + (search ? (search.startsWith('?') ? search : '?' + search) : '') + (hash || '');
    try { history.pushState(null, '', url); } catch (e) { /* 아티팩트 미리보기 등 */ }
    route();
  };
  // # 만 바뀐 뒤로·앞으로 가기(줄 링크, 노벨 보기)는 기록 화면이 알아서 처리. 기록을 다시 열지 않음
  window.addEventListener('popstate', () => {
    if (location.search === site.lastSearch && !$('bookPage').hidden) return;
    params = new URLSearchParams(location.search); route();
  });

  function showPage(which) {
    page.hidden = which !== 'page';
    $('bookPage').hidden = which !== 'book';
    if (which !== 'book') document.querySelector('.site-bar').classList.remove('show-book');
    if (which !== 'book' && SL.novel && SL.novel.open) SL.novel.hide();
  }
  function loading(text) { showPage('page'); page.replaceChildren(el('div', 'loading', text || '불러오는 중…')); }
  function errorBox(text, retry) {
    showPage('page');
    const box = el('div', 'gate-card');
    box.append(el('h1', 'gate-title', '문제가 생겼어요'), el('p', 'muted', text));
    if (retry) { const b = el('button', 'btn', '다시 시도'); b.type = 'button'; b.addEventListener('click', retry); box.append(b); }
    page.replaceChildren(el('div', 'gate'));
    page.firstChild.append(box);
  }

  // ── 시작 ──────────────────────────────
  async function boot() {
    loading();
    site.api = SL.createApi();
    try { await site.api.init(); } catch (e) { errorBox(e.message || '시작하지 못했어요.', () => location.reload()); return; }
    if (site.api.demo) $('demoBanner').hidden = false;
    // 구글 로그인에서 돌아왔으면 보던 곳으로
    try {
      const back = sessionStorage.getItem('sl:return');
      if (back && site.api.user) { sessionStorage.removeItem('sl:return'); history.replaceState(null, '', location.pathname + back); params = new URLSearchParams(location.search); }
    } catch (e) { /* 무시 */ }
    site.api.onAuthChange(() => refresh());
    $('brand').addEventListener('click', () => site.nav(''));
    $('worldChip').addEventListener('click', () => site.nav('?worlds'));
    await refresh();
  }

  async function refresh() {
    try {
      loading();
      site.profile = null; site.worlds = []; site.world = null;
      if (site.api.user) {
        site.profile = await site.api.getProfile();
        if (site.profile && site.profile.nickname) site.worlds = await site.api.listWorlds();
      }
      if (site.worlds.length) selectWorld(pickWorld());
      header();
      await route();
    } catch (e) { header(); errorBox(e.message || '불러오지 못했어요.', refresh); }
  }

  function pickWorld() {
    const ids = site.worlds.map((w) => w.id);
    const last = SL.lsGet(WORLD_KEY);
    if (ids.includes(last)) return last;
    if (ids.includes(CFG.WORLD_ID)) return CFG.WORLD_ID;
    return ids[0];
  }
  function selectWorld(id) {
    const w = site.worlds.find((x) => x.id === id);
    if (!w) return false;
    site.world = w; SL.lsSet(WORLD_KEY, id);
    header();
    return true;
  }
  async function worldChars(id) {
    if (!site.chars.has(id)) site.chars.set(id, await site.api.listCharacters(id).catch(() => []));
    return site.chars.get(id);
  }

  function header() {
    const chip = $('worldChip');
    chip.hidden = !site.world;
    if (site.world) chip.textContent = site.world.name + ' ▾';
    const right = $('siteRight'); right.replaceChildren();
    if (site.api && site.api.demo) right.append(el('span', 'badge', '데모 모드'));
    if (site.profile && site.profile.nickname) right.append(el('span', 'nick', site.profile.nickname + (site.profile.isAdmin ? ' · 관리자' : '')));
    if (site.api && site.api.user && !site.api.demo) {
      const b = el('button', 'btn-sm', '로그아웃'); b.type = 'button';
      b.addEventListener('click', async () => { await site.api.signOut(); refresh(); });
      right.append(b);
    }
  }

  // ── 길 찾기 ───────────────────────────
  let token = 0;
  async function route() {
    const my = ++token;
    site.lastSearch = location.search;
    if (!site.api.user) return login();
    if (!site.profile || !site.profile.nickname) return nickname();
    if (params.has('code') || !site.worlds.length) return code();
    if (params.has('worlds')) return worldPicker();
    const bookId = params.get('b') || (site.api.demo && /^#(e\d+|s\d+|n|n-e\d+)$/.test(location.hash) ? 'demo' : null);
    if (bookId) return openBook(bookId, my);
    if (params.has('import')) {
      if (!site.profile.isAdmin) { site.nav(''); return; }
      showPage('page'); window.scrollTo(0, 0);
      return SL.importPage(page, { api: site.api, worlds: site.worlds, world: site.world, worldChars, nav: site.nav, selectWorld });
    }
    return home(my);
  }

  async function openBook(id, my) {
    loading('기록을 여는 중…');
    try {
      // 다른 세계관의 기록 링크면 그 세계관으로
      showPage('book');
      const isAdmin = !!site.profile.isAdmin;
      const chars = site.world ? await worldChars(site.world.id) : [];
      await SL.app.openBook({ api: site.api, bookId: id, isAdmin, worldChars: chars });
      if (my !== token) return;
      const w = SL.app.store.meta && SL.app.store.meta.worldId;
      if (w && site.world && w !== site.world.id && selectWorld(w)) {
        SL.app.ctx().worldChars = await worldChars(w);
      }
      document.title = `${SL.app.store.book.title} · 세션 기록`;
    } catch (e) {
      if (my === token) errorBox(e.message || '기록을 열지 못했어요.', () => route());
    }
  }

  // ── 들어가기 전 ───────────────────────
  function gate(...children) {
    showPage('page'); window.scrollTo(0, 0);
    const wrap = el('div', 'gate'); const card = el('div', 'gate-card');
    children.filter(Boolean).forEach((c) => card.append(c));
    wrap.append(card); page.replaceChildren(wrap);
    return card;
  }
  function login() {
    const msg = el('p', 'error'); msg.hidden = true;
    const host = el('div', 'gbtn');
    const redirect = el('button', 'btn primary', '구글로 로그인'); redirect.type = 'button';
    redirect.addEventListener('click', async () => { try { await site.api.signInWithGoogleRedirect(); } catch (e) { msg.hidden = false; msg.textContent = e.message; } });
    const alt = el('button', 'btn-link', '버튼이 안 보이면: 다른 방식으로 로그인'); alt.type = 'button'; alt.hidden = true;
    alt.addEventListener('click', () => redirect.click());
    gate(el('h1', 'gate-title', '세션 기록'),
      el('p', 'muted', '초대받은 사람만 볼 수 있는 플레이 기록이에요. 로그인한 뒤 받은 코드를 입력해 주세요.'),
      host, alt, msg,
      el('p', 'muted small', '캐릭터 사분면·카드 공모 사이트와 같은 계정이에요.'));
    site.api.renderGoogleButton(host, (m) => { msg.hidden = false; msg.textContent = m; })
      .then((ok) => { if (ok) alt.hidden = false; else host.replaceChildren(redirect); })
      .catch(() => host.replaceChildren(redirect));
  }
  function nickname() {
    const input = el('input', 'input'); input.type = 'text'; input.maxLength = 20; input.placeholder = '닉네임 (1~20자)'; input.id = 'nick'; input.setAttribute('aria-label', '닉네임');
    const msg = el('p', 'error'); msg.hidden = true;
    const form = el('form', 'gate-form');
    const ok = el('button', 'btn primary', '저장'); ok.type = 'submit';
    form.append(input, ok);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const v = input.value.trim();
      if (!v) { msg.hidden = false; msg.textContent = '닉네임을 입력해 주세요.'; return; }
      try { await site.api.setNickname(v); await refresh(); } catch (err) { msg.hidden = false; msg.textContent = err.message; }
    });
    gate(el('h1', 'gate-title', '닉네임 정하기'), el('p', 'muted', '사분면·카드 공모 사이트와 같은 닉네임을 써요.'), form, msg);
    input.focus();
  }
  function code() {
    const input = el('input', 'input code-input'); input.type = 'text'; input.maxLength = 24; input.id = 'code';
    input.autocomplete = 'off'; input.spellcheck = false; input.placeholder = 'XXXX-XXXX-XXXX'; input.setAttribute('aria-label', '초대 코드');
    const msg = el('p', 'error'); msg.hidden = true;
    const btn = el('button', 'btn primary', '확인'); btn.type = 'submit';
    const reasons = { invalid: '코드가 맞지 않아요. 다시 확인해 주세요.', used: '이미 사용된 코드예요.', too_many: '시도가 너무 많아요. 10분 뒤에 다시 시도해 주세요.', login: '로그인이 필요해요.' };
    const form = el('form', 'gate-form'); form.append(input, btn);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!input.value.trim()) return;
      btn.disabled = true;
      try {
        const r = await site.api.redeemCode(input.value);
        if (r.ok) {
          site.worlds = await site.api.listWorlds();
          selectWorld(r.world_id);
          site.nav('');
          return;
        }
        msg.hidden = false; msg.textContent = reasons[r.reason] || reasons.invalid;
      } catch (err) { msg.hidden = false; msg.textContent = err.message; } finally { btn.disabled = false; }
    });
    const hasAny = site.worlds.length > 0;
    let back = null;
    if (hasAny) { back = el('button', 'btn-link', '← 세계관 목록'); back.type = 'button'; back.addEventListener('click', () => site.nav('?worlds')); }
    gate(back, el('h1', 'gate-title', hasAny ? '다른 세계관 코드 입력' : '초대 코드 입력'),
      el('p', 'muted', '사분면에서 이미 코드를 썼다면 같은 세계관의 기록이 바로 보여요. 코드는 한 번만 쓸 수 있어요.'), form, msg);
    input.focus();
  }
  function worldPicker() {
    showPage('page'); window.scrollTo(0, 0);
    const wrap = el('div', 'home');
    wrap.append(el('h1', 'home-title', '세계관'), el('p', 'muted', site.profile.isAdmin ? '관리자라서 모든 세계관이 보여요.' : '코드를 입력한 세계관만 보여요.'));
    const grid = el('div', 'card-grid');
    site.worlds.forEach((w) => {
      const c = el('button', 'w-card' + (site.world && site.world.id === w.id ? ' current' : '')); c.type = 'button';
      c.append(el('b', null, w.name), el('span', 'muted small', site.world && site.world.id === w.id ? '지금 보는 중' : '이 세계관으로 가기'));
      c.addEventListener('click', () => { selectWorld(w.id); site.nav(''); });
      grid.append(c);
    });
    if (!site.api.demo) {
      const add = el('button', 'w-card add'); add.type = 'button';
      add.append(el('b', null, '+ 코드로 세계관 추가'), el('span', 'muted small', '새로 받은 초대 코드 입력'));
      add.addEventListener('click', () => site.nav('?code'));
      grid.append(add);
    }
    wrap.append(grid);
    page.replaceChildren(wrap);
  }

  // ── 기록 목록 ─────────────────────────
  const fmt = (d) => (d ? d.replace(/-/g, '.') : '');
  function period(p) {
    if (!p || !p.start) return '';
    if (!p.end || p.end === p.start) return fmt(p.start);
    return `${fmt(p.start)} – ${p.start.slice(0, 4) === p.end.slice(0, 4) ? fmt(p.end).slice(5) : fmt(p.end)}`;
  }
  // 정렬·필터 상태: 정렬은 이 기기에 기억, 필터는 이번 방문 동안만
  const SORTS = [
    ['new', '최신순', '마지막 진행일이 최근인 것부터'],
    ['old', '오래된 순', '첫 진행일이 오래된 것부터'],
    ['title', '가나다순', '제목 가나다순'],
    ['updated', '최근 수정순', '최근에 고치거나 공개한 것부터'],
    ['sessions', '회차 많은 순', '회차가 많은 것부터'],
  ];
  const LF = site.listFilter = { sort: SL.lsGet('sl:list-sort') || 'new', q: '', from: '', to: '', system: '', chars: new Set(), mode: 'and', open: false };

  function sortBooks(list) {
    const end = (b) => (b.period && (b.period.end || b.period.start)) || '';
    const start = (b) => (b.period && (b.period.start || b.period.end)) || '';
    const byTitle = (x, y) => String(x.title).localeCompare(String(y.title), 'ko');
    const cmp = {
      new: (x, y) => end(y).localeCompare(end(x)) || start(y).localeCompare(start(x)) || byTitle(x, y),
      old: (x, y) => (start(x) || '9999').localeCompare(start(y) || '9999') || byTitle(x, y),
      title: byTitle,
      updated: (x, y) => String(y.updatedAt || '').localeCompare(String(x.updatedAt || '')) || end(y).localeCompare(end(x)),
      sessions: (x, y) => (y.sessions - x.sessions) || end(y).localeCompare(end(x)),
    }[LF.sort] || ((x, y) => 0);
    return list.slice().sort(cmp);
  }
  function filterBooks(list) {
    const q = LF.q.trim().toLowerCase();
    return list.filter((b) => {
      if (q && !String(b.title).toLowerCase().includes(q)) return false;
      if (LF.system && (b.system || '') !== LF.system) return false;
      if (LF.from || LF.to) {
        const s = b.period && (b.period.start || b.period.end); const e = b.period && (b.period.end || b.period.start);
        if (!s) return false;
        if (LF.from && e < LF.from) return false;     // 기간이 겹치기만 하면 포함
        if (LF.to && s > LF.to) return false;
      }
      if (LF.chars.size) {
        const has = new Set((b.chars || []).map((c) => c.key));
        const want = Array.from(LF.chars);
        if (LF.mode === 'and' ? !want.every((k) => has.has(k)) : !want.some((k) => has.has(k))) return false;
      }
      return true;
    });
  }
  const activeFilters = () => (LF.q.trim() ? 1 : 0) + (LF.system ? 1 : 0) + (LF.from || LF.to ? 1 : 0) + (LF.chars.size ? 1 : 0);

  async function home(my) {
    loading();
    let books;
    try { books = await site.api.listBooks(site.world.id); } catch (e) { errorBox(e.message, () => route()); return; }
    if (my !== token) return;
    showPage('page'); document.title = '세션 기록';
    const wrap = el('div', 'home');
    const head = el('div', 'home-head');
    const t = el('div'); t.append(el('p', 'eyebrow', site.world.name), el('h1', 'home-title', '세션 기록'));
    head.append(t);
    if (site.profile.isAdmin) {
      const imp = el('button', 'btn primary', 'Roll20 로그 가져오기'); imp.type = 'button';
      imp.addEventListener('click', () => site.nav('?import'));
      head.append(imp);
    }
    wrap.append(head);
    if (!books.length) {
      wrap.append(el('p', 'empty', site.profile.isAdmin ? '아직 기록이 없어요. Roll20 로그를 가져와 보세요.' : '아직 공개된 기록이 없어요.'));
      page.replaceChildren(wrap);
      return;
    }

    // 정렬·찾기·필터 (기록이 2개 이상일 때)
    const tools = el('div', 'list-tools');
    const panel = el('div', 'list-filter');
    const count = el('p', 'list-count'); count.setAttribute('role', 'status');
    const list = el('div', 'book-list');
    if (books.length >= 2) {
      const q = el('input', 'input list-q'); q.type = 'search'; q.id = 'listQ'; q.placeholder = '제목으로 찾기'; q.value = LF.q; q.setAttribute('aria-label', '제목으로 찾기');
      q.addEventListener('input', () => { LF.q = q.value; draw(); });
      const sortLab = el('label', 'list-sort'); sortLab.htmlFor = 'listSort';
      const sel = el('select'); sel.id = 'listSort';
      SORTS.forEach(([k, label, hint]) => { const o = el('option', null, label); o.value = k; o.title = hint; o.selected = LF.sort === k; sel.append(o); });
      sel.addEventListener('change', () => { LF.sort = sel.value; SL.lsSet('sl:list-sort', LF.sort); draw(); });
      sortLab.append(el('span', null, '정렬'), sel);
      const fb = el('button', 'chip filter-btn'); fb.type = 'button'; fb.id = 'listFilterBtn';
      fb.addEventListener('click', () => { LF.open = !LF.open; draw(); });
      tools.append(q, sortLab, fb);
      wrap.append(tools, panel);
      tools._fb = fb;
    }
    wrap.append(count, list);
    page.replaceChildren(wrap);

    // 필터에 쓸 값들: 등장 인물(여러 기록에 나온 순), 룰
    const charMap = new Map();
    books.forEach((b) => (b.chars || []).filter((c) => c.role === 'pc' && !c.enemy && c.lines !== 0).forEach((c) => {   // PC만, 대사가 한 줄도 없는 인물은 빼고
      const x = charMap.get(c.key) || { key: c.key, name: c.name, npc: c.role === 'npc', enemy: !!c.enemy, n: 0 };
      x.n++; charMap.set(c.key, x);
    }));
    const allChars = Array.from(charMap.values()).sort((a, b) => (b.n - a.n) || a.name.localeCompare(b.name, 'ko'));
    const systems = Array.from(new Set(books.map((b) => b.system).filter(Boolean))).sort((a, b) => a.localeCompare(b, 'ko'));
    LF.chars.forEach((k) => { if (!charMap.has(k)) LF.chars.delete(k); });

    function drawPanel() {
      panel.hidden = !LF.open;
      if (!LF.open) return;
      panel.replaceChildren();
      const row = (label, ...kids) => { const r = el('div', 'lf-row'); r.append(el('span', 'lf-label', label)); const box = el('div', 'lf-body'); kids.forEach((k) => { if (k) box.append(k); }); r.append(box); panel.append(r); return box; };
      // 기간
      const from = el('input'); from.type = 'date'; from.id = 'lfFrom'; from.value = LF.from; from.setAttribute('aria-label', '이 날짜부터');
      const to = el('input'); to.type = 'date'; to.id = 'lfTo'; to.value = LF.to; to.setAttribute('aria-label', '이 날짜까지');
      from.addEventListener('change', () => { LF.from = from.value; draw(); });
      to.addEventListener('change', () => { LF.to = to.value; draw(); });
      row('진행 기간', from, el('span', 'muted', '~'), to, el('span', 'muted small', '기간이 겹치는 기록'));
      // 룰
      if (systems.length >= 2) {
        const box = row('룰');
        [['', '전부']].concat(systems.map((x) => [x, x])).forEach(([v, label]) => {
          const c = el('button', 'chip lf-chip', label); c.type = 'button'; c.setAttribute('aria-pressed', String(LF.system === v));
          c.addEventListener('click', () => { LF.system = v; draw(); });
          box.append(c);
        });
      }
      // 등장 인물
      if (allChars.length) {
        const box = row('등장 PC');
        allChars.forEach((c) => {
          const on = LF.chars.has(c.key);
          const b = el('button', 'chip lf-chip', c.name + (c.enemy ? ' (에너미)' : c.npc ? ' (NPC)' : '')); b.type = 'button'; b.setAttribute('aria-pressed', String(on));
          if (books.length > 1) b.append(el('span', 'n', String(c.n)));
          b.addEventListener('click', () => { if (on) LF.chars.delete(c.key); else LF.chars.add(c.key); draw(); });
          box.append(b);
        });
        const seg = el('div', 'seg lf-mode'); seg.setAttribute('role', 'radiogroup'); seg.setAttribute('aria-label', '여러 명을 골랐을 때');
        [['and', '고른 인물이 모두 나온 기록'], ['or', '한 명이라도 나온 기록']].forEach(([v, label]) => {
          const b = el('button', 'seg-btn', label); b.type = 'button'; b.setAttribute('role', 'radio'); b.setAttribute('aria-checked', String(LF.mode === v));
          b.disabled = LF.chars.size < 2;
          b.addEventListener('click', () => { LF.mode = v; draw(); });
          seg.append(b);
        });
        row('여러 명일 때', seg, LF.chars.size < 2 ? el('span', 'muted small', '두 명 이상 고르면 고를 수 있어요') : null);
      }
      const clear = el('button', 'btn-sm', '필터 지우기'); clear.type = 'button'; clear.disabled = !activeFilters();
      clear.addEventListener('click', () => { LF.q = ''; LF.from = ''; LF.to = ''; LF.system = ''; LF.chars.clear(); const q = document.getElementById('listQ'); if (q) q.value = ''; draw(); });
      const r = el('div', 'lf-actions'); r.append(clear); panel.append(r);
    }

    function card(b) {
      const c = el('button', 'book-card'); c.type = 'button';
      const top = el('div', 'book-card-top');
      if (b.system) top.append(el('span', 'eyebrow', b.system));
      if (b.visibility === 'draft') top.append(el('span', 'badge', '초안'));
      c.append(top, el('b', 'book-card-title', b.title));
      const meta = el('span', 'book-card-meta');
      [period(b.period), b.sessions ? `${b.sessions}회차` : '', b.gm ? `GM ${b.gm}` : '', (b.players || []).length ? `PL ${b.players.join(' · ')}` : '']
        .filter(Boolean).forEach((x, i) => { if (i) meta.append(el('span', 'sep', '·')); meta.append(el('span', null, x)); });
      c.append(meta);
      const cast = castLine(b);
      if (cast) c.append(cast);
      c.addEventListener('click', () => site.nav('?b=' + encodeURIComponent(b.id)));
      return c;
    }

    // 등장: PC는 모두, NPC는 대표 한 명 + '외 총 N명' (N = 대사가 있는 NPC 전체, 에너미 포함).
    // 대표 = 기록 정보에서 고른 NPC, 안 골랐으면 대사가 가장 많은 NPC (에너미 제외).
    // 마우스를 올리면 에너미가 아닌 NPC 이름 + '그 외 에너미 N명'
    function castLine(b) {
      const all = b.chars || [];
      const spoke = (x) => x.lines == null || x.lines > 0;   // 줄 수를 모르면(서버 SQL 갱신 전) 모두
      const pcs = all.filter((x) => x.role === 'pc' && !x.enemy && spoke(x));
      const npcs = all.filter((x) => (x.role === 'npc' || x.enemy) && spoke(x));
      if (!pcs.length && !npcs.length) return null;
      const friends = npcs.filter((x) => !x.enemy).sort((a, c) => (c.lines || 0) - (a.lines || 0));
      const enemies = npcs.length - friends.length;
      const box = el('span', 'book-card-cast');
      box.append(el('span', 'muted', '등장 '));
      pcs.forEach((x, i) => { if (i) box.append(document.createTextNode(' · ')); box.append(el('span', LF.chars.has(x.key) ? 'hit' : null, x.name)); });
      if (npcs.length) {
        const top = (b.leadNpc && friends.find((x) => x.id === b.leadNpc)) || friends[0];
        const seg = el('span', 'cast-npc');
        seg.append(el('span', 'muted', 'NPC '));
        if (top) seg.append(el('span', null, top.name));
        if (npcs.length > (top ? 1 : 0)) seg.append(document.createTextNode(top ? ` 외 총 ${npcs.length}명` : `총 ${npcs.length}명`));
        const tip = friends.map((x) => x.name).join(', ');
        seg.title = [tip, enemies ? `그 외 에너미 ${enemies}명` : ''].filter(Boolean).join(' · ');
        if (pcs.length) box.append(el('span', 'sep', ' | '));
        box.append(seg);
      }
      return box;
    }

    function draw() {
      const shown = sortBooks(filterBooks(books));
      if (tools._fb) {
        const n = activeFilters() - (LF.q.trim() ? 1 : 0);
        tools._fb.textContent = n ? `필터 ${n}` : '필터';
        tools._fb.setAttribute('aria-expanded', String(LF.open));
        tools._fb.classList.toggle('on', !!n);
      }
      drawPanel();
      count.textContent = activeFilters() ? `기록 ${books.length}개 중 ${shown.length}개` : `기록 ${books.length}개`;
      list.replaceChildren(...shown.map(card));
      if (!shown.length) list.append(el('p', 'empty', '조건에 맞는 기록이 없어요. 필터를 바꾸거나 지워 보세요.'));
    }
    draw();
  }

  boot();
})();
