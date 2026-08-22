'use strict';

// 하네스 코어 — 순수 함수만 둔다. I/O(파일, 네트워크)는 scripts/ 쪽 책임.

function depsDone(task, byId) {
  return (task.depends_on || []).every((id) => byId[id] && byId[id].status === 'done');
}

// 다음에 에이전트가 수행할 작업 하나와, 지금 사람이 처리 가능한 작업 목록을 고른다.
function pickNextTask(state) {
  const byId = Object.fromEntries(state.tasks.map((t) => [t.id, t]));
  const runnable = state.tasks.filter(
    (t) => !t.requires_human && t.status !== 'done' && depsDone(t, byId)
  );
  const task =
    runnable.find((t) => t.status === 'in_progress') ||
    runnable.find((t) => t.status === 'pending') ||
    null;
  const humanActions = state.tasks.filter(
    (t) => t.requires_human && t.status !== 'done' && depsDone(t, byId)
  );
  return { task, humanActions };
}

// 목표 판정. balanceSats가 null이면 지갑 미연동 상태(configured=false).
function evaluateGoal(goal, balanceSats) {
  if (balanceSats == null) {
    return { configured: false, achieved: false };
  }
  const receivedSats = Math.max(0, balanceSats - goal.baseline_sats);
  return {
    configured: true,
    achieved: receivedSats >= goal.target_sats,
    receivedSats,
    remainingSats: Math.max(0, goal.target_sats - receivedSats),
  };
}

// LNbits GET /api/v1/wallet 응답의 balance는 밀리사토시(msat) 단위다.
function parseLnbitsWallet(json) {
  if (!json || typeof json.balance !== 'number' || Number.isNaN(json.balance)) {
    throw new TypeError('LNbits 지갑 응답에 숫자 balance 필드가 없습니다');
  }
  return Math.floor(json.balance / 1000);
}

// Blink GraphQL me 쿼리 응답에서 BTC 지갑 잔액을 꺼낸다. Blink는 sat 단위다.
function parseBlinkWallets(json) {
  const wallets = json?.data?.me?.defaultAccount?.wallets;
  if (!Array.isArray(wallets)) {
    throw new TypeError('Blink 응답에 defaultAccount.wallets 배열이 없습니다');
  }
  const btc = wallets.find((w) => w && w.walletCurrency === 'BTC');
  if (!btc || typeof btc.balance !== 'number' || Number.isNaN(btc.balance)) {
    throw new TypeError('Blink 응답에 숫자 balance를 가진 BTC 지갑이 없습니다');
  }
  return btc.balance;
}

// Blink API 키 형식을 오프라인으로 점검한다(네트워크 호출 없이 흔한 복붙 실수를 즉시 잡기 위함).
function validateBlinkKeyFormat(key) {
  if (typeof key !== 'string' || key.length === 0) {
    return { valid: false, reason: 'BLINK_API_KEY가 비어 있습니다.' };
  }
  if (key !== key.trim()) {
    return { valid: false, reason: 'BLINK_API_KEY 앞뒤에 공백/줄바꿈이 섞여 있습니다. 복붙 시 딸려온 공백을 제거하세요.' };
  }
  if (!key.startsWith('blink_')) {
    const parts = key.split('_');
    const found = parts.length > 2 ? `${parts[0]}_${parts[1]}_` : `${parts[0]}_`;
    return {
      valid: false,
      reason: `Blink 키는 "blink_"로 시작해야 하는데 "${found}" 접두사가 발견됐습니다. dashboard.blink.sv → API Keys에서 발급한 키가 맞는지 확인하세요 (다른 서비스 키가 잘못 들어갔을 수 있습니다).`,
    };
  }
  return { valid: true };
}

// Coinos GET /api/me 응답. 오픈소스(routes/users.ts)의 me 핸들러가 user.balance를
// sats로 채운다. 잔액 0은 정상값(아직 못 받은 상태)이라 falsy 검사로 거를 수 없다.
function parseCoinosWallet(json) {
  if (!json || typeof json.balance !== 'number' || !Number.isFinite(json.balance)) {
    throw new TypeError('Coinos 응답에 숫자 balance 필드가 없습니다');
  }
  return Math.floor(json.balance);
}

// Coinos 토큰은 JWT라 Blink의 blink_ 같은 접두사가 없다. 구조로 판단해
// 네트워크 왕복 없이 흔한 복붙 실수를 잡는다.
function validateCoinosTokenFormat(token) {
  if (typeof token !== 'string' || token.length === 0) {
    return { valid: false, reason: 'COINOS_TOKEN이 비어 있습니다.' };
  }
  if (token !== token.trim()) {
    return { valid: false, reason: 'COINOS_TOKEN 앞뒤에 공백/줄바꿈이 섞여 있습니다. 복붙 시 딸려온 공백을 제거하세요.' };
  }
  // 이전 공급자 키를 그대로 둔 채 이름만 바꾸는 실수가 실제로 있었다.
  if (token.startsWith('blink_') || token.startsWith('ak_')) {
    return {
      valid: false,
      reason: `Blink 등 다른 서비스의 키로 보입니다("${token.split('_')[0]}_" 접두사). Coinos 토큰은 coinos.io 로그인 후 문서 페이지나 /api/login 응답에서 받습니다.`,
    };
  }
  if (token.split('.').length !== 3) {
    return { valid: false, reason: 'Coinos 토큰은 점(.)으로 구분된 3구획 JWT여야 합니다.' };
  }
  return { valid: true };
}

// check-goal.js가 어느 지갑 공급자를 쓸지 고른다. Coinos > Blink > LNbits 순서로
// 존재 여부만 보고 고르되(2026-08-16 Blink→Coinos 전환 후 새 설정이 항상 우선하도록),
// 고른 공급자의 토큰 형식이 틀렸으면 조용히 다음 공급자로 넘어가지 않고
// formatValid=false로 그 사실을 알린다 — 네트워크 호출 전에 걸러내기 위함이다.
function selectWalletProvider(env) {
  if (env.COINOS_TOKEN) {
    const fmt = validateCoinosTokenFormat(env.COINOS_TOKEN);
    return { provider: 'coinos', token: env.COINOS_TOKEN, formatValid: fmt.valid, formatReason: fmt.reason };
  }
  if (env.BLINK_API_KEY) {
    const fmt = validateBlinkKeyFormat(env.BLINK_API_KEY);
    return { provider: 'blink', token: env.BLINK_API_KEY, formatValid: fmt.valid, formatReason: fmt.reason };
  }
  if (env.LNBITS_URL && env.LNBITS_READ_KEY) {
    return { provider: 'lnbits', url: env.LNBITS_URL, key: env.LNBITS_READ_KEY, formatValid: true };
  }
  return null;
}

function logFileName(date = new Date()) {
  const kst = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
  return `${kst}.md`;
}

module.exports = {
  pickNextTask,
  evaluateGoal,
  parseLnbitsWallet,
  parseBlinkWallets,
  validateBlinkKeyFormat,
  parseCoinosWallet,
  validateCoinosTokenFormat,
  selectWalletProvider,
  logFileName,
};
