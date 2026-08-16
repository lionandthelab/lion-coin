'use strict';

// 돌파 + 조건 주문(브래킷) 전용 백테스트 — 순수 함수.
//
// 기존 백테스트 엔진(backtest.js)은 목표 노출 배열을 받는 구조라 "익절선/손절선에
// 닿으면 청산"을 표현할 수 없다. 브래킷은 봉 **안에서** 청산되므로 별도 시뮬레이터가 필요하다.
//
// 가장 중요한 판정: **같은 봉에서 익절선과 손절선이 모두 닿았을 때.**
// 봉 데이터(시고저종)만으로는 어느 쪽이 먼저인지 알 수 없다. 익절을 먼저라고
// 가정하면 성과가 조직적으로 부풀려지므로 **손절 우선**으로 잡는다.
// 실전에서 그 봉이 실제로 어떻게 흘렀는지는 알 수 없고, 보수적인 쪽이 덜 틀린다.

function simulateBracket(candles, { entryIndex, tpBps, slBps, costBps = 0, maxHoldBars = 24 } = {}) {
  if (!Array.isArray(candles) || entryIndex == null || entryIndex >= candles.length) return null;

  const entry = candles[entryIndex].open;
  if (!(entry > 0)) return null;

  const tp = entry * (1 + tpBps / 10000);
  const sl = entry * (1 - slBps / 10000);
  const lastAllowed = Math.min(candles.length - 1, entryIndex + maxHoldBars - 1);

  for (let i = entryIndex; i <= lastAllowed; i += 1) {
    const c = candles[i];
    const hitSl = c.low <= sl;
    const hitTp = c.high >= tp;

    // 손절 우선. 둘 다 닿은 봉에서 익절을 택하면 백테스트만 좋아진다.
    if (hitSl) {
      return { outcome: 'sl', exitIndex: i, exitPrice: sl, returnBps: -slBps - costBps };
    }
    if (hitTp) {
      return { outcome: 'tp', exitIndex: i, exitPrice: tp, returnBps: tpBps - costBps };
    }
  }

  // 청산 조건에 닿지 않은 채 보유 한도나 데이터 끝에 도달한 경우
  const exitIndex = lastAllowed;
  const exitPrice = candles[exitIndex].close;
  const raw = (exitPrice / entry - 1) * 10000;
  const reachedLimit = exitIndex === entryIndex + maxHoldBars - 1;

  return {
    outcome: reachedLimit ? 'timeout' : 'eod',
    exitIndex,
    exitPrice,
    returnBps: raw - costBps,
  };
}

function summarizeTrades(trades) {
  if (!Array.isArray(trades) || trades.length === 0) {
    return { count: 0, wins: 0, winRate: null, expectancyBps: null, totalBps: 0, byOutcome: {} };
  }

  const byOutcome = {};
  let total = 0;
  let wins = 0;
  for (const t of trades) {
    byOutcome[t.outcome] = (byOutcome[t.outcome] || 0) + 1;
    total += t.returnBps;
    if (t.returnBps > 0) wins += 1;
  }

  return {
    count: trades.length,
    wins,
    winRate: wins / trades.length,
    expectancyBps: total / trades.length,
    totalBps: total,
    byOutcome,
  };
}

module.exports = { simulateBracket, summarizeTrades };
