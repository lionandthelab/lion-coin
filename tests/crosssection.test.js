const { test } = require('node:test');
const assert = require('node:assert/strict');

const { alignSeries, rankRotation, runPortfolioBacktest } = require('../src/crosssection');
const { runBacktest } = require('../src/backtest');

const near = (a, b, msg) =>
  assert.ok(Math.abs(a - b) < 1e-9, `${msg ?? ''} — got ${a}, want ${b}`);

const HOUR = 3600000;

function candles(closes, startTime = 0) {
  return closes.map((close, i) => ({
    openTime: startTime + i * HOUR,
    open: close,
    high: close,
    low: close,
    close,
    volume: 1,
    closeTime: startTime + i * HOUR + HOUR - 1,
  }));
}

// ---- alignSeries ----
// 심볼마다 상장 시점이 달라 캔들 길이가 제각각이다. 시각을 맞추지 않고 인덱스로
// 짝지으면 서로 다른 시점의 가격을 비교하게 된다 — 순위가 통째로 무의미해진다.

test('alignSeries: 공통 시각만 남기고 심볼별 길이를 맞춘다', () => {
  const a = alignSeries({
    A: candles([1, 2, 3, 4], 0),
    B: candles([10, 20, 30], HOUR), // 1시간 늦게 상장
  });
  assert.deepEqual(a.times, [HOUR, 2 * HOUR, 3 * HOUR]);
  assert.deepEqual(a.symbols, ['A', 'B']);
  assert.deepEqual(a.candles.A.map((c) => c.close), [2, 3, 4]);
  assert.deepEqual(a.candles.B.map((c) => c.close), [10, 20, 30]);
});

test('alignSeries: 중간에 빠진 봉이 있으면 그 시각은 통째로 제외한다', () => {
  const b = candles([10, 20, 30], 0);
  b.splice(1, 1); // 두 번째 봉 유실
  const a = alignSeries({ A: candles([1, 2, 3], 0), B: b });
  assert.deepEqual(a.times, [0, 2 * HOUR]);
  assert.equal(a.candles.A.length, 2);
});

test('alignSeries: 겹치는 시각이 없으면 Error', () => {
  assert.throws(
    () => alignSeries({ A: candles([1, 2], 0), B: candles([1, 2], 100 * HOUR) }),
    /공통/
  );
});

test('alignSeries: 심볼이 2개 미만이면 Error (횡단면은 비교 대상이 필요하다)', () => {
  assert.throws(() => alignSeries({ A: candles([1, 2, 3]) }), /2개/);
});

// ---- rankRotation ----

test('rankRotation: 룩백 수익률 상위 topK만 롱으로 잡는다', () => {
  const aligned = alignSeries({
    A: candles([100, 110, 120]), // +20%
    B: candles([100, 100, 100]), // 0%
    C: candles([100, 95, 90]), //  -10%
  });
  const w = rankRotation(aligned, { lookback: 2, topK: 1 });
  assert.deepEqual(w[2], { A: 1 });
});

test('rankRotation: bottomK를 주면 하위 종목을 숏으로 잡는다', () => {
  const aligned = alignSeries({
    A: candles([100, 110, 120]),
    B: candles([100, 100, 100]),
    C: candles([100, 95, 90]),
  });
  const w = rankRotation(aligned, { lookback: 2, topK: 1, bottomK: 1 });
  near(w[2].A, 0.5, '롱 비중');
  near(w[2].C, -0.5, '숏 비중');
});

test('rankRotation: 총 노출은 1을 넘지 않는다 (레버리지 금지)', () => {
  const aligned = alignSeries({
    A: candles([100, 110, 120]),
    B: candles([100, 105, 115]),
    C: candles([100, 95, 90]),
    D: candles([100, 90, 80]),
  });
  const w = rankRotation(aligned, { lookback: 2, topK: 2, bottomK: 2 });
  const gross = Object.values(w[2]).reduce((s, x) => s + Math.abs(x), 0);
  near(gross, 1);
});

test('rankRotation: 워밍업 구간은 빈 가중치', () => {
  const aligned = alignSeries({ A: candles([1, 2, 3]), B: candles([3, 2, 1]) });
  const w = rankRotation(aligned, { lookback: 2, topK: 1 });
  assert.deepEqual(w[0], {});
  assert.deepEqual(w[1], {});
});

test('rankRotation: topK가 심볼 수보다 크면 RangeError', () => {
  const aligned = alignSeries({ A: candles([1, 2, 3]), B: candles([3, 2, 1]) });
  assert.throws(() => rankRotation(aligned, { lookback: 2, topK: 5 }), RangeError);
  assert.throws(() => rankRotation(aligned, { lookback: 2, topK: 1, bottomK: 2 }), RangeError);
});

// ---- runPortfolioBacktest ----

test('runPortfolioBacktest: 한 심볼에 100%면 단일 자산 엔진과 같은 결과', () => {
  const prices = [100, 110, 120, 100];
  const c = prices.map((p, i) => ({
    openTime: i * HOUR, open: p, high: p, low: p, close: p, volume: 1, closeTime: i * HOUR + HOUR - 1,
  }));
  const aligned = alignSeries({ A: c, B: c });

  // 단일 자산의 targetPositions와 같은 시점에 같은 결정을 내려야 비교가 성립한다.
  const weights = [{ A: 1 }, { A: 1 }, { A: 1 }, { A: 1 }];
  const port = runPortfolioBacktest({ aligned, weights, feeBps: 0, slippageBps: 0, initialEquity: 1000 });
  const single = runBacktest({
    candles: c, targetPositions: [1, 1, 1, 1], feeBps: 0, slippageBps: 0, initialEquity: 1000,
  });
  assert.deepEqual(port.equity, single.equity);
});

test('runPortfolioBacktest: 두 심볼 50/50이면 각 가격 변화의 평균만큼 움직인다', () => {
  const up = candles([100, 100, 120]); // 시가 100 → 종가 120
  const flat = candles([100, 100, 100]);
  const aligned = alignSeries({ A: up, B: flat });
  const weights = [{ A: 0.5, B: 0.5 }, { A: 0.5, B: 0.5 }, { A: 0.5, B: 0.5 }];
  const r = runPortfolioBacktest({ aligned, weights, feeBps: 0, slippageBps: 0, initialEquity: 1000 });
  // A만 +20%, 비중 절반 → +10%
  near(r.equity[2], 1100);
});

test('runPortfolioBacktest: 목표 비중이 그대로면 재조정 거래가 없다', () => {
  const aligned = alignSeries({ A: candles([100, 100, 100]), B: candles([50, 50, 50]) });
  const weights = [{ A: 0.5, B: 0.5 }, { A: 0.5, B: 0.5 }, { A: 0.5, B: 0.5 }];
  const r = runPortfolioBacktest({ aligned, weights, feeBps: 100, slippageBps: 0, initialEquity: 1000 });
  // 진입 1회분 수수료(명목 1000 × 1%)만 나가야 한다
  near(r.equity[2], 990);
});

test('runPortfolioBacktest: 종목을 교체하면 판 만큼과 산 만큼에 수수료가 붙는다', () => {
  const aligned = alignSeries({ A: candles([100, 100, 100]), B: candles([100, 100, 100]) });
  const weights = [{ A: 1 }, { B: 1 }, { B: 1 }];
  const r = runPortfolioBacktest({ aligned, weights, feeBps: 100, slippageBps: 0, initialEquity: 1000 });
  // i=1: A 진입(수수료 10) · i=2: A 청산 + B 진입(각 약 10)
  assert.ok(r.equity[2] < 975, `교체 비용이 반영돼야 함: ${r.equity[2]}`);
  assert.ok(r.equity[2] > 965);
});

test('runPortfolioBacktest: 숏 비중은 가격이 내릴 때 이익이다', () => {
  const down = candles([100, 100, 80]);
  const flat = candles([100, 100, 100]);
  const aligned = alignSeries({ A: down, B: flat });
  const weights = [{ A: -1 }, { A: -1 }, { A: -1 }];
  const r = runPortfolioBacktest({ aligned, weights, feeBps: 0, slippageBps: 0, initialEquity: 1000 });
  near(r.equity[2], 1200);
});

test('runPortfolioBacktest: 가중치 길이가 시각 수와 다르면 TypeError', () => {
  const aligned = alignSeries({ A: candles([1, 2, 3]), B: candles([3, 2, 1]) });
  assert.throws(() => runPortfolioBacktest({ aligned, weights: [{}] }), TypeError);
});

test('runPortfolioBacktest: 총 노출이 1을 넘으면 RangeError (레버리지 금지)', () => {
  const aligned = alignSeries({ A: candles([1, 2, 3]), B: candles([3, 2, 1]) });
  assert.throws(
    () => runPortfolioBacktest({ aligned, weights: [{}, { A: 0.8, B: 0.8 }, {}] }),
    RangeError
  );
});
