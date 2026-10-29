/*
 * 원자료(parseRoll20 결과) + 설정 → 기록(book)
 *
 * book = {
 *   title, system, gm, players, period: { start, end },
 *   sessions: [{ no, title, date }],               // no 0 = 준비
 *   speakers: [{ id, name, role, player, color, charId, image }],
 *   entries:  [{ id, seq, session, kind, speaker, text, dice?, ts, src }]
 * }
 * kind: narration | dialogue | chat | dice | system | scene | meta | whisper
 *   scene = 장면 제목(목차에 나옴), meta = 회차 시작 카드(날짜·GM·PL 줄, 보기에서 숨김)
 */
(function (g) {
  'use strict';

  const DATE_LINE = /^(\d{4})[.\-/]\s*(\d{1,2})[.\-/]\s*(\d{1,2})\.?$/;
  const CARD_LINE = /(세션\s*시작|^GM\s*[:：]|^PL\s*[:：])/i;
  const SCENE_LINES = [
    /^\d+\s*사이클\s*(\d+\s*번째\s*)?장면\s*\d*$/,
    /^마스터\s*씬$/,
    /^(프롤로그|오프닝|도입|클라이맥스|에필로그|엔딩)$/,
    /^제\s*\d+\s*시합$/,
  ];

  // 화자 색 (PC·NPC). 플레이어는 차분한 색.
  const CHAR_COLORS = ['#3f8f7a', '#b4664a', '#6d6bc4', '#b08a2e', '#4f84b8', '#a85a8e', '#6f8f3a', '#8a6d5a'];
  const PL_COLORS = ['#7d8a96', '#8e8597', '#8a8f7c', '#977f7f', '#7c8f95', '#8f8a7a'];

  const pad = (n) => String(n).padStart(2, '0');

  const MAX_TEXT = 4800;        // 서버 한도 5000자보다 조금 작게
  const MAX_DICE_BYTES = 6000;  // 서버 한도 8000바이트보다 작게
  // 긴 글 → MAX_TEXT 안쪽 조각들 (줄바꿈 > 문장 끝 > 띄어쓰기 > 그냥 자르기 순으로 자리 찾기)
  function splitText(t) {
    const out = [];
    let rest = t;
    while (rest.length > MAX_TEXT) {
      const head = rest.slice(0, MAX_TEXT);
      let cut = head.lastIndexOf('\n');
      if (cut < MAX_TEXT * 0.5) { const m = head.match(/^[\s\S]*[.!?。…~](?=\s)/); cut = m && m[0].length > MAX_TEXT * 0.5 ? m[0].length : -1; }
      if (cut < MAX_TEXT * 0.5) cut = head.lastIndexOf(' ');
      if (cut < MAX_TEXT * 0.5) cut = MAX_TEXT;
      // 이모지 같은 두 칸짜리 글자를 반으로 자르지 않게
      const c = rest.charCodeAt(cut - 1); if (c >= 0xd800 && c <= 0xdbff) cut--;
      out.push(rest.slice(0, cut).trim());
      rest = rest.slice(cut).replace(/^\s+/, '');
    }
    if (rest) out.push(rest);
    return out.filter(Boolean);
  }
  const bytes = (o) => new TextEncoder().encode(JSON.stringify(o)).length;
  // 주사위 카드가 너무 크면 긴 글 칸(표·효과·기타 양식 글)부터 줄임
  function fitDice(d) {
    for (let guard = 0; guard < 20 && bytes(d) > MAX_DICE_BYTES; guard++) {
      const k = ['text', 'effect', 'tableText', 'info'].filter((x) => typeof d[x] === 'string' && d[x].length > 20)
        .sort((a, b) => d[b].length - d[a].length)[0];
      if (!k) { ['dice', 'sides', 'rolls'].forEach((x) => { if (Array.isArray(d[x]) && d[x].length > 60) d[x] = d[x].slice(0, 60); }); break; }
      d[k] = d[k].slice(0, Math.floor(d[k].length * 0.6)) + '…';
    }
    return d;
  }

  function buildBook(raw, cfg) {
    cfg = cfg || {};
    const scfg = cfg.speakers || {};
    let ci = 0; let pi = 0;
    const speakers = raw.speakers.map((s, i) => {
      const c = scfg[s.key] || {};
      const role = c.role || s.guess || 'pc';
      const isChar = role === 'pc' || role === 'npc';
      return {
        id: 'p' + (i + 1),
        key: s.key,
        name: c.name || s.name,
        role,
        player: c.player || null,                  // 플레이어 화자의 key
        color: c.color || (isChar ? CHAR_COLORS[ci++ % CHAR_COLORS.length] : PL_COLORS[pi++ % PL_COLORS.length]),
        charId: c.charId || null,                  // 사분면 world_characters.char_id
        image: c.image || null,
        srcAvatars: s.avatars,
      };
    });
    const byKey = new Map(speakers.map((s) => [s.key, s]));
    speakers.forEach((s) => {
      if (s.player) { const p = byKey.get(s.player); s.player = p ? p.id : null; }
    });

    // 이름이 빠진 사담: Roll20이 말한 사람이 바뀌어도 이름을 빼먹는 경우가 있어서, 앞사람으로 붙이지 않고
    // '알 수 없음' + 화자 확인 표시 (cfg.unknownNameless = false 면 예전처럼 앞사람). 내보낸 사람 본인 것은 확실하니 그 사람으로.
    const unknownNameless = cfg.unknownNameless !== false;
    const exporter = raw.exporter ? byKey.get(raw.exporter) : null;
    const isCharSp = (x) => x && (x.role === 'pc' || x.role === 'npc');
    const entries = raw.entries.map((e, i) => {
      let sp = e.speaker ? byKey.get(e.speaker) : null;
      let kind = e.kind;
      let unsure = !!e.uncertain;
      if (kind === 'talk') {
        const namelessChat = unknownNameless && e.noName && (e.gray || !isCharSp(sp));
        if (namelessChat) {
          kind = 'chat';
          if (e.you && exporter) { sp = exporter; unsure = false; } else { sp = null; unsure = true; }
        } else kind = isCharSp(sp) ? 'dialogue' : 'chat';
      } else if (kind === 'dice' && e.noName && e.you && exporter && sp !== exporter && !isCharSp(sp)) {
        sp = exporter;   // 이름 빠진 주사위 줄 중 내보낸 사람 것은 확실
      }
      const out = { id: 'e' + (i + 1), seq: (i + 1) * 1000, session: 0, kind, speaker: sp ? sp.id : null,
        text: e.text || '', ts: e.ts, src: e.src };
      if (e.dice) out.dice = e.dice;
      if (e.to) out.to = e.to;
      if (e.from) out.from = e.from;
      if (unsure) out.uncertain = true;
      return out;
    });

    // 회차 나누기: 나레이션의 날짜 줄('2021.02.05')이 새 회차의 시작
    const sessions = [{ no: 0, title: '준비', date: null }];
    let title = cfg.title || null; let gm = cfg.gm || null; let players = cfg.players || null;
    let cur = 0;
    entries.forEach((e, i) => {
      if (e.kind === 'narration') {
        const m = e.text.match(DATE_LINE);
        if (m) {
          cur = sessions.length;
          sessions.push({ no: cur, title: cur + '회차', date: `${m[1]}-${pad(m[2])}-${pad(m[3])}` });
          e.kind = 'meta';
          // 바로 뒤 몇 줄의 시작 카드(제목·GM·PL·'세션 시작합니다')도 meta로
          let seen = 0;
          for (let j = i + 1; j < entries.length && j <= i + 8 && seen < 4; j++) {
            const n = entries[j];
            if (n.kind !== 'narration') continue;
            seen++;
            const t = n.text;
            if (/^GM\s*[:：]/i.test(t)) { n.kind = 'meta'; gm = gm || t.replace(/^GM\s*[:：]\s*/i, ''); continue; }
            if (/^PL\s*[:：]/i.test(t)) { n.kind = 'meta'; players = players || t.replace(/^PL\s*[:：]\s*/i, '').split(/\s*,\s*/); continue; }
            if (CARD_LINE.test(t)) { n.kind = 'meta'; continue; }
            if (cur === 1 && seen === 1 && t.length <= 30 && !/[.?!~]$/.test(t)) { n.kind = 'meta'; title = title || t; continue; }
            break;
          }
        }
      }
      e.session = cur;
    });
    entries.forEach((e) => {
      if ((e.kind === 'narration' || e.kind === 'system') && SCENE_LINES.some((r) => r.test(e.text.trim()))) e.kind = 'scene';
    });

    // 서버 한도(한 줄 5000자, 주사위 카드 8000바이트)에 맞추기: 긴 글은 문단·문장에서 여러 줄로 나눔
    const fitted = [];
    entries.forEach((e) => {
      if (e.dice) fitDice(e.dice);
      if (e.text && e.text.length > MAX_TEXT) splitText(e.text).forEach((part) => fitted.push(Object.assign({}, e, { text: part })));
      else fitted.push(e);
    });
    if (fitted.length !== entries.length) {
      fitted.forEach((e, i) => { e.id = 'e' + (i + 1); e.seq = (i + 1) * 1000; });
      entries.length = 0; entries.push(...fitted);
    }

    const dates = sessions.filter((s) => s.date).map((s) => s.date);
    const book = {
      title: title || '제목 없는 기록',
      system: cfg.system || null,
      gm, players: players || [],
      period: { start: dates[0] || null, end: dates[dates.length - 1] || null },
      sessions,
      speakers: speakers.map(({ key, ...s }) => s),
      entries,
      source: raw.source,
    };
    // 회차별 개수
    book.sessions.forEach((s) => { s.count = entries.filter((e) => e.session === s.no).length; });
    return book;
  }

  g.SL = g.SL || {};
  g.SL.buildBook = buildBook;
  g.SL._fit = { splitText, fitDice, MAX_TEXT };
})(typeof window !== 'undefined' ? window : globalThis);
