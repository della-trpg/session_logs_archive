/*
 * Roll20 채팅 로그(HTML 내보내기) → 정리된 원자료
 *
 * 브라우저의 DOMParser만 사용한다. (가져오기 화면에서 그대로 실행)
 * 결과는 buildBook()(js/build-book.js)에 넘겨 회차·장면·화자 설정을 입힌다.
 *
 * 원자료 형식
 * {
 *   source: 'roll20',
 *   speakers: [{ key, name, guess: 'pc'|'pl'|'gm', avatars: [url], count }],
 *   entries:  [{ src, ts, kind, speaker, text, dice?, gray?, noName?, you? }],
 *   exporter: 로그를 내보낸 사람(플레이어 이름) — 그 사람의 메시지에는 'you' 표시가 남음
 *   stats:    { messages, skipped, ... }
 * }
 * kind: narration | talk | dice | system | whisper
 *   talk  = 말한 사람의 역할(PC/NPC → 대사, 플레이어/GM → 사담)에 따라 buildBook에서 나뉨
 */
(function (g) {
  'use strict';

  const MONTHS = { january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7,
    august: 8, september: 9, october: 10, november: 11, december: 12 };

  // 'February 05, 2021 10:40PM' → '2021-02-05 22:40' (내보낸 사람 컴퓨터의 시각)
  function parseTs(s) {
    const m = String(s).trim().match(/^([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})\s+(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
    if (!m) return null;
    const mon = MONTHS[m[1].toLowerCase()];
    if (!mon) return null;
    let h = Number(m[4]) % 12;
    if (m[6].toUpperCase() === 'PM') h += 12;
    const p = (n) => String(n).padStart(2, '0');
    return `${m[3]}-${p(mon)}-${p(Number(m[2]))} ${p(h)}:${m[5]}`;
  }

  // 컷인 그림(대체 텍스트가 '4_선공공격' 같은 것) → 진행 표시 문구
  const CUTIN_LABELS = {
    '마소차지': '마소 차지', '선공공격': '선공 공격', '후공공격': '후공 공격',
    '선공소환': '선공 소환', '후공소환': '후공 소환', '라운드종료': '라운드 종료',
    '주권열기': '주권 열기', '주권닫기': '주권 닫기', '마법전': '마법전',
    '도입': '도입', '클맥': '클라이맥스', 'end': '끝',
  };
  const REACTION_ALTS = new Set(['', '그림', 'img', 'imgur', 'image', '이미지']);

  function cutinLabel(alt) {
    const a = String(alt || '').trim();
    if (REACTION_ALTS.has(a.toLowerCase())) return null;
    const core = a.replace(/^\d+_/, '');
    if (CUTIN_LABELS[core.toLowerCase()] || CUTIN_LABELS[core]) return CUTIN_LABELS[core.toLowerCase()] || CUTIN_LABELS[core];
    if (/^\d+_/.test(a)) return core;        // 번호_이름 형식은 컷인으로 본다
    return null;
  }

  // 'Rolling 2d6 = (<span>3</span>+<span>4</span>)' → { expr: '2d6', dice: [3, 4] }
  function parseRollTitle(title) {
    const plain = String(title || '').replace(/<[^>]*>/g, '');
    const m = plain.match(/^Rolling\s+(.+?)\s*=\s*(.*)$/s);
    if (!m) return { expr: '', dice: [] };
    const expr = m[1].trim();
    const dice = [];
    const inParens = m[2].match(/\(([^)]*)\)/g) || [];
    inParens.forEach((grp) => grp.slice(1, -1).split('+').forEach((n) => {
      const v = Number(n.trim());
      if (Number.isFinite(v) && n.trim() !== '') dice.push(v);
    }));
    return { expr, dice };
  }

  // 굴림 하나 → 눈 하나하나 + 면 수 + 고정값. 'Rolling 1d6+3 = (2)+3' → faces [2], sides [6], extra 3
  function rollFaces(expr, faces, total) {
    const sides = [];
    for (const m of String(expr).matchAll(/(\d*)d(\d+)/gi)) {
      const n = m[1] ? Number(m[1]) : 1;
      for (let i = 0; i < n; i++) sides.push(Number(m[2]));
    }
    const sum = faces.reduce((a, b) => a + b, 0);
    const extra = faces.length && Number.isFinite(total) ? total - sum : 0;
    return { faces, sides: faces.map((_, i) => sides[i] || null), extra };
  }

  // 글 노드 → 텍스트. 줄바꿈 보존, 인라인 굴림·그림 처리
  function walk(node, acc) {
    node.childNodes.forEach((ch) => {
      if (ch.nodeType === 3) { acc.text += ch.nodeValue; return; }
      if (ch.nodeType !== 1) return;
      const tag = ch.tagName.toLowerCase();
      const cls = ch.classList;
      if (cls.contains('inlinerollresult')) {
        const r = parseRollTitle(ch.getAttribute('title'));
        const total = Number(ch.textContent.trim());
        const roll = { expr: r.expr, dice: r.dice, total: Number.isFinite(total) ? total : null,
          text: ch.textContent.trim() };
        acc.rolls.push(roll);
        acc.text += `\u0000R${acc.rolls.length - 1}\u0000`;
        return;
      }
      if (tag === 'img') {
        const label = cutinLabel(ch.getAttribute('alt'));
        if (label) acc.cutins.push(label);
        else acc.text += '(그림)';
        return;
      }
      if (tag === 'br') { acc.text += '\n'; return; }
      if (tag === 'a' && !ch.querySelector('img')) {
        const t = ch.textContent.trim();
        acc.text += t || ch.getAttribute('href') || '';
        return;
      }
      const block = tag === 'p' || tag === 'div';
      if (block) acc.text += '\n';
      walk(ch, acc);
      if (block) acc.text += '\n';
    });
    return acc;
  }

  function cleanText(t) {
    return t
      .replace(/\$\[\[\d+\]\]/g, '')
      .replace(/ /g, ' ')
      .split('\n').map((l) => l.replace(/[ \t]+/g, ' ').trim()).filter((l, i, a) => l || (i > 0 && a[i - 1]))
      .join('\n').trim();
  }

  // 인라인 굴림 자리표시를 읽을 수 있는 글로
  function renderRolls(text, rolls) {
    return text.replace(/\u0000R(\d+)\u0000/g, (_, i) => {
      const r = rolls[Number(i)];
      return r.expr ? `[${r.expr} → ${r.text}]` : `[${r.text}]`;
    });
  }

  const txt = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : '');

  // 마기카로기아 주사위 카드(MagiDice)
  function parseMagiCard(tpl) {
    const inner = tpl.querySelector('.sheet-inner') || tpl;
    const q = (c) => inner.querySelector(':scope > .' + c);
    const card = { template: 'MagiDice', who: txt(q('sheet-subtitle')) };
    const title = q('sheet-title');
    if (title) card.title = txt(title);

    const diceEl = q('sheet-dice');
    if (diceEl) {
      card.dice = [];
      card.sides = [];
      card.rolls = [];
      diceEl.querySelectorAll('.inlinerollresult').forEach((r) => {
        const v = Number(r.textContent.trim());
        const pr = parseRollTitle(r.getAttribute('title'));
        if (!/d/i.test(pr.expr)) { if (Number.isFinite(v)) card.mod = (card.mod || 0) + v; return; }  // 수정치(-1 등)
        card.rolls.push(pr.expr);
        const f = rollFaces(pr.expr, pr.dice, v);
        if (f.faces.length) {           // 2D6 = (5+4) → 5, 4 따로
          card.dice.push(...f.faces); card.sides.push(...f.sides);
          if (f.extra) card.mod = (card.mod || 0) + f.extra;   // 1D6+3 의 +3
        } else if (Number.isFinite(v)) { card.dice.push(v); card.sides.push(null); }
      });
      if (!card.mod) delete card.mod;
    }

    const info = q('sheet-info');
    if (info) {
      const it = txt(info);
      const tm = it.match(/목표치\s*(\d+)/);
      if (tm) card.target = Number(tm[1]);
      if (/^가변/.test(it)) {
        card.variable = true;
        const em = info.querySelector('em');
        if (em) card.specialty = txt(em);
      } else if (tm) {
        const sp = it.replace(/목표치.*$/, '').trim();
        if (sp) card.specialty = sp;
      } else {
        card.info = it;   // 운명 변전 표의 '좌절' 같은 것
      }
    }

    const con = q('sheet-con');
    if (con) {
      const c = con.cloneNode(true);
      const p = c.querySelector('p');
      if (p) {
        const t = txt(p.querySelector('.sheet-type'));
        if (t) card.spellType = t;
        const cost = txt(p.querySelector('.sheet-cost')).replace(/^C\s*:\s*/, '');
        if (cost) card.cost = cost;
        const tg = txt(p.querySelector('.sheet-target'));
        if (tg) card.scope = tg;
        p.remove();
      }
      const body = cleanText(walk(c, { text: '', rolls: [], cutins: [] }).text.replace(/\u0000R\d+\u0000/g, ''))
        || txt(c.querySelector('.inlinerollresult'));
      // 표 굴림(1t[scene])은 결과 문구가 굴림 안에 들어 있음
      const tableRoll = c.querySelector('.inlinerollresult');
      if (tableRoll && /\dt\[/.test(tableRoll.getAttribute('title') || '')) card.tableText = txt(tableRoll);
      else if (body) card.effect = body;
    }

    const subj = q('sheet-subject');
    if (subj) {
      const m = txt(subj).match(/^(.+?)\s*:\s*(.+)$/);
      if (m) { card.domain = m[1].trim(); card.pick = m[2].trim(); } else card.pick = txt(subj);
    }

    // 카드 종류
    const TABLES = /표$/;
    if (card.pick) card.kind = 'pick';                                   // 무작위 특기 결정
    else if (card.title && TABLES.test(card.title.replace(/\s/g, ''))) card.kind = 'table';
    else if (card.spellType === '장비' && !card.dice) card.kind = 'equip';
    else if (card.title && card.spellType) card.kind = 'spell';          // 주문·소환 사용
    else if (card.title && card.dice) card.kind = 'check';               // 특기 판정
    else card.kind = 'roll';
    if (card.kind === 'table' && !card.tableText && card.effect) { card.tableText = card.effect; delete card.effect; }

    // 자동 판정: 2D6 합 ≥ 목표치. 12 스페셜, 2 펌블. (수정치는 로그에 없어서 반영 못 함)
    // 스페셜·펌블은 주사위 눈 그대로(2D6=12 / 2), 성공·실패는 수정치를 더한 달성치로
    if (card.dice && card.dice.length) {
      const raw = card.dice.reduce((a, b) => a + b, 0);
      if (card.dice.length > 1 || card.mod) card.sum = raw + (card.mod || 0);
      if (card.dice.length === 2 && card.kind !== 'roll') {
        const total = raw + (card.mod || 0);
        if (raw === 12) card.result = 'special';
        else if (raw === 2) card.result = 'fumble';
        else if (typeof card.target === 'number') card.result = total >= card.target ? 'success' : 'fail';
      }
    }
    return card;
  }

  function parseOtherTemplate(tpl) {
    return { template: (tpl.className.match(/sheet-rolltemplate-(\S+)/) || [])[1] || 'unknown',
      kind: 'other', text: cleanText(walk(tpl, { text: '', rolls: [], cutins: [] }).text.replace(/\u0000R\d+\u0000/g, '')) };
  }

  function parseRoll20(html) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const msgs = Array.from(doc.querySelectorAll('div.message'));
    if (!msgs.length) throw new Error('Roll20 채팅 로그가 아닌 것 같아요. (div.message를 찾지 못함)');

    const speakers = new Map();      // key → speaker
    const avatarOwner = new Map();   // 플레이어 아바타 주소 → 이름 (귓속말 주인 찾기용)
    const entries = [];
    const stats = { messages: msgs.length, skipped: 0, inheritedSpeaker: 0 };

    let curName = null; let curAvatar = null; let curTs = null; let afterNarr = false; let exporter = null;

    function speakerFor(name, avatar) {
      const isGm = /\(GM\)\s*$/.test(name);
      const base = name.replace(/\s*\(GM\)\s*$/, '').trim();
      let sp = speakers.get(base);
      if (!sp) {
        sp = { key: base, name: base, guess: null, avatars: [], count: 0 };
        speakers.set(base, sp);
      }
      const isPlayerAvatar = avatar && avatar.startsWith('/users/avatar/');
      if (isGm) sp.guess = 'gm';
      else if (!sp.guess) sp.guess = isPlayerAvatar ? 'pl' : 'pc';
      if (avatar && !sp.avatars.includes(avatar) && !isPlayerAvatar) sp.avatars.push(avatar);
      if (isPlayerAvatar && !avatarOwner.has(avatar)) avatarOwner.set(avatar, base);
      return sp;
    }

    msgs.forEach((m, idx) => {
      const by = m.querySelector(':scope > .by');
      const av = m.querySelector(':scope > .avatar img');
      const ts = m.querySelector(':scope > .tstamp');
      if (ts) curTs = parseTs(ts.textContent) || curTs;
      const cls = m.classList;
      const src = m.getAttribute('data-messageid') || `#${idx}`;
      const isDesc = cls.contains('desc');
      const isEmote = cls.contains('emote');
      const isWhisper = cls.contains('whisper');

      if (by && !isWhisper) {
        curName = by.textContent.replace(/:\s*$/, '').trim();
        curAvatar = av ? av.getAttribute('src') : null;
        // 로그를 내보낸 사람: 'you' 표시가 붙은 메시지를 플레이어 이름으로 보낸 사람
        if (!exporter && cls.contains('you') && curAvatar && curAvatar.startsWith('/users/avatar/')) exporter = curName.replace(/\s*\(GM\)\s*$/, '').trim();
      } else if (!by && !isDesc && !isEmote) {
        stats.inheritedSpeaker++;
      }
      // 나레이션 바로 뒤에 이름 없이 이어진 메시지는 화자가 애매함 (나레이션을 쓴 사람일 수도)
      const uncertain = afterNarr && !by && !isDesc && !isEmote;
      afterNarr = isDesc || isEmote;

      const body = m.cloneNode(true);
      body.querySelectorAll(':scope > .spacer, :scope > .avatar, :scope > .tstamp, :scope > .by').forEach((x) => x.remove());

      const base = { src, ts: curTs };
      if (uncertain) { base.uncertain = true; stats.uncertain = (stats.uncertain || 0) + 1; }
      const tpl = body.querySelector('[class*="sheet-rolltemplate-"]');

      if (isWhisper) {
        const avatar = av ? av.getAttribute('src') : null;
        const ownerName = (avatar && avatarOwner.get(avatar)) || (by ? by.textContent : '');
        const target = (by ? by.textContent : '').match(/^\(To (.+?)\):?$/);
        const sp = speakerFor(ownerName.replace(/:\s*$/, '').trim() || '알 수 없음', avatar);
        sp.count++;
        entries.push({ ...base, kind: 'whisper', speaker: sp.key, to: target ? target[1] : null,
          text: cleanText(walk(body, { text: '', rolls: [], cutins: [] }).text) });
        return;
      }

      if (tpl) {
        const sp = curName ? speakerFor(curName, curAvatar) : null;
        if (sp) sp.count++;
        const dice = tpl.className.includes('sheet-rolltemplate-MagiDice') ? parseMagiCard(tpl) : parseOtherTemplate(tpl);
        const de = { ...base, kind: 'dice', speaker: sp ? sp.key : null, dice, text: '' };
        if (!by) { de.noName = true; if (cls.contains('you')) de.you = true; }
        entries.push(de);
        return;
      }

      const acc = walk(body, { text: '', rolls: [], cutins: [] });
      const gray = !!m.querySelector(':scope > span[style*="aaaaaa"]');
      const onlyRolls = acc.rolls.length && cleanText(acc.text.replace(/\u0000R\d+\u0000/g, '')) === '';
      const text = cleanText(renderRolls(acc.text, acc.rolls));

      if (isDesc || isEmote) {
        if (!text && !acc.cutins.length) { stats.skipped++; return; }
        entries.push({ ...base, kind: isDesc ? 'narration' : 'system', speaker: null, text: text || acc.cutins.join(' · ') });
        return;
      }

      const sp = curName ? speakerFor(curName, curAvatar) : null;

      acc.cutins.forEach((label) => entries.push({ ...base, kind: 'system', speaker: null, text: label, from: 'cutin' }));

      if (onlyRolls) {
        if (sp) sp.count++;
        entries.push({ ...base, kind: 'dice', speaker: sp ? sp.key : null, text: '', ...(by ? {} : { noName: true, ...(cls.contains('you') ? { you: true } : {}) }),
          dice: (() => {
            const fs = acc.rolls.map((r) => rollFaces(r.expr, r.dice, r.total));
            const d = { template: 'inline', kind: 'roll', rolls: acc.rolls.map((r) => r.expr),
              dice: fs.flatMap((f) => f.faces), sides: fs.flatMap((f) => f.sides),
              total: acc.rolls.length === 1 ? acc.rolls[0].total : null, totals: acc.rolls.map((r) => r.total) };
            const extra = fs.reduce((a, f) => a + f.extra, 0);
            if (extra) d.mod = extra;
            return d;
          })() });
        return;
      }
      if (!text) { if (!acc.cutins.length) stats.skipped++; return; }
      if (sp) sp.count++;
      const e = { ...base, kind: 'talk', speaker: sp ? sp.key : null, text };
      if (gray) e.gray = true;
      if (!by) { e.noName = true; if (cls.contains('you')) e.you = true; }   // 이름이 빠진 줄 (앞사람 이름을 이어받은 것)
      entries.push(e);
    });

    stats.entries = entries.length;
    return { source: 'roll20', speakers: Array.from(speakers.values()), entries, stats, exporter };
  }

  g.SL = g.SL || {};
  g.SL.parseRoll20 = parseRoll20;
  g.SL._roll20 = { parseTs, parseRollTitle, cutinLabel };
})(typeof window !== 'undefined' ? window : globalThis);
