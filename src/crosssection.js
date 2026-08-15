'use strict';

// 횡단면(cross-sectional) 전략 — 여러 심볼을 매 시점 순위 매겨 상위를 사고 하위를 판다.
//
// 지금까지의 전략은 전부 **시계열**이었다: 한 심볼의 과거를 보고 그 심볼을 살지 말지 정한다.
// 횡단면은 질문이 다르다 — "지금 이 중 무엇이 가장 나은가". 자산군을 가리지 않고
// 가장 오래 살아남은 이례현상 중 하나이며, 시계열 전략이 전부 실패한 것과 독립적인 가설이다.
//
// 이 모듈은 순수 함수만 둔다. 데이터 수집은 호출부 책임.

const BPS = 10000;

// 심볼마다 상장 시점이 다르고 중간에 봉이 빠지기도 한다. 시각을 맞추지 않고
// 인덱스로 짝지으면 서로 다른 시점의 가격을 비교하게 되어 순위가 통째로 무의미해진다.
function alignSeries(bySymbol) {
  const symbols = Object.keys(bySymbol).sort();
  if (symbols.length < 2) {
    throw new Error('횡단면 비교에는 심볼이 최소 2개 필요합니다');
  }

  const maps = symbols.map((s) => new Map(bySymbol[s].map((c) => [c.openTime, c])));
  const times = [...maps[0].keys()]
    .filter((t) => maps.every((m) => m.has(t)))
    .sort((a, b) => a - b);

  if (times.length === 0) {
    throw new Error('심볼들 사이에 공통 시각이 없습니다');
  }

  const candles = {};
  symbols.forEach((s, i) => {
    candles[s] = times.map((t) => maps[i].get(t));
  });

  return { times, symbols, candles };
}

function assertPositiveInt(value, name) {
  if (!Number.isInteger(value) || value < 1) {
    throw new RangeError(`${name}은(는) 양의 정수여야 합니다: ${value}`);
  }
}

// 룩백 수익률로 순위를 매겨 상위 topK를 롱, 하위 bottomK를 숏으로 잡는다.
// 총 노출(|비중| 합)은 1로 정규화한다 — 레버리지는 들이지 않는다.
function rankRotation(aligned, { lookback = 24, topK = 1, bottomK = 0, rebalanceEvery = 1 } = {}) {
  assertPositiveInt(lookback, 'lookback');
  assertPositiveInt(topK, 'topK');
  assertPositiveInt(rebalanceEvery, 'rebalanceEvery');
  if (!Number.isInteger(bottomK) || bottomK < 0) {
    throw new RangeError(`bottomK는 0 이상의 정수여야 합니다: ${bottomK}`);
  }
  const n = aligned.symbols.length;
  if (topK + bottomK > n) {
    throw new RangeError(`topK+bottomK(${topK + bottomK})가 심볼 수(${n})보다 많습니다`);
  }

  const slots = topK + bottomK;
  const weight = 1 / slots;

  // 순위를 매기는 주기와 갈아타는 주기를 분리한다. 매 봉 재조정하면 상위 종목이
  // 계속 바뀌어 회전율이 폭발하고, 그 비용이 순위의 가치를 통째로 삼킨다.
  let held = {};

  return aligned.times.map((_, i) => {
    if (i < lookback) return {};
    if ((i - lookback) % rebalanceEvery !== 0) return held;

    const scored = aligned.symbols
      .map((s) => {
        const now = aligned.candles[s][i].close;
        const past = aligned.candles[s][i - lookback].close;
        return { s, r: past > 0 ? now / past - 1 : 0 };
      })
      .sort((a, b) => b.r - a.r);

    const w = {};
    for (let k = 0; k < topK; k += 1) w[scored[k].s] = weight;
    for (let k = 0; k < bottomK; k += 1) w[scored[n - 1 - k].s] = -weight;
    held = w;
    return w;
  });
}

// 다심볼 자본 공유 백테스트.
//
// 단일 자산 엔진과 같은 규약을 지킨다: i번 봉 종가까지의 정보로 낸 가중치는
// i+1번 봉 시가에 체결되고, 목표가 바뀔 때만 차액만 거래한다.
function runPortfolioBacktest({
  aligned,
  weights,
  feeBps = 10,
  slippageBps = 5,
  initialEquity = 1000,
} = {}) {
  if (!aligned || !Array.isArray(weights) || weights.length !== aligned.times.length) {
    throw new TypeError(
      `weights 길이(${weights?.length})가 시각 수(${aligned?.times?.length})와 다릅니다`
    );
  }
  weights.forEach((w, i) => {
    const gross = Object.values(w || {}).reduce((s, x) => s + Math.abs(x), 0);
    if (gross > 1 + 1e-9) {
      throw new RangeError(`weights[${i}]의 총 노출(${gross.toFixed(3)})이 1을 넘습니다`);
    }
  });

  const feeRate = feeBps / BPS;
  const slipRate = slippageBps / BPS;
  const { symbols, candles, times } = aligned;

  let cash = initialEquity;
  const units = Object.fromEntries(symbols.map((s) => [s, 0]));
  let current = {}; // 마지막으로 체결한 목표 비중
  const equity = [];
  let rebalances = 0;
  let tradedNotionalTotal = 0;

  const sameWeights = (a, b) => {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of keys) {
      if (Math.abs((a[k] || 0) - (b[k] || 0)) > 1e-12) return false;
    }
    return true;
  };

  for (let i = 0; i < times.length; i += 1) {
    if (i > 0) {
      const desired = weights[i - 1] || {};
      if (!sameWeights(desired, current)) {
        // 전체 자산을 시가로 평가한 뒤 목표 명목을 계산한다.
        let equityAtOpen = cash;
        for (const s of symbols) equityAtOpen += units[s] * candles[s][i].open;

        for (const s of symbols) {
          const price = candles[s][i].open;
          const target = desired[s] || 0;
          const provisional = (target * equityAtOpen) / price;
          const dir = Math.sign(provisional - units[s]);
          if (dir === 0) continue;

          const fill = price * (1 + dir * slipRate);
          const targetUnits = (target * equityAtOpen) / fill;
          const delta = targetUnits - units[s];
          const notional = Math.abs(delta) * fill;

          cash -= delta * fill + notional * feeRate;
          units[s] = targetUnits;
          tradedNotionalTotal += notional;
        }
        current = { ...desired };
        rebalances += 1;
      }
    }

    let value = cash;
    for (const s of symbols) value += units[s] * candles[s][i].close;
    equity.push(value);
  }

  return {
    equity,
    initialEquity,
    finalEquity: equity[equity.length - 1],
    rebalances,
    // 회전율은 횡단면 전략의 주된 비용 동인이다 — 종목을 갈아탈 때마다 양쪽에 수수료가 붙는다.
    turnoverRatio: tradedNotionalTotal / initialEquity,
  };
}

module.exports = { alignSeries, rankRotation, runPortfolioBacktest };
