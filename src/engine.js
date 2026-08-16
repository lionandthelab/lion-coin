'use strict';

// 매매 엔진 상태 기계 — 순수 로직. 네트워크·타이머는 scripts/trade-dashboard.js 책임.
//
// 모드는 셋뿐이고, 전이 규칙이 안전장치다:
//   stopped  → 아무것도 하지 않음 (기본값)
//   dry      → 신호를 잡고 주문을 **설계만** 한다. 거래소로 나가지 않음
//   live     → 실주문. 진입하려면 환경변수 승인 + 명시적 확인이 **둘 다** 필요
//
// live로 바로 갈 수 없게 만든 이유: 버튼 하나가 실수로 눌리는 것과
// 두 개의 서로 다른 관문을 통과하는 것은 사고 확률이 다르다.

const MODES = ['stopped', 'dry', 'live'];

function createEngineState() {
  return {
    mode: 'stopped',
    startedAt: null,
    lastScanAt: null,
    scans: 0,
    candidates: [],
    signals: [], // 설계된 주문 (dry에서는 여기까지만)
    orders: [], // 실제 전송된 주문 (live에서만 채워짐)
    errors: [],
  };
}

// 모드 전이. 허용되지 않는 전이는 사유와 함께 거부한다.
function transition(state, next, { liveApproved = false, confirmLive = false } = {}) {
  if (!MODES.includes(next)) {
    throw new RangeError(`알 수 없는 모드입니다: ${next} (가능: ${MODES.join(', ')})`);
  }

  if (next === 'live') {
    // 두 관문을 모두 통과해야 한다.
    if (!liveApproved) {
      return {
        ok: false,
        state,
        reason: '실거래가 승인되지 않았습니다 — .env에 BITHUMB_LIVE=1을 설정해야 합니다',
      };
    }
    if (!confirmLive) {
      return { ok: false, state, reason: '실거래 전환에는 명시적 확인이 필요합니다' };
    }
  }

  const startedAt =
    next === 'stopped' ? null : state.startedAt || new Date().toISOString();

  return { ok: true, state: { ...state, mode: next, startedAt }, reason: null };
}

// 한 번의 스캔 결과를 상태에 반영한다.
// 신호는 누적하되 상한을 둔다 — 대시보드가 무한히 커지면 브라우저가 멈춘다.
function applyScan(state, { candidates, signals = [], at = new Date().toISOString() }, maxSignals = 200) {
  const merged = [...state.signals, ...signals];
  return {
    ...state,
    lastScanAt: at,
    scans: state.scans + 1,
    candidates,
    signals: merged.length > maxSignals ? merged.slice(merged.length - maxSignals) : merged,
  };
}

function recordError(state, message, maxErrors = 50) {
  const errors = [...state.errors, { at: new Date().toISOString(), message }];
  return { ...state, errors: errors.length > maxErrors ? errors.slice(errors.length - maxErrors) : errors };
}

// 대시보드로 내보낼 요약. **비밀 값은 절대 포함하지 않는다.**
function summarize(state) {
  const executable = state.candidates.filter((c) => c.executable).length;
  return {
    mode: state.mode,
    startedAt: state.startedAt,
    lastScanAt: state.lastScanAt,
    scans: state.scans,
    scanned: state.candidates.length,
    executable,
    blocked: state.candidates.length - executable,
    signalCount: state.signals.length,
    orderCount: state.orders.length,
    errorCount: state.errors.length,
  };
}

module.exports = { MODES, createEngineState, transition, applyScan, recordError, summarize };
