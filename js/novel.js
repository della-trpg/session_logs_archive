/*
 * 세션 기록 — 노벨 보기 (비주얼 노벨처럼 한 줄씩 넘겨 읽기)
 * 주소: #n (이어서/처음부터) · #n-e123 (그 줄부터). 뒤로 가기로 닫힘.
 * 사용자 글은 전부 textContent/텍스트 노드로 넣는다. (innerHTML 금지)
 */
(function () {
  'use strict';

  const SL = window.SL;
  const A = () => SL.app;
  const N = SL.novel = { open: false };

  const DEF = { speed: 'm', auto: 'm', chat: false, dice: true, system: true, size: 'm' };
  const CPS = { s: 28, m: 55, f: 110, i: 0 };                 // 글자/초 (0 = 바로)
  const WAIT = { s: [1900, 70], m: [1200, 45], f: [650, 25] };  // 자동 넘김: 기본 + 글자당
  const LIMIT = 170;                                          // 한 화면에 넣을 글자 수(넘으면 나눔)
  const MAX_CAST = 4;
  const reduced = () => window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  let P = Object.assign({}, DEF);
  let steps = [];
  let firstStep = new Map();
  let idx = 0;
  let dom = null;
  let typing = null;
  let autoOn = false; let autoTimer = 0;
  let pushed = false;
  let sheet = null;
  let saveTimer = 0;
  let lastWheel = 0; let wheelAcc = 0;
  let returnFocus = null;

  const el = (...a) => A().el(...a);
  const spk = (id) => A().spk(id);
  const isChar = (s) => s && (s.role === 'pc' || s.role === 'npc');
  const posKey = () => 'novel:pos:' + A().store.bookId;

  // ── 넘길 단계 만들기 ──────────────────────
  function shown(e) {
    if (e.deleted || e.kind === 'meta' || e.kind === 'whisper' || e.nvHide) return false;   // nvHide: 편집에서 '노벨 보기에서 숨기기'
    if (e.kind === 'chat') return P.chat;
    if (e.kind === 'dice') return P.dice;
    if (e.kind === 'system') return P.system;
    if (e.kind === 'scene') return !!e.text.trim();
    return !!(e.text || '').trim();
  }
  // 긴 글은 문단 → 문장 단위로 나눠서 여러 화면에
  function pagesOf(text) {
    const t = (text || '').trim();
    if (t.length <= LIMIT) return [t];
    const bits = [];
    t.split('\n').forEach((ln, li) => {
      const sents = ln.length > LIMIT ? (ln.match(/[^.!?。…~]*[.!?。…~]+["'”’」』)]*\s*|[^.!?。…~]+$/g) || [ln]) : [ln];
      sents.forEach((s, si) => {
        // 문장 하나가 너무 길면 띄어쓰기에서 자름
        while (s.length > LIMIT * 1.4) {
          let cut = s.lastIndexOf(' ', LIMIT); if (cut < LIMIT * 0.5) cut = LIMIT;
          bits.push({ s: s.slice(0, cut), nl: li > 0 && si === 0 });
          s = s.slice(cut).replace(/^\s+/, ''); si = 1;
        }
        if (s) bits.push({ s, nl: li > 0 && si === 0 });
      });
    });
    const out = []; let cur = '';
    bits.forEach((b) => {
      const add = cur ? (b.nl ? '\n' : '') + b.s : b.s;
      if (cur && (cur + add).length > LIMIT) { out.push(cur.trim()); cur = b.s; } else cur += add;
    });
    if (cur.trim()) out.push(cur.trim());
    return out.length ? out : [t];
  }
  function build() {
    const { store, sessionList } = A();
    steps = []; firstStep = new Map();
    sessionList().forEach((s) => {
      const list = store.entries(s.no).filter(shown);
      if (!list.length) return;
      steps.push({ t: 'session', sess: s.no });
      let chats = [];
      const flush = () => {
        chatPages(chats).forEach((items, i, arr) => {
          items.forEach((x) => { if (!firstStep.has(x.id)) firstStep.set(x.id, steps.length); });
          steps.push({ t: 'chat', items, page: i, pages: arr.length, sess: s.no });
        });
        chats = [];
      };
      list.forEach((e) => {
        if (e.kind === 'chat') { chats.push(e); return; }
        flush();
        firstStep.set(e.id, steps.length);
        if (e.kind === 'scene') steps.push({ t: 'scene', e, sess: s.no });
        else if (e.kind === 'dice') steps.push({ t: 'dice', e, sess: s.no });
        else if (e.kind === 'system') steps.push({ t: 'sys', e, sess: s.no });
        else pagesOf(e.text).forEach((p, i, arr) => steps.push({ t: 'line', e, text: p, page: i, pages: arr.length, sess: s.no }));
      });
      flush();
    });
  }
  // 사담 묶음 → 쪽 (한 쪽에 8줄·400자 안쪽)
  const CHAT_LINES = 8; const CHAT_CHARS = 400;
  function chatPages(list) {
    const out = []; let cur = []; let n = 0;
    list.forEach((e) => {
      const len = Math.min((e.text || '').length, CHAT_CHARS);
      if (cur.length && (cur.length >= CHAT_LINES || n + len > CHAT_CHARS)) { out.push(cur); cur = []; n = 0; }
      cur.push(e); n += len;
    });
    if (cur.length) out.push(cur);
    return out;
  }
  // 그 줄이 노벨에서 안 보이는 종류면 바로 뒤의 보이는 줄로
  function stepFor(id) {
    if (!id) return null;
    if (firstStep.has(id)) return firstStep.get(id);
    const store = A().store;
    const e = store.byId.get(id);
    if (!e) return null;
    const all = A().sessionList().flatMap((s) => store.entries(s.no));
    const i = all.findIndex((x) => x.id === id);
    for (let j = i + 1; j < all.length; j++) if (firstStep.has(all[j].id)) return firstStep.get(all[j].id);
    return steps.length - 1;
  }
  const entryOf = (i) => { for (let j = i; j < steps.length; j++) { const st = steps[j]; if (st.e) return st.e; if (st.items) return st.items[0]; } return null; };

  // ── 무대에 선 인물: 지금 장면에서 말한 PC·NPC (최근 4명, 처음 나온 순서로 자리 고정) ──
  function charOf(st) {
    if (!st || !st.e) return null;
    if (st.t === 'line' && st.e.kind === 'dialogue') { const s = spk(st.e.speaker); return isChar(s) ? s : null; }
    if (st.t === 'dice') {
      const d = st.e.dice || {};
      const byName = d.who ? A().store.book.speakers.find((x) => x.name === d.who && isChar(x)) : null;
      const s = byName || spk(st.e.speaker);
      return isChar(s) ? s : null;
    }
    return null;
  }
  function castAt(i) {
    let j = i;
    for (; j >= 0; j--) if (steps[j].t === 'scene' || steps[j].t === 'session') break;
    const order = []; const last = new Map();
    for (let k = j + 1; k <= i; k++) {
      const s = charOf(steps[k]); if (!s) continue;
      if (!last.has(s.id)) order.push(s.id);
      last.set(s.id, k);
    }
    if (order.length <= MAX_CAST) return order;
    const keep = new Set(order.slice().sort((a, b) => last.get(b) - last.get(a)).slice(0, MAX_CAST));
    return order.filter((id) => keep.has(id));
  }
  function sceneAt(i) {
    const sess = steps[i] && steps[i].sess;
    for (let j = i; j >= 0; j--) {
      if (steps[j].sess !== sess) break;
      if (steps[j].t === 'scene') return steps[j].e;
    }
    return null;
  }

  // ── 화면 ─────────────────────────────
  function make() {
    if (dom) return dom;
    const root = el('div', 'nv'); root.id = 'novel'; root.hidden = true;
    root.setAttribute('role', 'dialog'); root.setAttribute('aria-modal', 'true'); root.setAttribute('aria-label', '노벨 보기');
    root.tabIndex = -1;
    root.innerHTML = `
      <div class="nv-bar">
        <button type="button" class="nv-btn nv-exit" id="nvExit" title="채팅 로그로 돌아가기 (Esc)">← 채팅 로그</button>
        <div class="nv-where"><b id="nvTitle"></b><span id="nvSess"></span><span id="nvScene"></span></div>
        <div class="nv-bar-acts">
          <button type="button" class="nv-btn" id="nvScenes" aria-haspopup="dialog">장면</button>
          <button type="button" class="nv-btn" id="nvLogBtn" aria-haspopup="dialog" title="지난 대사 (L)">지난 대사</button>
          <button type="button" class="nv-btn" id="nvSetBtn" aria-haspopup="dialog">설정</button>
        </div>
        <input type="range" class="nv-seek" id="nvSeek" min="0" max="0" value="0" aria-label="읽는 위치">
      </div>
      <div class="nv-stage" id="nvStage">
        <div class="nv-glow" id="nvGlow"></div>
        <div class="nv-cast" id="nvCast"></div>
        <div class="nv-sys" id="nvSys" hidden></div>
        <section class="nv-chat" id="nvChat" hidden aria-label="사담">
          <div class="nv-chat-head"><b>사담</b><span class="nv-page" id="nvChatPage"></span><button type="button" class="nv-btn nv-skip" id="nvSkip" title="사담 건너뛰고 다음 대사로 (S)">다음 대사로 ▸</button></div>
          <ol class="nv-chat-list" id="nvChatList"></ol>
        </section>
        <div class="nv-card" id="nvCard" hidden></div>
        <div class="nv-box" id="nvBox">
          <div class="nv-name" id="nvName"></div>
          <div class="nv-text" id="nvText" aria-hidden="true"></div>
          <div class="nv-foot">
            <span class="nv-page" id="nvPage"></span>
            <span class="nv-more" id="nvMore" aria-hidden="true">▼</span>
          </div>
        </div>
        <div class="nv-ctrl">
          <button type="button" class="nv-btn" id="nvPrev" title="이전 (←)" aria-label="이전">◀</button>
          <button type="button" class="nv-btn" id="nvAuto" aria-pressed="false" title="자동 넘김 (A)">자동</button>
          <button type="button" class="nv-btn" id="nvNext" title="다음 (스페이스·→·클릭)" aria-label="다음">▶</button>
        </div>
        <p class="nv-hint" id="nvHint">누르거나 스페이스·→로 넘기고, ←로 돌아가요</p>
      </div>
      <div class="nv-sheet" id="nvSheet" hidden role="dialog" aria-modal="false" aria-labelledby="nvSheetTitle">
        <div class="nv-sheet-head"><b id="nvSheetTitle"></b><button type="button" class="nv-btn" id="nvSheetClose" aria-label="닫기">✕</button></div>
        <div class="nv-sheet-body" id="nvSheetBody"></div>
      </div>
      <div class="sr-only" aria-live="polite" id="nvLive"></div>`;
    document.body.append(root);
    const $ = (id) => document.getElementById(id);
    dom = { root, $ };
    bind();
    return dom;
  }

  function bind() {
    const { root, $ } = dom;
    $('nvExit').addEventListener('click', () => exit());
    $('nvPrev').addEventListener('click', (ev) => { ev.stopPropagation(); prev(); });
    $('nvNext').addEventListener('click', (ev) => { ev.stopPropagation(); next(); });
    $('nvAuto').addEventListener('click', (ev) => { ev.stopPropagation(); setAuto(!autoOn); });
    $('nvSkip').addEventListener('click', (ev) => { ev.stopPropagation(); skipChat(); });
    $('nvScenes').addEventListener('click', () => toggleSheet('scenes'));
    $('nvLogBtn').addEventListener('click', () => toggleSheet('log'));
    $('nvSetBtn').addEventListener('click', () => toggleSheet('set'));
    $('nvSheetClose').addEventListener('click', () => closeSheet());
    const seek = $('nvSeek');
    seek.addEventListener('input', () => { const st = steps[Number(seek.value)]; seek.setAttribute('aria-valuetext', where(Number(seek.value))); seek.title = st ? where(Number(seek.value)) : ''; });
    seek.addEventListener('change', () => { setAuto(false); show(Number(seek.value), true); });
    // 무대를 누르면 다음 (단추·카드 안 단추는 제외)
    $('nvStage').addEventListener('click', (ev) => {
      if (ev.target.closest('button, a, input, select')) return;
      if (window.getSelection && String(window.getSelection())) return;   // 글을 고르는 중
      if (sheet) { closeSheet(); return; }
      next();
    });
    // 휠: 한 번 굴릴 때 한 줄. 트랙패드처럼 계속 들어오는 휠은 0.65초에 한 줄까지만
    $('nvStage').addEventListener('wheel', (ev) => {
      ev.preventDefault();
      const now = performance.now();
      const fresh = now - lastWheel > 180;
      lastWheel = now;
      if (Math.abs(ev.deltaY) < 4) return;
      if (!fresh && now - wheelAcc < 650) return;
      wheelAcc = now;
      if (ev.deltaY > 0) next(); else { setAuto(false); prev(); }
    }, { passive: false });
    document.addEventListener('keydown', onKey);
  }

  function onKey(ev) {
    if (!N.open) return;
    const k = ev.key;
    if (k === 'Escape') { ev.preventDefault(); if (sheet) closeSheet(); else exit(); return; }
    const tag = ev.target && ev.target.tagName;
    if (/^(INPUT|SELECT|TEXTAREA)$/.test(tag)) return;
    if (sheet && ev.target.closest && ev.target.closest('.nv-sheet')) return;
    if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
    const onBtn = tag === 'BUTTON';
    if ((k === ' ' || k === 'Enter') && onBtn) return;            // 단추는 단추대로
    if (k === ' ' || k === 'Enter' || k === 'ArrowRight' || k === 'PageDown' || k === 'ArrowDown') { ev.preventDefault(); next(); return; }
    if (k === 'ArrowLeft' || k === 'PageUp' || k === 'ArrowUp' || k === 'Backspace') { ev.preventDefault(); setAuto(false); prev(); return; }
    if (k === 'Home') { ev.preventDefault(); show(0, true); return; }
    if (k === 'End') { ev.preventDefault(); show(steps.length - 1, true); return; }
    if (k === 'a' || k === 'A' || k === 'ㅁ') { setAuto(!autoOn); return; }
    if (k === 'l' || k === 'L' || k === 'ㅣ') { toggleSheet('log'); return; }
    if ((k === 's' || k === 'S' || k === 'ㄴ') && steps[idx] && steps[idx].t === 'chat') { skipChat(); return; }
  }

  // ── 넘기기 ───────────────────────────
  function next() {
    dom.$('nvHint').hidden = true;
    if (typing) { finishTyping(); return; }
    if (idx >= steps.length - 1) { if (!dom.$('nvCard').dataset.end) showEnd(); return; }
    show(idx + 1);
  }
  function prev() {
    if (dom.$('nvCard').dataset.end) { show(idx, true); return; }
    if (idx > 0) show(idx - 1, true);
  }
  // 사담 건너뛰기: 이어지는 사담 쪽을 모두 넘기고 다음 대사(사담이 아닌 단계)로
  function skipChat() {
    let j = idx;
    while (j < steps.length && steps[j].t === 'chat') j++;
    if (j >= steps.length) { showEnd(); return; }
    show(j);
  }
  function setAuto(on) {
    autoOn = on;
    clearTimeout(autoTimer);
    if (dom) dom.$('nvAuto').setAttribute('aria-pressed', String(on));
    if (dom) dom.root.classList.toggle('is-auto', on);
    if (on && !typing) scheduleAuto();
  }
  function scheduleAuto() {
    clearTimeout(autoTimer);
    if (!autoOn) return;
    const st = steps[idx];
    const [base, per] = WAIT[P.auto] || WAIT.m;
    let wait = base;
    if (st.t === 'line') wait += per * st.text.length;
    else if (st.t === 'scene' || st.t === 'session') wait = base + 900;
    else if (st.t === 'dice') wait = base + 1200;
    else if (st.t === 'chat') wait = base + per * 0.5 * st.items.reduce((a, x) => a + (x.text || '').length, 0);
    autoTimer = setTimeout(() => { if (idx >= steps.length - 1) { setAuto(false); showEnd(); } else show(idx + 1); }, wait);
  }

  function where(i) {
    const st = steps[i]; if (!st) return '';
    const s = A().sessionOf(st.sess); const sc = sceneAt(i);
    return [A().sessionLabel(s), sc ? sc.text : null, `${i + 1} / ${steps.length}`].filter(Boolean).join(' · ');
  }

  function show(i, instant) {
    if (!steps.length) return;
    i = Math.max(0, Math.min(steps.length - 1, i));
    idx = i;
    const { $ } = dom;
    const st = steps[i];
    finishTyping(true);
    clearTimeout(autoTimer);
    const card = $('nvCard'); delete card.dataset.end;

    // 위쪽: 회차 · 장면 · 위치
    const sess = A().sessionOf(st.sess);
    const sc = sceneAt(i);
    $('nvSess').textContent = A().sessionLabel(sess);
    $('nvScene').textContent = sc ? sc.text : '';
    $('nvScene').hidden = !sc;
    const seek = $('nvSeek'); seek.max = String(steps.length - 1); seek.value = String(i);
    seek.setAttribute('aria-valuetext', where(i)); seek.title = where(i);
    seek.style.setProperty('--p', steps.length > 1 ? (i / (steps.length - 1)) * 100 + '%' : '0%');

    const live = $('nvLive');
    $('nvChat').hidden = st.t !== 'chat';

    $('nvBox').classList.remove('is-past');
    if (st.t === 'session' || st.t === 'scene') {
      renderCast([], null);
      $('nvBox').hidden = true; $('nvSys').hidden = true;
      card.replaceChildren();
      card.className = 'nv-card is-' + st.t;
      if (st.t === 'session') {
        card.append(el('p', 'nv-card-eyebrow', A().store.book.title));
        card.append(el('h2', null, A().sessionLabel(sess)));
        card.append(el('p', 'nv-card-sub', sess.no === 0 ? '1회차 전 · 캐릭터 소개와 준비' : A().fmtDate(sess.date, true)));
        live.textContent = `${A().sessionLabel(sess)} ${sess.date ? A().fmtDate(sess.date) : ''}`;
      } else {
        card.append(el('p', 'nv-card-eyebrow', A().sessionLabel(sess)));
        card.append(el('h2', null, st.e.text));
        card.append(el('span', 'nv-orn', '✦'));
        live.textContent = `장면: ${st.e.text}`;
      }
      card.hidden = false;
      restart(card, 'nv-in');
      afterShown(instant);
      return;
    }
    card.hidden = true;

    const speaker = charOf(st);
    renderCast(castAt(i), speaker ? speaker.id : null);

    if (st.t === 'chat') {
      // 대사 상자에는 바로 앞 대사를 흐리게 남겨 두고, 사담은 옆 창에 한 줄씩
      $('nvSys').hidden = true;
      let j = i - 1;
      while (j >= 0 && steps[j].sess === st.sess && (steps[j].t === 'chat' || steps[j].t === 'sys')) j--;
      const prevStep = j >= 0 && steps[j].sess === st.sess && (steps[j].t === 'line' || steps[j].t === 'dice') ? steps[j] : null;
      if (prevStep) { fillBox(prevStep); $('nvBox').hidden = false; $('nvBox').classList.add('is-past'); } else $('nvBox').hidden = true;
      showChat(st, instant);
      live.textContent = '사담. ' + st.items.map((x) => { const xs = spk(x.speaker); return `${xs ? xs.name : '알 수 없음'}: ${A().stripMd(x.text)}`; }).join(' / ');
      return;
    }

    if (st.t === 'sys') {
      $('nvBox').hidden = true;
      const sys = $('nvSys'); sys.hidden = false; sys.replaceChildren(el('span', null, st.e.text));
      restart(sys, 'nv-in');
      live.textContent = st.e.text;
      afterShown(instant);
      return;
    }
    $('nvSys').hidden = true;
    $('nvBox').hidden = false;
    const text = fillBox(st);
    const e = st.e; const s = spk(e.speaker);
    if (st.t === 'dice') {
      const d = e.dice || {};
      restart(text.firstChild, 'nv-pop');
      live.textContent = diceSpeech(e, d.who && !/님\s*PC$/i.test(d.who) ? d.who : s ? s.name : '');
      afterShown(true);
      return;
    }
    live.textContent = `${e.kind === 'narration' ? '' : (s ? s.name : '알 수 없음') + ': '}${A().stripMd(st.text)}`;
    type(text, instant);
  }

  // 대사 상자에 한 단계(대사·나레이션·주사위)를 채움 (글자는 다 보이는 상태로)
  function fillBox(st) {
    const { $ } = dom;
    const box = $('nvBox');
    const name = $('nvName'); name.replaceChildren();
    const text = $('nvText'); text.replaceChildren();
    const e = st.e; const s = spk(e.speaker);
    box.dataset.kind = st.t === 'dice' ? 'dice' : e.kind;
    A().paint(box, s);
    $('nvPage').textContent = st.pages > 1 ? `${st.page + 1}/${st.pages}` : '';
    if (st.t === 'dice') {
      const d = e.dice || {};
      const who = d.who && !/님\s*PC$/i.test(d.who) ? d.who : s ? s.name : '';
      name.append(el('b', null, who || '주사위'), el('span', 'nv-role', A().diceLabel(d)));
      const c = A().diceCard(e, s);
      c.classList.add('nv-dice');
      text.append(c);
      return text;
    }
    if (e.kind === 'dialogue') {
      name.append(el('b', null, s ? s.name : '알 수 없음'));
      if (s && s.role === 'npc') name.append(el('span', 'nv-role', 'NPC'));
      sayInto(text, st.text, e.say);
    } else if (e.kind === 'narration') {
      name.append(el('span', 'nv-role', 'GM 나레이션'));
      fmt(text, st.text);
    } else {   // 사담
      const dot = A().paint(el('span', s ? 'dot' : 'dot unknown'), s);
      name.append(dot, el('b', null, s ? s.name : '알 수 없음'), el('span', 'nv-role', s && s.role === 'gm' ? 'GM · 사담' : '사담'));
      fmt(text, st.text);
    }
    return text;
  }

  // 사담 창: 한 줄씩 쭉쭉 (글자 속도 설정을 따름, '바로'면 한꺼번에)
  const CHAT_GAP = { s: 220, m: 120, f: 60, i: 0 };
  function showChat(st, instant) {
    const { $ } = dom;
    $('nvChatPage').textContent = st.pages > 1 ? `${st.page + 1}/${st.pages}` : '';
    $('nvSkip').hidden = !(steps[idx + 1] && steps[idx + 1].t === 'chat');   // 사담이 다음 쪽에도 이어질 때만
    const list = $('nvChatList'); list.replaceChildren();
    let prev = null;
    const lis = st.items.map((x) => {
      const xs = spk(x.speaker);
      const li = el('li', x.speaker === prev ? 'cont' : null);
      if (x.speaker !== prev) {
        const who = el('span', 'who');
        who.append(A().paint(el('span', xs ? 'dot' : 'dot unknown'), xs), el('b', null, xs ? xs.name : '알 수 없음'));
        if (xs && xs.role === 'gm') who.append(el('span', 'tag', 'GM'));
        li.append(who);
      }
      const tx = el('span', 'txt'); fmt(tx, x.text); li.append(tx);
      prev = x.speaker;
      list.append(li);
      return li;
    });
    list.scrollTop = 0;
    const gap = CHAT_GAP[P.speed];
    if (instant || !gap || reduced()) { afterShown(); return; }
    lis.forEach((li) => li.classList.add('wait'));
    dom.root.classList.add('is-typing');
    let k = 0; let timer = 0;
    const step = () => {
      if (k >= lis.length) { finishTyping(); return; }
      lis[k].classList.remove('wait'); lis[k].classList.add('nv-line');
      k++; timer = setTimeout(step, gap);
    };
    typing = { nodes: [], stop: () => { clearTimeout(timer); lis.forEach((li) => li.classList.remove('wait')); } };
    step();
  }
  function diceSpeech(e, who) {
    const d = e.dice || {};
    const r = d.resultOverride && d.resultOverride !== 'none' ? d.resultOverride : d.resultOverride === 'none' ? null : d.result;
    return [who, A().diceLabel(d), d.title, d.dice && d.dice.length ? `주사위 ${d.dice.join(', ')}` : null,
      d.sum != null ? `합계 ${d.sum}` : null, typeof d.target === 'number' ? `목표치 ${d.target}` : null,
      r ? A().RESULT_LABEL[r] : null].filter(Boolean).join(', ');
  }
  function restart(node, cls) {
    if (reduced()) return;
    node.classList.remove(cls); void node.offsetWidth; node.classList.add(cls);
  }

  // (지문) · '생각' 은 따로 칠함 (채팅 보기와 같은 규칙)
  // 서식(**굵게** 등)은 그대로 살리고, 글자 하나씩 나오게 텍스트 노드로
  const addText = (node, s) => node.append(document.createTextNode(s));
  const fmt = (node, t) => A().fmtInto(node, t, addText);
  function sayInto(box, t, say) {
    const { whole, parts } = A().sayParts(t, say);
    if (whole) { const sp = el('span', whole + ' whole'); fmt(sp, parts[0].text); box.append(sp); return; }
    parts.forEach((p) => { if (p.cls) { const sp = el('span', p.cls); fmt(sp, p.text); box.append(sp); } else fmt(box, p.text); });
  }

  // ── 글자가 한 자씩 ─────────────────────
  function type(box, instant) {
    const cps = CPS[P.speed];
    if (instant || !cps || reduced()) { afterShown(true); return; }
    const nodes = [];
    const walk = (n) => { n.childNodes.forEach((c) => { if (c.nodeType === 3) { nodes.push([c, c.data]); c.data = ''; } else walk(c); }); };
    walk(box);
    const total = nodes.reduce((a, [, s]) => a + s.length, 0);
    const start = performance.now();
    dom.root.classList.add('is-typing');
    let raf = 0;
    const tick = (now) => {
      let n = Math.floor(((now - start) / 1000) * cps);
      if (n >= total) { finishTyping(); return; }
      for (const [node, full] of nodes) { const k = Math.min(full.length, n); if (node.data.length !== k) node.data = full.slice(0, k); n -= k; }
      raf = requestAnimationFrame(tick);
    };
    typing = { nodes, stop: () => cancelAnimationFrame(raf) };
    raf = requestAnimationFrame(tick);
  }
  function finishTyping(silent) {
    if (!typing) return;
    const t = typing; typing = null;
    t.stop();
    t.nodes.forEach(([node, full]) => { node.data = full; });
    if (!silent) afterShown(true);
  }
  function afterShown() {
    dom.root.classList.remove('is-typing');
    remember();
    scheduleAuto();
  }

  // ── 무대 인물 ─────────────────────────
  const sprites = new Map();
  function sprite(s) {
    let f = sprites.get(s.id);
    if (!f) {
      f = el('figure', 'nv-sprite');
      f.dataset.id = s.id;
      const frame = el('div', 'nv-frame');
      f.append(frame, el('figcaption', null, s.name));
      sprites.set(s.id, f);
    }
    // 이미지·이름·색이 바뀌었을 수 있어서 매번 맞춤
    A().paint(f, s);
    const frame = f.firstChild;
    const want = s.imageUrl || '';
    if (frame.dataset.src !== want || !frame.firstChild) {
      frame.dataset.src = want; frame.replaceChildren();
      if (want) { const img = el('img'); img.alt = ''; img.src = want; img.decoding = 'async'; frame.append(img); f.classList.add('has-img'); } else {
        frame.append(el('span', 'nv-initial', Array.from(s.name)[0] || '?')); f.classList.remove('has-img');
      }
    }
    f.lastChild.textContent = s.name;
    return f;
  }
  function renderCast(ids, on) {
    const box = dom.$('nvCast');
    const want = ids.map((id) => spk(id)).filter(Boolean).map(sprite);
    // 빠진 사람
    Array.from(box.children).forEach((c) => { if (!want.includes(c)) c.remove(); });
    want.forEach((f, k) => {
      const isNew = f.parentNode !== box;
      if (box.children[k] !== f) box.insertBefore(f, box.children[k] || null);
      if (isNew) restart(f, 'nv-enter');
      f.classList.toggle('on', f.dataset.id === on);
      f.setAttribute('aria-hidden', 'true');
    });
    box.dataset.n = String(want.length);
    box.style.setProperty('--n', String(Math.max(1, want.length)));
    box.classList.toggle('has-on', !!on && ids.includes(on));
    // 말하는 사람 쪽으로 은은한 빛
    const g = dom.$('nvGlow');
    const f = on && sprites.get(on);
    if (f && f.parentNode === box) {
      A().paint(g, spk(on));
      requestAnimationFrame(() => {
        const r = f.getBoundingClientRect(); const st = dom.$('nvStage').getBoundingClientRect();
        g.style.setProperty('--gx', (r.left + r.width / 2 - st.left) + 'px');
        g.classList.add('on');
      });
    } else g.classList.remove('on');
  }

  function showEnd() {
    const { $ } = dom;
    setAuto(false);
    renderCast([], null);
    $('nvBox').hidden = true; $('nvSys').hidden = true;
    const card = $('nvCard'); card.replaceChildren(); card.className = 'nv-card is-end'; card.dataset.end = '1';
    card.append(el('p', 'nv-card-eyebrow', A().store.book.title), el('h2', null, '기록 끝'));
    const acts = el('div', 'nv-card-acts');
    const again = el('button', 'nv-btn', '처음부터'); again.type = 'button'; again.addEventListener('click', () => show(0, true));
    const back = el('button', 'nv-btn primary', '채팅 로그로'); back.type = 'button'; back.addEventListener('click', () => exit());
    acts.append(again, back); card.append(acts);
    card.hidden = false; restart(card, 'nv-in');
    $('nvLive').textContent = '기록 끝. 처음부터 또는 채팅 로그로 돌아갈 수 있어요.';
    dom.root.focus({ preventScroll: true });
  }

  // ── 위치 기억 ─────────────────────────
  function remember() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      const e = entryOf(idx);
      if (!e || !N.open) return;
      A().prefs.set(posKey(), { id: e.id, at: Date.now() });
      // 주소도 지금 줄로 (새로 고침·링크 복사하면 여기서 열림). 기록을 쌓지는 않음
      try { history.replaceState(history.state, '', '#n-' + e.id); } catch (err) { /* 미리보기 등 */ }
    }, 300);
  }
  function saved() {
    const v = A().prefs.get(posKey(), null);
    return v && v.id && A().store.byId.has(v.id) ? v : null;
  }

  // ── 옆 창: 장면 · 지난 대사 · 설정 ───────
  function toggleSheet(which) { if (sheet === which) closeSheet(); else openSheet(which); }
  function openSheet(which) {
    setAuto(false);
    sheet = which;
    const { $ } = dom;
    const body = $('nvSheetBody'); body.replaceChildren();
    ['nvScenes', 'nvLogBtn', 'nvSetBtn'].forEach((id) => $(id).setAttribute('aria-expanded', 'false'));
    if (which === 'scenes') { $('nvSheetTitle').textContent = '장면'; sceneList(body); $('nvScenes').setAttribute('aria-expanded', 'true'); }
    if (which === 'log') { $('nvSheetTitle').textContent = '지난 대사'; backlog(body); $('nvLogBtn').setAttribute('aria-expanded', 'true'); }
    if (which === 'set') { $('nvSheetTitle').textContent = '노벨 보기 설정'; settings(body); $('nvSetBtn').setAttribute('aria-expanded', 'true'); }
    $('nvSheet').hidden = false;
    dom.root.classList.add('sheet-open');
    const cur = body.querySelector('[aria-current="true"]');
    if (cur) cur.scrollIntoView({ block: which === 'log' ? 'end' : 'center' });
    else if (which === 'log') body.scrollTop = body.scrollHeight;
    $('nvSheetClose').focus({ preventScroll: true });
  }
  function closeSheet() {
    if (!sheet) return;
    const btn = { scenes: 'nvScenes', log: 'nvLogBtn', set: 'nvSetBtn' }[sheet];
    sheet = null;
    dom.$('nvSheet').hidden = true;
    dom.root.classList.remove('sheet-open');
    dom.$(btn).setAttribute('aria-expanded', 'false');
    dom.$(btn).focus({ preventScroll: true });
  }
  function jump(i) { closeSheet(); show(i, true); dom.root.focus({ preventScroll: true }); }

  function sceneList(body) {
    const ol = el('ol', 'nv-scenes');
    let curScene = -1; let curSess = -1;
    for (let j = idx; j >= 0; j--) { if (steps[j].t === 'scene' && curScene < 0 && steps[j].sess === steps[idx].sess) curScene = j; if (steps[j].t === 'session') { curSess = j; break; } }
    steps.forEach((st, i) => {
      if (st.t !== 'session' && st.t !== 'scene') return;
      const li = el('li', st.t === 'session' ? 'is-sess' : null);
      const b = el('button', null); b.type = 'button';
      if (st.t === 'session') {
        const s = A().sessionOf(st.sess);
        b.append(el('b', null, A().sessionLabel(s)));
        if (s.date) b.append(el('span', 'num', A().fmtDate(s.date)));
      } else b.append(document.createTextNode(st.e.text));
      if (i === curScene || (curScene < 0 && i === curSess)) b.setAttribute('aria-current', 'true');
      b.addEventListener('click', () => jump(i));
      li.append(b); ol.append(li);
    });
    body.append(ol);
  }

  function backlog(body) {
    const from = Math.max(0, idx - 300);
    const list = el('ol', 'nv-log');
    if (from > 0) list.append(el('li', 'nv-log-more', `더 앞의 줄은 '장면'이나 위쪽 막대로 찾아가세요`));
    let lastE = null;
    for (let i = from; i <= idx; i++) {
      const st = steps[i];
      if (st.t === 'line' && st.e === lastE) {   // 나뉜 화면은 한 줄로 이어 붙임
        const lt = list.lastChild.querySelector('.nv-log-text'); lt.append(document.createTextNode(' ')); fmt(lt, st.text);
        if (i === idx) list.lastChild.querySelector('button').setAttribute('aria-current', 'true');
        continue;
      }
      lastE = st.e || null;
      if (st.t === 'chat') {
        st.items.forEach((x) => {
          const xs = spk(x.speaker);
          const li = el('li', 'k-chat'); const b = el('button'); b.type = 'button';
          A().paint(b, xs);
          b.append(el('b', null, xs ? xs.name : '알 수 없음'), el('span', 'nv-log-text', A().stripMd(x.text)));
          if (i === idx) b.setAttribute('aria-current', 'true');
          b.addEventListener('click', () => jump(i));
          li.append(b); list.append(li);
        });
        continue;
      }
      const li = el('li', 'k-' + (st.t === 'line' ? st.e.kind : st.t));
      const b = el('button'); b.type = 'button';
      if (st.t === 'session' || st.t === 'scene') {
        b.append(el('span', 'nv-log-mark', st.t === 'session' ? A().sessionLabel(A().sessionOf(st.sess)) : st.e.text));
      } else {
        const s = spk(st.e.speaker);
        if (st.t === 'dice') {
          const d = st.e.dice || {};
          A().paint(b, s);
          b.append(el('b', null, d.who && !/님\s*PC$/i.test(d.who) ? d.who : s ? s.name : '주사위'), el('span', 'nv-log-text', diceSpeech(st.e, '').replace(/^, /, '')));
        } else if (st.t === 'sys') b.append(el('span', 'nv-log-text sys', st.e.text));
        else {
          A().paint(b, s);
          if (st.e.kind !== 'narration') b.append(el('b', null, s ? s.name : '알 수 없음'));
          const t = el('span', 'nv-log-text'); fmt(t, st.text); b.append(t);
        }
      }
      if (i === idx) b.setAttribute('aria-current', 'true');
      const target = st.t === 'line' ? firstStep.get(st.e.id) : i;
      b.addEventListener('click', () => jump(target));
      li.append(b); list.append(li);
    }
    body.append(list);
  }

  function settings(body) {
    const rows = [
      { key: 'speed', label: '글자 속도', values: [['s', '느리게'], ['m', '보통'], ['f', '빠르게'], ['i', '바로']] },
      { key: 'auto', label: '자동 넘김', values: [['s', '느리게'], ['m', '보통'], ['f', '빠르게']] },
      { key: 'size', label: '글자 크기', values: [['s', '작게'], ['m', '보통'], ['l', '크게']] },
      { key: 'chat', label: '사담', values: [[false, '숨김'], [true, '보임']] },
      { key: 'dice', label: '주사위', values: [[true, '보임'], [false, '숨김']] },
      { key: 'system', label: '진행 표시', values: [[true, '보임'], [false, '숨김']] },
    ];
    rows.forEach((o) => {
      const row = el('div', 'vp-row');
      const lab = el('span', 'vp-label', o.label); lab.id = 'nvo-' + o.key;
      const seg = el('div', 'seg'); seg.setAttribute('role', 'radiogroup'); seg.setAttribute('aria-labelledby', lab.id);
      o.values.forEach(([v, text]) => {
        const b = el('button', 'seg-btn', text); b.type = 'button'; b.setAttribute('role', 'radio');
        b.setAttribute('aria-checked', String(P[o.key] === v));
        b.addEventListener('click', () => setPref(o.key, v));
        seg.append(b);
      });
      row.append(lab, seg); body.append(row);
    });
    body.append(el('p', 'vp-note', '스페이스·→·누르기: 다음 · ←: 이전 · A: 자동 · S: 사담 건너뛰기 · L: 지난 대사 · Esc: 닫기'));
    body.append(el('p', 'vp-note', '이 기기에서 다음에 열 때도 그대로예요. 채팅 로그의 보기 설정과는 따로예요.'));
  }
  function setPref(key, v) {
    if (P[key] === v) return;
    P[key] = v; A().prefs.set('novel', P);
    applySize();
    if (key === 'chat' || key === 'dice' || key === 'system') {
      const e = entryOf(idx);
      build();
      const j = e ? stepFor(e.id) : 0;
      idx = j == null ? 0 : j;
      show(idx, true);
    }
    openSheet('set');
  }
  // 사담을 켜 두면 오른쪽에 사담 창 자리를 늘 비워 둠 (넘길 때마다 인물 카드가 들썩이지 않게)
  function applySize() { dom.root.dataset.size = P.size; dom.root.classList.toggle('chat-on', !!P.chat); }

  // ── 열기 · 닫기 ───────────────────────
  // id: 그 줄부터 / null: 기억한 곳(없으면 처음)
  N.openAt = function (id, opts) {
    opts = opts || {};
    make();
    P = Object.assign({}, DEF, A().prefs.get('novel', {}));
    applySize();
    build();
    if (!steps.length) { A().toast('노벨로 볼 줄이 없어요'); return; }
    let i = id ? stepFor(id) : null;
    if (i == null && !opts.fromStart) { const v = saved(); i = v ? stepFor(v.id) : null; }
    if (i == null) i = 0;
    if (!N.open) {
      returnFocus = document.activeElement;
      N.open = true;
      dom.root.hidden = false;
      document.documentElement.classList.add('nv-open');
      dom.$('nvTitle').textContent = A().store.book.title;
      dom.$('nvHint').hidden = !!A().prefs.get('novel:hinted', false);
      A().prefs.set('novel:hinted', true);
      A().releaseAnchor && A().releaseAnchor();
    }
    pushed = !!opts.pushed || pushed;
    show(i, false);
    dom.root.focus({ preventScroll: true });
  };

  // 채팅 로그에서 부름: 주소에 #n-… 을 남겨서 뒤로 가기로 닫히게
  N.start = function (id, fromStart) {
    if (fromStart) {
      // 처음부터: 기억한 곳을 무시
      pushed = true;
      try { history.pushState(history.state, '', '#n'); } catch (err) { /* */ }
      N.openAt(null, { fromStart: true, pushed: true });
      return;
    }
    pushed = true;
    const hash = id ? '#n-' + id : '#n';
    if (location.hash === hash) { N.openAt(id || null, { pushed: true }); return; }
    try { history.pushState(history.state, '', hash); N.openAt(id || null, { pushed: true }); } catch (err) { location.hash = hash; }
  };

  // 화면만 닫기 (뒤로 가기로 주소가 이미 바뀐 경우 등). 채팅 로그는 읽던 줄로
  N.close = function () {
    if (!N.open) return;
    const e = entryOf(idx);
    const st = steps[idx];
    N.open = false; pushed = false;
    setAuto(false); finishTyping(true); closeSheetQuiet();
    clearTimeout(saveTimer);
    if (e) A().prefs.set(posKey(), { id: e.id, at: Date.now() });
    dom.root.hidden = true;
    document.documentElement.classList.remove('nv-open');
    // 채팅 로그에서 같은 자리 (회차·장면 카드였으면 그 제목으로)
    const target = st && st.t === 'session' ? 's' + st.sess : e ? e.id : null;
    if (target) A().goTo(target);
    if (SL.app.renderHead) SL.app.renderHead();
    if (returnFocus && returnFocus.isConnected) returnFocus.focus({ preventScroll: true });
  };
  // 다른 화면으로 갈 때: 채팅 로그 자리 맞추기 없이 닫기만
  N.hide = function () {
    if (!N.open) return;
    N.open = false; pushed = false;
    setAuto(false); finishTyping(true); closeSheetQuiet(); clearTimeout(saveTimer);
    dom.root.hidden = true;
    document.documentElement.classList.remove('nv-open');
  };
  function closeSheetQuiet() { sheet = null; if (dom) { dom.$('nvSheet').hidden = true; dom.root.classList.remove('sheet-open'); } }

  function exit() {
    if (pushed) { history.back(); setTimeout(() => { if (N.open) N.close(); }, 250); return; }
    try { history.replaceState(history.state, '', location.pathname + location.search); } catch (err) { /* */ }
    N.close();
  }

  // 지금 위치 (테스트·디버그용)
  N.state = function () { const st = steps[idx]; const e = entryOf(idx); return { idx, n: steps.length, t: st && st.t, id: e && e.id, end: !!(dom && dom.$('nvCard').dataset.end), typing: !!typing, auto: autoOn, sheet }; };

  // 기록 내용이 바뀌면(다른 곳에서 고침 등) 다시 만들기
  N.refresh = function () {
    if (!N.open) return;
    const e = entryOf(idx);
    build();
    const j = e ? stepFor(e.id) : 0;
    show(j == null ? 0 : j, true);
  };

  // 머리말의 '노벨로 읽기' 단추
  N.headActions = function () {
    const box = el('div', 'novel-acts');
    const v = saved();
    const main = el('button', 'btn-novel'); main.type = 'button';
    main.append(el('span', 'nv-play', '▶'));
    if (v) {
      const e = A().store.byId.get(v.id);
      const txt = el('span'); txt.append(el('b', null, '노벨로 이어 읽기'));
      const sc = e ? sceneOfEntry(e) : null;
      txt.append(el('small', null, [A().sessionLabel(A().sessionOf(e.session)), sc ? sc.text : null].filter(Boolean).join(' · ')));
      main.append(txt);
      main.addEventListener('click', () => N.start(v.id));
      const again = el('button', 'btn-novel-sub', '처음부터'); again.type = 'button';
      again.addEventListener('click', () => N.start(null, true));
      box.append(main, again);
    } else {
      const txt = el('span'); txt.append(el('b', null, '노벨로 읽기'), el('small', null, '한 줄씩 넘기며 읽어요'));
      main.append(txt);
      main.addEventListener('click', () => N.start(null, true));
      box.append(main);
    }
    return box;
  };
  function sceneOfEntry(e) {
    const list = A().store.entries(e.session);
    let sc = null;
    for (const x of list) { if (x.seq > e.seq) break; if (x.kind === 'scene' && !x.deleted) sc = x; }
    return sc;
  }
})();
