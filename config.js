// 세션 기록 사이트 설정 — 공개돼도 되는 값만 넣어요.
// 세 값은 카드 사이트·캐릭터 사분면의 config와 같은 값이에요.
// 비워 두면 서버 없이 도는 '데모 모드'가 돼요 (데모용 예시 로그 파일이 있을 때만).
window.SL_CONFIG = {
  SUPABASE_URL: '',
  SUPABASE_ANON_KEY: '',
  GOOGLE_CLIENT_ID: '',

  // (선택) 들어갈 수 있는 세계관이 여러 개일 때 처음 여는 세계관 ID. 비우면 마지막에 본 곳 → 첫 번째.
  WORLD_ID: '',
  DEMO_DATA: 'demo/demo-log.json',
};
