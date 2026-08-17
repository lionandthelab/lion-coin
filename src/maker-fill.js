'use strict';

// 지정가 체결 실측 — 순수 함수.
//
// **이 전략의 남은 최대 미지수다.** 순기대값 +11.7bps는 왕복 비용 8bps(지정가 양방향)를
// 전제한다. 메이커 체결에 실패해 시장가로 밀리면 비용이 15bps가 되어 +4.7bps로 줄어든다.
//
// 그런데 진입 시점이 하필 급락 직후다 — 호가가 가장 벌어져 있고 매도 압력이 몰린 순간이라
// 매수호가에 걸어두면 체결될 가능성이 오히려 높지만, 그 사이 값이 더 빠질 수도 있다.
// 어느 쪽인지는 재봐야 안다.
//
// **실주문 없이 잰다.** 신호 순간의 매수호가를 기록해 두고, 이후 봉의 저가가 그 값에
// 닿았는지 보면 지정가가 체결됐을지 알 수 있다. 공개 캔들만으로 되므로 페이퍼 모드에서
// 자본을 넣지 않고도 표본을 쌓을 수 있다.
//
// 보수적으로 잡은 두 가지:
//   - 저가가 지정가보다 더 내려가도 **지정가에 체결된 것으로 본다.** 실제로는 더 유리하게
//     체결될 수 있지만, 유리한 쪽으로 가정하면 실측의 의미가 없다.
//   - 대기 봉을 넘기면 만료로 확정한다. 나중에 값이 내려와 닿아도 체결로 세지 않는다 —
//     실전에서는 그때 이미 주문을 물렸을 것이기 때문이다.

function openPending({ symbol, at, bid, ask, expireBars = 4 } = {}) {
  if (!(bid > 0) || !(ask > 0)) {
    throw new TypeError(`호가는 양수여야 합니다: bid=${bid} ask=${ask}`);
  }
  if (ask < bid) {
    throw new RangeError(`호가가 뒤집혔습니다 (ask ${ask} < bid ${bid}) — 데이터를 확인하세요`);
  }
  if (!Number.isInteger(expireBars) || expireBars < 1) {
    throw new RangeError(`expireBars는 양의 정수여야 합니다: ${expireBars}`);
  }

  return {
    symbol,
    at,
    // 매수호가에 건다 — 스프레드를 내지 않는 쪽이다.
    limitPrice: bid,
    spreadBps: ((ask - bid) / ((ask + bid) / 2)) * 10000,
    expireBars,
    filled: false,
    expired: false,
    barsWaited: 0,
    fillPrice: null,
  };
}

// 봉 하나를 보고 상태를 갱신한다. 이미 판정이 끝난 건은 그대로 돌려준다 —
// 체결 상태가 나중에 뒤집히면 통계가 오염된다.
function checkFill(pending, candle) {
  if (!pending || pending.filled || pending.expired) return pending;
  if (!candle || !(candle.low > 0)) return pending;

  const barsWaited = pending.barsWaited + 1;

  if (candle.low <= pending.limitPrice) {
    return { ...pending, filled: true, barsWaited, fillPrice: pending.limitPrice };
  }

  return { ...pending, barsWaited, expired: barsWaited >= pending.expireBars };
}

function summarizeFills(pendings) {
  const done = (Array.isArray(pendings) ? pendings : []).filter((p) => p && (p.filled || p.expired));

  if (done.length === 0) {
    return { total: 0, filled: 0, fillRate: null, avgBarsToFill: null };
  }

  const filled = done.filter((p) => p.filled);
  return {
    total: done.length,
    filled: filled.length,
    fillRate: filled.length / done.length,
    // 체결된 건만 평균낸다 — 미체결의 대기 봉을 섞으면 의미가 흐려진다.
    avgBarsToFill: filled.length
      ? filled.reduce((s, p) => s + p.barsWaited, 0) / filled.length
      : null,
  };
}

module.exports = { openPending, checkFill, summarizeFills };
