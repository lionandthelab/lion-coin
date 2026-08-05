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
  logFileName,
};
