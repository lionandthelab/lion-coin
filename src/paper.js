'use strict';

// 페이퍼 트레이딩 아레나 — 순수 함수. 파일 I/O·네트워크는 scripts/paper-tick.js 책임.
//
// 지금은 실거래 게이트를 통과한 전략이 없다. 그래서 하나를 골라 굴리는 대신,
// **후보 여러 개를 같은 캔들 위에서 동시에** 굴리고 매수보유를 기준선으로 함께
// 기록한다. 나중에 쓸 만한 전략이 나왔을 때 비교할 대조군이 그때 가서는 만들어지지
// 않기 때문이다 — 트랙레코드는 소급해서 쌓을 수 없다.
//
// 매 틱마다 전체 이력을 다시 계산한다. 증분으로 상태를 이어가면 재실행·중단에서
// 값이 어긋나는데, 다시 계산하면 항상 같은 입력에 같은 결과가 나온다.

const { runBacktest, summarize } = require('./backtest');
const { STRATEGIES } = require('./strategies');

// 전략 이름 자리에 이 값을 두면 기준선(전 구간 보유)으로 취급한다.
const BUY_AND_HOLD = null;
const DEFAULT_MAX_HISTORY = 400;

function positionsFor(candidate, candles) {
  if (candidate.strategy === BUY_AND_HOLD) {
    return candles.map(() => 1);
  }
  const fn = STRATEGIES[candidate.strategy];
  if (!fn) {
    throw new Error(
      `알 수 없는 전략입니다: ${candidate.strategy} (가능: ${Object.keys(STRATEGIES).join(', ')})`
    );
  }
  return fn(candles, candidate.params || {});
}

// equityFromIndex: 신호는 전체 이력으로 내고, 자산곡선은 이 인덱스부터만 잰다.
// 페이퍼 시작 시점 이전 캔들은 지표 워밍업 용도로만 쓴다 — 이게 없으면
// 200-EMA 전략이 페이퍼 시작 후 200봉 동안 강제로 현금 상태가 된다.
function evaluateCandidates(candidates, candles, costs, { equityFromIndex = 0 } = {}) {
  if (!Array.isArray(candidates) || !Array.isArray(candles) || candles.length === 0) {
    throw new TypeError('candidates와 candles는 비어 있지 않은 배열이어야 합니다');
  }
  if (!Number.isInteger(equityFromIndex) || equityFromIndex < 0 || equityFromIndex >= candles.length) {
    throw new RangeError(
      `equityFromIndex는 0 이상 ${candles.length} 미만의 정수여야 합니다: ${equityFromIndex}`
    );
  }

  const seen = new Set();
  return candidates.map((candidate) => {
    if (seen.has(candidate.id)) {
      throw new Error(`후보 id가 중복됐습니다: ${candidate.id}`);
    }
    seen.add(candidate.id);

    const targetPositions = positionsFor(candidate, candles);
    const result = runBacktest({
      candles: candles.slice(equityFromIndex),
      targetPositions: targetPositions.slice(equityFromIndex),
      ...costs,
    });

    return {
      id: candidate.id,
      strategy: candidate.strategy,
      params: candidate.params || {},
      // 마지막 봉의 목표 포지션 — 실제 체결은 다음 봉 시가에 일어난다.
      position: targetPositions[targetPositions.length - 1],
      equity: result.finalEquity,
      summary: summarize(result),
    };
  });
}

// 하네스가 하루 두 번 돌거나 같은 회차를 재실행해도 이력이 중복되면 안 된다.
// 같은 봉이면 덮어쓰고, 과거 봉이면 무시한다.
function mergeHistory(history, entry, maxLen = DEFAULT_MAX_HISTORY) {
  if (!Array.isArray(history)) {
    throw new TypeError('history는 배열이어야 합니다');
  }

  const last = history[history.length - 1];
  let next;

  if (!last || entry.candleOpenTime > last.candleOpenTime) {
    next = [...history, entry];
  } else if (entry.candleOpenTime === last.candleOpenTime) {
    next = [...history.slice(0, -1), entry];
  } else {
    return history; // 시계 역행 — 오래된 값으로 최신을 덮지 않는다
  }

  return next.length > maxLen ? next.slice(next.length - maxLen) : next;
}

const median = (xs) => {
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
};

// 후보별로 심볼을 가로질러 집계한다.
//
// 단일 심볼 성과가 일반화되지 않는다는 것이 워크포워드 연구의 결론이었다
// (docs/walkforward-evaluation.md). 전방 검증도 같은 규율을 따라야 하므로,
// 평균만이 아니라 **최악 심볼**과 **플러스 심볼 수**를 함께 본다 — 평균은
// 한 심볼의 대박이 나머지를 가릴 수 있다.
function summarizeArena(state) {
  const symbols = state.symbols || [];

  return (state.candidates || []).map((candidate) => {
    const rows = [];
    for (const symbol of symbols) {
      const history = state.series?.[symbol]?.history || [];
      const latest = history[history.length - 1];
      const row = latest?.rows?.find((r) => r.id === candidate.id);
      if (row) rows.push({ symbol, ...row });
    }

    if (rows.length === 0) {
      return {
        id: candidate.id,
        strategy: candidate.strategy,
        symbolCount: 0,
        meanReturnPct: null,
        medianReturnPct: null,
        worstReturnPct: null,
        maxDrawdownPct: null,
        positiveSymbols: 0,
        positions: [],
      };
    }

    const returns = rows.map((r) => r.totalReturnPct);
    return {
      id: candidate.id,
      strategy: candidate.strategy,
      symbolCount: rows.length,
      meanReturnPct: returns.reduce((a, b) => a + b, 0) / returns.length,
      medianReturnPct: median(returns),
      worstReturnPct: Math.min(...returns),
      // 최악 낙폭을 대표값으로 쓴다 — 평균 낙폭은 계좌가 실제로 견뎌야 할 값이 아니다.
      maxDrawdownPct: Math.max(...rows.map((r) => r.maxDrawdownPct)),
      positiveSymbols: returns.filter((v) => v > 0).length,
      positions: rows.map((r) => ({ symbol: r.symbol, position: r.position })),
    };
  });
}

module.exports = {
  BUY_AND_HOLD,
  DEFAULT_MAX_HISTORY,
  evaluateCandidates,
  mergeHistory,
  summarizeArena,
};
