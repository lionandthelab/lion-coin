'use strict';

// 데몬 상태의 저장·복원 — 순수 함수. 파일 입출력은 호출자가 한다.
//
// **왜 필요한가:** 데몬이 매번 `createEventState()`로 시작하면, 거래소에 포지션이
// 남은 채 새 재료로 또 진입한다. 크래시 루프가 돌면 감시받지 않는 포지션이 쌓인다.
// 실거래를 재시작 후에도 이어가려면 **상태 복원이 모드 복원보다 먼저**다.
//
// **복원의 원칙: 모르면 복원하지 않는다.**
// 손상되거나 오래된 스냅샷을 억지로 되살리면 어긋난 상태로 청산을 지시해 없는
// 수량을 팔거나 남은 수량을 놓친다. 못 읽으면 깨끗이 시작하되 **반드시 알린다** —
// 조용히 깨끗해지는 것이 이 시스템에서 가장 비싼 실패다.
//
// 이 모듈은 파일을 읽지도 쓰지도 않는다. 순수 함수로 두면 손상·구버전·시간 경과
// 같은 경계를 파일 없이 전부 시험할 수 있다.

// 상태의 필드 모양이 바뀌면 올린다. 판이 다른 스냅샷은 복원하지 않는다 —
// 필드 하나가 조용히 어긋난 상태로 매매하는 것보다 깨끗이 시작하는 편이 낫다.
const SNAPSHOT_VERSION = 1;

// 이보다 오래된 스냅샷으로는 포지션을 되살리지 않는다. 그 사이 거래소에서 무슨
// 일이 있었는지 알 수 없고, 모르는 채로 청산을 지시하는 것이 더 위험하다.
const MAX_SNAPSHOT_AGE_MS = 6 * 60 * 60 * 1000;

const DEFAULT_MAX_SEEN = 5000;
const MODES = new Set(['stopped', 'watching', 'live']);

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function buildSnapshot({
  state, mode, seenIds, postExits, trades = [], events = [], marketContextAt = null,
} = {}, { now = Date.now(), maxSeen = DEFAULT_MAX_SEEN } = {}) {
  // Set·Map은 JSON으로 그냥 나가면 `{}`가 된다 — 조용히 빈 값으로 복원된다.
  const ids = seenIds instanceof Set ? [...seenIds] : [];
  return {
    version: SNAPSHOT_VERSION,
    savedAt: now,
    mode: MODES.has(mode) ? mode : 'stopped',
    state: state || null,
    // 오래된 id부터 버린다. 나이 필터가 어차피 옛 공지를 거르므로 최근 것이 값지다.
    seenIds: ids.slice(Math.max(0, ids.length - maxSeen)),
    postExits: postExits instanceof Map ? [...postExits.entries()] : [],
    // 화면 복원용. 많이 들고 있을 이유가 없다.
    trades: Array.isArray(trades) ? trades.slice(0, 100) : [],
    events: Array.isArray(events) ? events.slice(0, 200) : [],
    marketContextAt: num(marketContextAt),
  };
}

// 포지션을 들고 있는 상태인가, 그리고 그 상태로 청산선을 그을 수 있는가.
function positionOf(state) {
  if (!state || typeof state !== 'object') return null;
  if (state.status !== 'HOLDING' && state.status !== 'EXITING') return null;
  const qty = num(state.quantity);
  const entry = num(state.entryPrice);
  if (qty === null || qty <= 0 || entry === null || entry <= 0) return { broken: true };
  const tickers = state.material && Array.isArray(state.material.tickers) ? state.material.tickers : [];
  return { symbol: tickers[0] || null, quantity: qty, entryPrice: entry, status: state.status };
}

function fail(warning) {
  return { ok: false, state: null, mode: null, seenIds: new Set(), postExits: new Map(), position: null, notice: null, warning };
}

function restoreSnapshot(snap, { now = Date.now(), maxAgeMs = MAX_SNAPSHOT_AGE_MS } = {}) {
  // 스냅샷이 아예 없는 것은 손상된 것과 다르다 — 첫 실행이므로 알릴 것이 없다.
  if (snap === null || snap === undefined) {
    return { ...fail(null) };
  }
  if (typeof snap !== 'object' || Array.isArray(snap)) {
    return fail('저장된 상태를 읽지 못했습니다(형식이 객체가 아님) — 깨끗한 상태로 시작합니다.');
  }
  if (snap.version !== SNAPSHOT_VERSION) {
    return fail(`저장된 상태의 형식 판이 다릅니다(${snap.version} ≠ ${SNAPSHOT_VERSION}) — 깨끗한 상태로 시작합니다.`);
  }
  if (!snap.state || typeof snap.state !== 'object' || typeof snap.state.status !== 'string') {
    return fail('저장된 상태에 상태기계 값이 없습니다 — 깨끗한 상태로 시작합니다.');
  }

  const pos = positionOf(snap.state);
  if (pos && pos.broken) {
    // 이 상태로는 청산선을 그을 수 없다. 되살리면 어떤 가격에서도 청산이 발동하지 않는다.
    return fail('저장된 포지션에 수량이나 진입가가 없어 복원하지 않습니다 — 거래소에서 직접 확인하세요.');
  }

  const savedAt = num(snap.savedAt);
  if (pos && (savedAt === null || now - savedAt > maxAgeMs)) {
    const hours = savedAt === null ? '알 수 없음' : `${Math.floor((now - savedAt) / 3600_000)}시간`;
    return fail(
      `저장된 포지션이 너무 오래됐습니다(경과 ${hours}) — 그 사이 거래소에서 무슨 일이 있었는지 `
      + `알 수 없어 복원하지 않습니다. 직접 확인하세요: ${pos.symbol || '종목 미상'} 수량 ${pos.quantity}`
    );
  }

  const seenIds = new Set(Array.isArray(snap.seenIds) ? snap.seenIds.filter((s) => typeof s === 'string') : []);
  const postExits = new Map(Array.isArray(snap.postExits)
    ? snap.postExits.filter((e) => Array.isArray(e) && e.length === 2 && typeof e[0] === 'string')
    : []);

  return {
    ok: true,
    state: snap.state,
    mode: MODES.has(snap.mode) ? snap.mode : 'stopped',
    seenIds,
    postExits,
    trades: Array.isArray(snap.trades) ? snap.trades : [],
    events: Array.isArray(snap.events) ? snap.events : [],
    marketContextAt: num(snap.marketContextAt),
    savedAt,
    position: pos,
    notice: pos
      ? `이전 포지션을 이어받았습니다 — ${pos.symbol || '종목 미상'} 수량 ${pos.quantity} · `
        + `진입가 ${pos.entryPrice.toLocaleString('ko-KR')}원 (${pos.status})\n`
        + '익절·손절·시간초과 감시가 이어집니다. 거래소의 실제 잔고와 다르면 직접 맞추세요.'
      : null,
    warning: null,
  };
}

// 재시작 후 어느 모드로 돌아갈 것인가.
//
// **저장된 값이 .env의 승인을 이기지 않는다.** BITHUMB_LIVE를 내린 것은 명시적인
// 의사표시이고, 저장된 'live'가 그걸 이긴다면 그 스위치는 아무 의미가 없다.
// 다만 승인이 그대로 살아 있다면, 재시작이 사람이 이미 켠 것을 꺼버리지도 않는다.
function resolveStartupMode({ saved, liveApproved = false, hasKeys = false } = {}) {
  if (!MODES.has(saved)) return { mode: 'stopped', notice: null, warning: null };
  if (saved !== 'live') return { mode: saved, notice: null, warning: null };

  if (!liveApproved) {
    return {
      mode: 'watching',
      notice: null,
      warning: '실거래 모드였으나 승인이 꺼져 있어 감시 모드로 시작합니다 (.env의 BITHUMB_LIVE=1 필요).',
    };
  }
  if (!hasKeys) {
    return {
      mode: 'watching',
      notice: null,
      warning: '실거래 모드였으나 빗썸 API 키가 없어 감시 모드로 시작합니다.',
    };
  }
  return {
    mode: 'live',
    notice: '🔴 실거래 모드로 자동 재개했습니다 — 재시작 전 상태를 그대로 이어갑니다.',
    warning: null,
  };
}

module.exports = {
  SNAPSHOT_VERSION,
  MAX_SNAPSHOT_AGE_MS,
  buildSnapshot,
  restoreSnapshot,
  resolveStartupMode,
};
