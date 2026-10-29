/*
 * Roll20 로그 가져오기 (관리자)
 * 파일은 브라우저 안에서만 읽고(js/parse-roll20.js), 글·주사위 값만 뽑아 저장한다.
 * 1) 파일 고르기 → 2) 기록 정보·인물 정하기 (미리보기가 바로 바뀜) → 3) 초안으로 저장
 */
(function () {
  'use strict';
  const SL = window.SL;
  const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
  const ROLES = [['pc', 'PC'], ['npc', 'NPC'], ['gm', 'GM'], ['pl', '플레이어']];
  const KIND_LABEL = { dialogue: '대사', narration: '나레이션', chat: '사담', dice: '주사위', system: '진행', scene: '장면', meta: '회차 카드', whisper: '귓속말' };
  const CHUNK = 500;   // 한 번에 보내는 줄 수 (서버 처리 시간 여유)

  SL.importPage = function (root, ctx) {
    const st = { raw: null, cfg: null, world: ctx.world.id, prep: true, unknown: true, chars: [], book: null };
    const wrap = el('div', 'imp');
    const back = el('button', 'btn-link', '← 기록 목록'); back.type = 'button'; back.addEventListener('click', () => ctx.nav(''));
    wrap.append(back, el('h1', 'home-title', 'Roll20 로그 가져오기'),
      el('p', 'muted', 'Roll20에서 내보낸 채팅 기록 HTML을 올려 주세요. 파일은 이 브라우저 안에서만 읽고, 글과 주사위 값만 뽑아 저장해요. 저장하면 초안으로 만들어지고, 편집 화면에서 다듬은 뒤 공개로 바꾸면 돼요.'));

    // 1) 파일
    const drop = el('label', 'drop'); drop.htmlFor = 'impFile';
    const file = el('input'); file.type = 'file'; file.id = 'impFile'; file.accept = '.html,.htm,text/html';
    const dropText = el('span', null, 'HTML 파일 고르기 (또는 여기로 끌어 놓기)');
    drop.append(file, dropText);
    const status = el('p', 'muted small'); status.setAttribute('role', 'status');
    wrap.append(drop, status);
    const body = el('div', 'imp-body'); body.hidden = true;
    wrap.append(body);
    root.replaceChildren(wrap);

    const read = (f) => {
      if (!f) return;
      if (f.size > 30 * 1024 * 1024) { status.textContent = '30MB보다 큰 파일은 가져올 수 없어요.'; return; }
      status.textContent = `${f.name} 읽는 중…`;
      const r = new FileReader();
      r.onload = () => {
        try {
          st.raw = SL.parseRoll20(String(r.result));
          st.fileName = f.name;
          setup();
          status.textContent = `${f.name} · 메시지 ${st.raw.stats.messages.toLocaleString()}개를 읽었어요.`;
          dropText.textContent = '다른 파일 고르기';
        } catch (e) { status.textContent = e.message || '읽지 못했어요.'; }
      };
      r.onerror = () => { status.textContent = '파일을 읽지 못했어요.'; };
      r.readAsText(f, 'utf-8');
    };
    file.addEventListener('change', () => read(file.files[0]));
    drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('over'));
    drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('over'); read(e.dataTransfer.files[0]); });

    // 2) 설정
    async function setup() {
      // 처음 한 번 만들어서 감지된 제목·GM·PL·색을 기본값으로
      const first = SL.buildBook(st.raw, {});
      // 시스템: 주사위 카드 양식으로 짐작 (MagiDice → 마기카로기아)
      const tpl = st.raw.entries.find((e) => e.dice && e.dice.template && e.dice.template !== 'inline');
      const guessSystem = tpl && tpl.dice.template === 'MagiDice' ? '마기카로기아' : '';
      st.cfg = { title: first.title, system: first.system || guessSystem, gm: first.gm || '', players: (first.players || []).join(', '), speakers: {} };
      st.raw.speakers.forEach((s, i) => { st.cfg.speakers[s.key] = { name: s.name, role: s.guess || 'pc', player: '', color: first.speakers[i].color, charId: '' }; });
      st.chars = await ctx.worldChars(st.world);
      drawSetup();
    }

    function field(label, input) { const l = el('label', 'ask-field'); l.htmlFor = input.id; l.append(el('span', null, label), input); return l; }
    function text(id, value, max, on) { const i = el('input'); i.id = id; i.value = value || ''; if (max) i.maxLength = max; i.addEventListener('input', () => { on(i.value); preview(); }); return i; }
    function select(id, opts, value, on) {
      const s = el('select'); s.id = id;
      opts.forEach(([v, t]) => { const o = el('option', null, t); o.value = v; o.selected = v === value; s.append(o); });
      s.addEventListener('change', () => on(s.value));
      return s;
    }

    function drawSetup() {
      body.hidden = false; body.replaceChildren();
      // 기록 정보
      const info = el('section', 'imp-sec'); info.append(el('h2', null, '기록 정보'));
      const worldSel = select('impWorld', ctx.worlds.map((w) => [w.id, w.name]), st.world, async (v) => { st.world = v; st.chars = await ctx.worldChars(v); drawSetup(); });
      info.append(
        field('세계관', worldSel),
        field('제목', text('impTitle', st.cfg.title, 60, (v) => { st.cfg.title = v; })),
        field('시스템', text('impSystem', st.cfg.system, 30, (v) => { st.cfg.system = v; })),
        field('GM', text('impGm', st.cfg.gm, 40, (v) => { st.cfg.gm = v; })),
        field('PL (쉼표로 구분)', text('impPl', st.cfg.players, 200, (v) => { st.cfg.players = v; })));
      const prep = el('label', 'check'); const cb = el('input'); cb.type = 'checkbox'; cb.id = 'impPrep'; cb.checked = st.prep;
      cb.addEventListener('change', () => { st.prep = cb.checked; preview(); });
      prep.append(cb, el('span', null, '1회차 전 준비 대화도 넣기 (캐릭터 소개 등)'));
      info.append(prep);
      const unk = el('label', 'check'); const cb2 = el('input'); cb2.type = 'checkbox'; cb2.id = 'impUnknown'; cb2.checked = st.unknown;
      cb2.addEventListener('change', () => { st.unknown = cb2.checked; preview(); });
      unk.append(cb2, el('span', null, "이름이 빠진 사담은 '알 수 없음'으로 넣기 (끄면 앞사람의 말로)"));
      info.append(unk);
      body.append(info);

      // 인물
      const ppl = el('section', 'imp-sec'); ppl.append(el('h2', null, '인물'),
        el('p', 'muted small', '말한 사람마다 역할을 정해 주세요. PC·NPC의 말은 대사, 플레이어·GM의 말은 사담이 돼요. 나중에 편집 화면에서도 바꿀 수 있어요.'));
      const table = el('div', 'imp-people');
      const order = st.raw.speakers.slice().sort((a, b) => b.count - a.count);
      order.forEach((s) => {
        const c = st.cfg.speakers[s.key];
        const k = 'sp' + st.raw.speakers.indexOf(s);   // 화면 요소 id용 (이름은 한글이라 그대로 못 씀)
        const row = el('div', 'imp-person');
        const color = el('input'); color.type = 'color'; color.id = 'impC-' + k; color.value = c.color; color.setAttribute('aria-label', `${s.name} 색`);
        color.addEventListener('change', () => { c.color = color.value; });
        const name = el('input'); name.id = 'impN-' + k; name.value = c.name; name.maxLength = 40; name.setAttribute('aria-label', `${s.key} 표시 이름`);
        name.addEventListener('input', () => { c.name = name.value; });
        const role = select('impR-' + k, ROLES, c.role, (v) => { c.role = v; drawSetup(); });
        role.setAttribute('aria-label', `${s.name} 역할`);
        row.append(color, name, role);
        if (c.role === 'pc' || c.role === 'npc') {
          const players = Object.entries(st.cfg.speakers).filter(([, x]) => x.role === 'pl' || x.role === 'gm').map(([k, x]) => [k, x.name]);
          const pl = select('impP-' + k, [['', c.role === 'npc' ? '(NPC)' : 'PL 미정']].concat(players), c.player, (v) => { c.player = v; });
          pl.setAttribute('aria-label', `${s.name} 플레이어`);
          row.append(pl);
          if (st.chars.length) {
            const ch = select('impH-' + k, [['', '사분면 이미지 없음']].concat(st.chars.map((x) => [x.id, '이미지: ' + x.name])), c.charId, (v) => { c.charId = v; });
            ch.setAttribute('aria-label', `${s.name} 사분면 캐릭터 이미지`);
            row.append(ch);
          }
        }
        row.append(el('span', 'imp-n', `${s.count.toLocaleString()}줄`));
        table.append(row);
      });
      ppl.append(table);
      body.append(ppl);

      // 미리보기 · 저장
      const pv = el('section', 'imp-sec'); pv.append(el('h2', null, '미리보기'));
      st.pvBox = el('div', 'imp-preview'); pv.append(st.pvBox);
      const save = el('button', 'btn primary', '초안으로 저장'); save.type = 'button'; save.id = 'impSave';
      st.progress = el('p', 'muted small'); st.progress.setAttribute('role', 'status');
      st.detail = el('p', 'imp-detail'); st.detail.hidden = true;
      save.addEventListener('click', () => doSave(save));
      pv.append(save, st.progress, st.detail);
      body.append(pv);
      preview();
    }

    function buildCfg() {
      const sp = {};
      Object.entries(st.cfg.speakers).forEach(([k, c]) => {
        sp[k] = { name: c.name.trim() || k, role: c.role, color: c.color, charId: c.charId || null,
          player: (c.role === 'pc' || c.role === 'npc') && c.player ? c.player : null };
      });
      return { unknownNameless: st.unknown, title: st.cfg.title.trim() || null, system: st.cfg.system.trim() || null, gm: st.cfg.gm.trim() || null,
        players: st.cfg.players.split(',').map((x) => x.trim()).filter(Boolean), speakers: sp };
    }
    function build() {
      const cfg = buildCfg();
      const b = SL.buildBook(st.raw, cfg);
      if (cfg.title) b.title = cfg.title;
      b.system = cfg.system; b.gm = cfg.gm; b.players = cfg.players;
      if (!st.prep) { b.entries = b.entries.filter((e) => e.session !== 0); b.sessions = b.sessions.filter((s) => s.no !== 0); }
      b.speakers.forEach((s) => { delete s.srcAvatars; });
      // 서버 제한에 맞추기 (긴 글은 자르고, 너무 큰 주사위 카드는 효과 문구를 뺌)
      b.entries.forEach((e) => {
        if (e.text.length > 5000) e.text = e.text.slice(0, 5000);
        if (e.dice && JSON.stringify(e.dice).length > 6000) delete e.dice.effect;
      });
      b.visibility = 'draft';
      b.source = 'roll20';
      return b;
    }

    let pvTimer = 0;
    function preview() {
      clearTimeout(pvTimer);
      pvTimer = setTimeout(() => {
        const b = (st.book = build());
        const box = st.pvBox; box.replaceChildren();
        const sum = el('p', null, `${b.title} · ${b.period.start ? b.period.start.replace(/-/g, '.') : '날짜 없음'}${b.period.end && b.period.end !== b.period.start ? ' – ' + b.period.end.replace(/-/g, '.') : ''} · 줄 ${b.entries.length.toLocaleString()}개`);
        box.append(sum);
        const t = el('div', 'imp-sessions');
        b.sessions.forEach((s) => {
          const list = b.entries.filter((e) => e.session === s.no);
          if (!list.length) return;
          const c = {}; list.forEach((e) => { c[e.kind] = (c[e.kind] || 0) + 1; });
          const row = el('div', 'imp-srow');
          row.append(el('b', null, s.no === 0 ? '준비' : `${s.no}회차`), el('span', 'num', s.date ? s.date.replace(/-/g, '.') : '—'),
            el('span', 'muted small', ['dialogue', 'narration', 'dice', 'chat', 'scene'].filter((k) => c[k]).map((k) => `${KIND_LABEL[k]} ${c[k].toLocaleString()}`).join(' · ')));
          t.append(row);
        });
        box.append(t);
        const unknown = b.entries.filter((e) => e.kind === 'chat' && !e.speaker && e.uncertain).length;
        const unc = b.entries.filter((e) => e.uncertain).length - unknown;
        const notes = [];
        if (b.sessions.length <= 1) notes.push('회차 구분(나레이션의 날짜 줄)을 찾지 못해서 한 회차로 들어가요. 편집 화면에서 "이 줄부터 다음 회차로"로 나눌 수 있어요.');
        if (st.unknown) notes.push(`Roll20이 이름을 빼먹은 사담 ${unknown.toLocaleString()}줄은 '알 수 없음'으로 넣고 '화자 확인' 표시를 붙였어요. 로그를 내보낸 사람 본인의 줄은 확실해서 그 사람으로 넣었어요.`);
        else notes.push('Roll20이 이름을 빼먹은 줄은 앞사람의 말로 들어가요. 틀린 경우가 섞여 있으니 편집 화면에서 확인해 주세요.');
        if (unc > 0) notes.push(`그 밖에 말한 사람이 애매한 줄 ${unc}개에도 '화자 확인' 표시를 붙였어요.`);
        const ul = el('ul', 'imp-notes'); notes.forEach((n) => ul.append(el('li', null, n))); box.append(ul);
      }, 150);
    }

    // 3) 저장: 기록 만들기 → 회차·인물 → 줄을 1000개씩
    let resume = null;
    async function doSave(btn) {
      btn.disabled = true;
      const b = resume ? resume.book : build();
      const say = (t) => { st.progress.textContent = t; };
      st.detail.hidden = true; st.detail.replaceChildren();
      let step = '기록 만들기';
      try {
        let id = resume && resume.id;
        let from = resume ? resume.from : 0;
        if (!id) {
          say('기록을 만드는 중…');
          id = await ctx.api.createBook(st.world, { title: b.title, system: b.system, gm: b.gm, players: b.players, period: b.period, diceLabels: {}, source: 'roll20' });
          resume = { id, book: b, from: 0, headDone: false };
        }
        if (!resume.headDone) {
          step = '회차·인물 저장';
          await ctx.api.apply(id, { sessions: b.sessions.map((s) => ({ no: s.no, title: s.title, date: s.date })), speakers: b.speakers });
          resume.headDone = true;
        }
        for (; from < b.entries.length; from += CHUNK) {
          resume.from = from;
          const to = Math.min(from + CHUNK, b.entries.length);
          step = `줄 ${(from + 1).toLocaleString()}~${to.toLocaleString()} 저장`;
          say(`줄 저장 중… ${to.toLocaleString()} / ${b.entries.length.toLocaleString()}`);
          try {
            await ctx.api.apply(id, { entries: b.entries.slice(from, to) });
          } catch (e) {
            // 연결·로그인 문제가 아니면 어느 줄에서 막히는지 좁혀서 알려 줌 (앞쪽 성공한 줄은 저장됨)
            if (!e.network && !/로그인/.test(e.message)) e.badAt = await findBad(id, b, from, to, say);
            throw e;
          }
        }
        if (ctx.api.demo) await ctx.api.saveImported(id, b);
        resume = null;
        say('저장했어요. 기록을 여는 중…');
        if (ctx.selectWorld) ctx.selectWorld(st.world);
        ctx.nav('?b=' + encodeURIComponent(id));
      } catch (e) {
        btn.disabled = false;
        btn.textContent = resume ? '이어서 다시 저장' : '초안으로 저장';
        say(`저장하지 못했어요 (${step}): ${e.message}${resume ? ' — 버튼을 누르면 멈춘 곳부터 이어서 저장해요.' : ''}`);
        // 오류 신고용 자세한 내용
        const lines = [];
        if (e.badAt != null) {
          const x = b.entries[e.badAt];
          const who = x.speaker ? (b.speakers.find((s) => s.id === x.speaker) || {}).name : null;
          lines.push(`막힌 줄: ${(e.badAt + 1).toLocaleString()}번째 · ${who || x.kind} · 글자 ${String(x.text || '').length.toLocaleString()}자${x.dice ? ' · 주사위 카드' : ''}`);
          lines.push(`내용 앞부분: ${String(x.text || (x.dice && (x.dice.title || x.dice.text)) || '').slice(0, 60)}`);
        }
        if (e.detail) lines.push(`서버 원문: ${e.detail}`);
        if (lines.length) {
          lines.forEach((t) => st.detail.append(el('span', null, t)));
          st.detail.hidden = false;
        }
      }
    }
    // 실패한 묶음을 반씩 나눠 보내며 처음 막히는 줄 찾기 (최대 10번쯤)
    async function findBad(id, b, from, to, say) {
      let lo = from; let hi = to;
      say('막힌 줄을 찾는 중…');
      while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        try { await ctx.api.apply(id, { entries: b.entries.slice(lo, mid) }); lo = mid; } catch (e) { hi = mid; }
      }
      try { await ctx.api.apply(id, { entries: [b.entries[lo]] }); return null; } catch (e) { return lo; }
    }
  };
})();
