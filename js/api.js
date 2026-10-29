/*
 * 서버 연결 — 사분면 사이트(js/api.js)와 같은 방식
 *  - SupabaseApi: 같은 Supabase 프로젝트·구글 로그인·profiles·worlds·world_access·world-assets
 *  - DemoApi: 서버 없이 예시 로그로 (이 브라우저에만 저장)
 */
(function (g) {
  'use strict';
  const SL = (g.SL = g.SL || {});
  const CFG = g.SL_CONFIG || {};
  const SUPABASE_ESM = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm';

  // 서버(Postgres) 오류 → 읽을 수 있는 말. 모르는 오류는 원문을 detail로 같이 보여 줌
  const KNOWN = [
    [/log_entries_text_check/, '5000자가 넘는 줄이 있어요.'],
    [/log_entries_dice_check/, '주사위 카드 내용이 너무 길어요.'],
    [/log_entries_ts_check/, '시각 형식이 맞지 않는 줄이 있어요.'],
    [/log_entries_src_check/, '메시지 ID가 너무 긴 줄이 있어요.'],
    [/log_speakers_name_check/, '인물 이름은 1~40자여야 해요.'],
    [/log_speakers_image_path_check/, 'NPC 이미지 경로 모양이 맞지 않아요. (예: ARCANA/NPC_01.webp)'],
    [/log_speakers_color_check/, '인물 색 값이 맞지 않아요.'],
    [/log_books_title_check/, '제목은 1~60자여야 해요.'],
    [/log_books_system_check/, '시스템 이름은 30자까지예요.'],
    [/log_books_gm_check/, 'GM 이름은 40자까지예요.'],
    [/log_sessions_title_check/, '회차 이름은 40자까지예요.'],
    [/statement timeout|canceling statement/i, '서버 처리 시간이 넘었어요. 다시 시도해 주세요.'],
    [/Could not find the function|schema cache/i, '서버 SQL이 최신이 아니에요. session_log_setup.sql을 SQL Editor에서 다시 실행해 주세요.'],
    [/unsupported Unicode|\\u0000|invalid byte sequence/i, '저장할 수 없는 글자가 섞여 있어요.'],
    [/payload too large|request entity too large|\b413\b/i, '한 번에 보내는 양이 너무 커요.'],
    [/violates check constraint/i, '서버 규칙에 맞지 않는 값이 있어요.'],
  ];
  function friendly(err) {
    const msg = String((err && err.message) || err || '');
    for (const [re, text] of KNOWN) if (re.test(msg)) return text;
    if (/row-level security|permission denied|42501/i.test(msg) && !/[가-힣]/.test(msg)) return '권한이 없어요.';
    if (/JWT|invalid token|refresh token|not authenticated/i.test(msg)) return '로그인이 만료됐어요. 다시 로그인해 주세요.';
    if (/Failed to fetch|NetworkError|network/i.test(msg)) return '서버에 연결하지 못했어요. 잠시 뒤 다시 시도해 주세요.';
    if (/[가-힣]/.test(msg)) return msg.replace(/^.*?:\s*(?=[가-힣])/, '');
    return '문제가 생겼어요. 잠시 뒤 다시 시도해 주세요.';
  }
  class ApiError extends Error {
    constructor(raw) {
      super(friendly(raw));
      this.raw = raw;
      // 원문 (오류 신고용): 코드 · 메시지 · 자세히 · 힌트
      if (raw && typeof raw === 'object') this.detail = [raw.code, raw.message, raw.details, raw.hint].filter(Boolean).join(' / ');
      this.network = /Failed to fetch|NetworkError|network/i.test(String((raw && raw.message) || raw || ''));
    }
  }

  // 보내기 전 마지막 안전망: 서버 표의 글자 수 한도에 맞추고, 저장 못 하는 글자(NUL) 빼기
  const clean = (s, n) => (typeof s === 'string' ? s.replace(/\u0000/g, '').slice(0, n) : s);
  function fitPayload(p) {
    const q = Object.assign({}, p);
    if (q.entries) q.entries = q.entries.map((e) => Object.assign({}, e, { text: clean(e.text || '', 5000), src: clean(e.src, 40), orig: clean(e.orig, 5000) }));
    if (q.speakers) q.speakers = q.speakers.map((s) => Object.assign({}, s, { name: clean(s.name, 40) || '?', charId: clean(s.charId, 40) }));
    if (q.sessions) q.sessions = q.sessions.map((s) => Object.assign({}, s, { title: clean(s.title, 40) }));
    if (q.book) q.book = fitBook(q.book);
    return q;
  }
  function fitBook(b) {
    const o = Object.assign({}, b);
    ['title', 'system', 'gm'].forEach((k, i) => { if (k in o) o[k] = clean(o[k], [60, 30, 40][i]); });
    return o;
  }
  const lsGet = (k) => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : null; } catch (e) { return null; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { return false; } };

  // DB 줄 → 화면 모양
  function entryFromRow(r, orig) {
    const e = { id: r.id, seq: Number(r.seq), session: r.session_no, kind: r.kind, speaker: r.speaker_id, text: r.text || '', ts: r.ts, src: r.src };
    if (r.dice) e.dice = r.dice;
    if (r.deleted) e.deleted = true;
    Object.assign(e, r.extra || {});
    if (orig != null) e.orig = orig;
    return e;
  }
  function speakerFromRow(r) {
    return { id: r.id, name: r.name, role: r.role, player: r.player_id, color: r.color || '#7d8a96', charId: r.char_id, image: r.image_path };
  }

  // ====================================================================
  // Supabase
  // ====================================================================
  class SupabaseApi {
    constructor() { this.demo = false; this.user = null; this.urls = new Map(); }

    async init() {
      const { createClient } = await import(SUPABASE_ESM);
      this.sb = createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY, {
        auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: 'pkce' },
      });
      const { data, error } = await this.sb.auth.getSession();
      if (error) throw new ApiError(error);
      this.user = (data.session && data.session.user) || null;
      const url = new URL(location.href);
      if (url.searchParams.has('code') || url.searchParams.has('error')) {
        ['code', 'error', 'error_description'].forEach((k) => url.searchParams.delete(k));
        history.replaceState(null, '', url.pathname + url.search + url.hash);
      }
    }
    onAuthChange(cb) {
      this.sb.auth.onAuthStateChange((event, session) => {
        const before = this.user ? this.user.id : null;
        this.user = (session && session.user) || null;
        if ((this.user ? this.user.id : null) !== before) cb();
      });
    }
    async signInWithGoogleRedirect() {
      // 돌아올 때 보던 기록을 다시 열 수 있게 기억
      try { sessionStorage.setItem('sl:return', location.search + location.hash); } catch (e) { /* 무시 */ }
      const { error } = await this.sb.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: location.origin + location.pathname } });
      if (error) throw new ApiError(error);
    }
    async renderGoogleButton(el, onError) {
      if (!CFG.GOOGLE_CLIENT_ID) return false;
      await loadScript('https://accounts.google.com/gsi/client');
      const raw = randomString(32);
      const hashed = await sha256Hex(raw);
      g.google.accounts.id.initialize({
        client_id: CFG.GOOGLE_CLIENT_ID, nonce: hashed, use_fedcm_for_prompt: true,
        callback: async ({ credential }) => {
          const { error } = await this.sb.auth.signInWithIdToken({ provider: 'google', token: credential, nonce: raw });
          if (error && onError) onError(new ApiError(error).message);
        },
      });
      g.google.accounts.id.renderButton(el, { theme: 'filled_black', size: 'large', text: 'signin_with', shape: 'pill', locale: 'ko' });
      return true;
    }
    async signOut() { await this.sb.auth.signOut(); this.user = null; }

    async getProfile() {
      if (!this.user) return null;
      const { data, error } = await this.sb.from('profiles').select('nickname, is_admin').eq('id', this.user.id).maybeSingle();
      if (error) throw new ApiError(error);
      return data ? { nickname: data.nickname || '', isAdmin: !!data.is_admin } : null;
    }
    async setNickname(nickname) {
      const existing = await this.getProfile();
      const q = existing
        ? this.sb.from('profiles').update({ nickname }).eq('id', this.user.id)
        : this.sb.from('profiles').insert({ id: this.user.id, nickname });
      const { error } = await q;
      if (error) {
        if (/duplicate|unique/i.test(error.message)) throw new ApiError('이미 쓰이고 있는 닉네임이에요.');
        throw new ApiError(error);
      }
    }
    async redeemCode(code) {
      const { data, error } = await this.sb.rpc('redeem_world_code', { p_code: code });
      if (error) throw new ApiError(error);
      return data || { ok: false, reason: 'invalid' };
    }
    async listWorlds() {
      const { data, error } = await this.sb.from('worlds').select('id, name').order('created_at', { ascending: true });
      if (error) throw new ApiError(error);
      return data || [];
    }

    // ── 기록 ──
    async listBooks(world) {
      const { data, error } = await this.sb.from('log_books')
        .select('id, title, system, gm, players, period_start, period_end, visibility, updated_at, sort_order')
        .eq('world_id', world).order('sort_order', { ascending: true }).order('period_start', { ascending: false, nullsFirst: false });
      if (error) throw new ApiError(error);
      const ids = (data || []).map((b) => b.id);
      const counts = new Map();
      const chars = new Map();
      if (ids.length) {
        const [{ data: ss }, { data: sp }] = await Promise.all([
          this.sb.from('log_sessions').select('book_id, no').in('book_id', ids),
          this.sb.from('log_speakers').select('book_id, name, role, char_id').in('book_id', ids),
        ]);
        (ss || []).forEach((s) => { if (s.no > 0) counts.set(s.book_id, (counts.get(s.book_id) || 0) + 1); });
        (sp || []).forEach((s) => {
          if (s.role !== 'pc' && s.role !== 'npc') return;
          if (!chars.has(s.book_id)) chars.set(s.book_id, []);
          chars.get(s.book_id).push({ key: s.char_id || s.name, name: s.name, role: s.role });
        });
      }
      return (data || []).map((b) => ({ id: b.id, title: b.title, system: b.system, gm: b.gm, players: b.players || [],
        period: { start: b.period_start, end: b.period_end }, visibility: b.visibility, sessions: counts.get(b.id) || 0,
        chars: chars.get(b.id) || [], updatedAt: b.updated_at }));
    }

    async loadBook(id, { admin } = {}) {
      const { data: b, error } = await this.sb.from('log_books').select('*').eq('id', id).maybeSingle();
      if (error) throw new ApiError(error);
      if (!b) throw new ApiError('기록을 찾을 수 없어요. 지워졌거나 볼 권한이 없어요.');
      const [ss, sp] = await Promise.all([
        this.sb.from('log_sessions').select('*').eq('book_id', id).order('no'),
        this.sb.from('log_speakers').select('*').eq('book_id', id),
      ]);
      if (ss.error) throw new ApiError(ss.error);
      if (sp.error) throw new ApiError(sp.error);
      const rows = await this.pageAll((from, to) => this.sb.from('log_entries')
        .select('id, seq, session_no, kind, speaker_id, text, dice, ts, src, extra, deleted').eq('book_id', id).order('seq').range(from, to));
      let origs = new Map();
      if (admin) {
        const o = await this.pageAll((from, to) => this.sb.from('log_entry_origs').select('id, orig').eq('book_id', id).range(from, to));
        origs = new Map(o.map((r) => [r.id, r.orig]));
      }
      const book = {
        title: b.title, system: b.system, gm: b.gm, players: b.players || [],
        period: { start: b.period_start, end: b.period_end }, diceLabels: b.dice_labels || {}, visibility: b.visibility,
        sessions: (ss.data || []).map((s) => ({ no: s.no, title: s.title, date: s.date })),
        speakers: (sp.data || []).map(speakerFromRow),
        entries: rows.map((r) => entryFromRow(r, origs.get(r.id))),
        source: b.source,
      };
      return { book, meta: { id: b.id, worldId: b.world_id, visibility: b.visibility } };
    }
    async pageAll(make) {
      const out = []; const size = 1000;
      for (let from = 0; ; from += size) {
        const { data, error } = await make(from, from + size - 1);
        if (error) throw new ApiError(error);
        out.push(...(data || []));
        if (!data || data.length < size) break;
      }
      return out;
    }
    async apply(bookId, payload) {
      const { error } = await this.sb.rpc('log_apply', { p_book: bookId, p: fitPayload(payload) });
      if (error) throw new ApiError(error);
    }
    async createBook(world, book) {
      const { data, error } = await this.sb.rpc('log_create_book', { p_world: world, p_book: fitBook(book) });
      if (error) throw new ApiError(error);
      return data;
    }
    async deleteBook(id) {
      const { error } = await this.sb.rpc('log_delete_book', { p_book: id });
      if (error) throw new ApiError(error);
    }

    // ── 캐릭터·이미지 (사분면과 같은 world_characters · world-assets) ──
    async listCharacters(world) {
      const { data, error } = await this.sb.from('world_characters').select('char_id, name, image_path')
        .eq('world_id', world).eq('active', true).order('sort_order', { ascending: true });
      if (error) throw new ApiError(error);
      return (data || []).map((r) => ({ id: r.char_id, name: r.name, imagePath: r.image_path }));
    }
    async imageUrl(path) {
      if (!path) return null;
      if (this.urls.has(path)) return this.urls.get(path);
      const { data } = await this.sb.storage.from('world-assets').download(path);
      const url = data ? URL.createObjectURL(data) : null;
      this.urls.set(path, url);
      return url;
    }
  }

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      if (document.querySelector(`script[src="${src}"]`) && g.google && g.google.accounts) return resolve();
      const s = document.createElement('script');
      s.src = src; s.async = true; s.onload = resolve; s.onerror = () => reject(new Error('구글 로그인 버튼을 불러오지 못했어요.'));
      document.head.appendChild(s);
    });
  }
  function randomString(n) { const a = new Uint8Array(n); crypto.getRandomValues(a); return Array.from(a, (x) => x.toString(16).padStart(2, '0')).join(''); }
  async function sha256Hex(s) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
    return Array.from(new Uint8Array(buf), (x) => x.toString(16).padStart(2, '0')).join('');
  }

  // ====================================================================
  // 데모: 서버 없이. 관리자로 들어간 것처럼 보여 줌
  // ====================================================================
  const DEMO_WORLD = { id: 'DEMO', name: '마기카로기아 (데모)' };
  const DEMO_BOOKS_KEY = 'sl:demo-books';
  class DemoApi {
    constructor() { this.demo = true; this.user = { id: 'demo' }; }
    async init() {}
    onAuthChange() {}
    async renderGoogleButton() { return false; }
    async signInWithGoogleRedirect() {}
    async signOut() {}
    async getProfile() { return { nickname: '나 (데모)', isAdmin: true }; }
    async setNickname() {}
    async redeemCode() { return { ok: true, world_id: DEMO_WORLD.id, already: true }; }
    async listWorlds() { return [DEMO_WORLD]; }
    imported() { return lsGet(DEMO_BOOKS_KEY) || []; }
    async base() {
      if (!this.baseBook) {
        const res = await fetch(CFG.DEMO_DATA || 'demo/demo-log.json');
        if (!res.ok) throw new ApiError('예시 로그를 불러오지 못했어요.');
        this.baseBook = await res.json();
      }
      return this.baseBook;
    }
    async listBooks() {
      const b = await this.base();
      const chars = (bk, edits) => {
        const sp = bk.speakers.map((s) => (edits && edits.speakers && edits.speakers[s.id]) || s);
        return sp.filter((s) => s.role === 'pc' || s.role === 'npc').map((s) => ({ key: s.charId || s.name, name: s.name, role: s.role }));
      };
      const meta = (id, bk) => {
        const ed = lsGet('sl:edits:' + id) || {};   // 데모에서 고친 제목 등도 목록에 반영
        const x = Object.assign({}, bk, ed.book || {});
        return { id, title: x.title, system: x.system, gm: x.gm, players: x.players, period: x.period, visibility: x.visibility || 'draft',
          sessions: bk.sessions.filter((s) => s.no > 0).length, chars: chars(bk, ed), updatedAt: null };
      };
      const list = [Object.assign(meta('demo', b), { visibility: 'public' })];
      this.imported().forEach((x) => list.push(meta(x.id, x.book)));
      return list;
    }
    async loadBook(id) {
      if (id === 'demo') {
        const book = JSON.parse(JSON.stringify(await this.base()));
        book.visibility = 'public';
        return { book, meta: { id, worldId: DEMO_WORLD.id, visibility: 'public' } };
      }
      const x = this.imported().find((b) => b.id === id);
      if (!x) throw new ApiError('기록을 찾을 수 없어요.');
      return { book: x.book, meta: { id, worldId: DEMO_WORLD.id, visibility: x.book.visibility || 'draft' } };
    }
    async apply() { /* 데모 수정은 store가 이 브라우저에 저장 */ }
    async createBook(world, book) {
      const id = 'imp-' + Math.random().toString(36).slice(2, 9);
      this.pendingNew = { id, book: Object.assign({ visibility: 'draft', sessions: [], speakers: [], entries: [] }, book) };
      return id;
    }
    // 가져오기는 여러 번 나눠 보내지만, 데모에서는 마지막에 한 번에 저장
    async saveImported(id, book) {
      const list = this.imported().filter((b) => b.id !== id);
      list.push({ id, book });
      if (!lsSet(DEMO_BOOKS_KEY, list)) throw new ApiError('이 브라우저에 저장할 공간이 부족해요. 데모에서는 가져온 기록을 하나만 두는 걸 권해요.');
    }
    async deleteBook(id) {
      lsSet(DEMO_BOOKS_KEY, this.imported().filter((b) => b.id !== id));
      try { localStorage.removeItem('sl:edits:' + id); } catch (e) { /* 무시 */ }
    }
    async listCharacters() { return []; }
    async imageUrl() { return null; }
  }

  SL.ApiError = ApiError;
  SL.createApi = function () {
    const params = new URLSearchParams(location.search);
    if (!CFG.SUPABASE_URL || !CFG.SUPABASE_ANON_KEY || params.has('demo')) return new DemoApi();
    return new SupabaseApi();
  };
  SL.lsGet = lsGet; SL.lsSet = lsSet;
})(typeof window !== 'undefined' ? window : globalThis);
