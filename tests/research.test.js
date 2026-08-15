const { test } = require('node:test');
const assert = require('node:assert/strict');

const { grid, buildFolds, scoreSummary, aggregate } = require('../src/research');

// ---- grid ----

test('grid: 파라미터 사양을 데카르트 곱으로 펼친다', () => {
  const out = grid({ a: [1, 2], b: ['x', 'y'] });
  assert.equal(out.length, 4);
  assert.deepEqual(out[0], { a: 1, b: 'x' });
});

test('grid: 빈 사양은 조합 1개(빈 객체)', () => {
  assert.deepEqual(grid({}), [{}]);
});

test('grid: 값이 빈 배열인 키가 있으면 조합이 0개', () => {
  assert.deepEqual(grid({ a: [1], b: [] }), []);
});

// ---- buildFolds ----

test('buildFolds: 학습은 누적하고 검증만 앞으로 민다 (앵커드)', () => {
  const folds = buildFolds(1000, { foldCount: 3, firstTrainRatio: 0.4, minTestSize: 10 });
  assert.equal(folds.length, 3);
  assert.deepEqual(folds[0], { trainEnd: 400, testEnd: 600 });
  assert.deepEqual(folds[1], { trainEnd: 600, testEnd: 800 });
  assert.deepEqual(folds[2], { trainEnd: 800, testEnd: 1000 });
});

test('buildFolds: 검증 구간이 최소 크기에 못 미치면 그 폴드는 버린다', () => {
  const folds = buildFolds(100, { foldCount: 6, firstTrainRatio: 0.4, minTestSize: 50 });
  assert.equal(folds.length, 0);
});

test('buildFolds: 마지막 폴드가 전체 길이를 넘지 않는다', () => {
  const folds = buildFolds(997, { foldCount: 3, firstTrainRatio: 0.4, minTestSize: 10 });
  assert.ok(folds[folds.length - 1].testEnd <= 997);
});

// ---- scoreSummary ----
// 수익률만 보고 고르면 낙폭이 큰 극단값이 뽑히고, 표본이 적으면 우연이 실력처럼 보인다.

test('scoreSummary: 최소 트레이드 수 미달은 후보에서 제외한다', () => {
  const s = { tradeCount: 3, totalReturnPct: 500, maxDrawdownPct: 1 };
  assert.equal(scoreSummary(s, { minTrades: 20 }), -Infinity);
});

test('scoreSummary: 마이너스 수익은 수익률 자체를 점수로 쓴다', () => {
  const s = { tradeCount: 50, totalReturnPct: -10, maxDrawdownPct: 20 };
  assert.equal(scoreSummary(s, { minTrades: 20 }), -10);
});

test('scoreSummary: 플러스 수익은 낙폭 대비로 평가한다', () => {
  const wide = { tradeCount: 50, totalReturnPct: 100, maxDrawdownPct: 50 };
  const tight = { tradeCount: 50, totalReturnPct: 100, maxDrawdownPct: 10 };
  assert.ok(scoreSummary(tight, { minTrades: 20 }) > scoreSummary(wide, { minTrades: 20 }));
});

test('scoreSummary: 낙폭이 0에 가까워도 점수가 폭주하지 않는다', () => {
  const s = { tradeCount: 50, totalReturnPct: 10, maxDrawdownPct: 0 };
  assert.ok(Number.isFinite(scoreSummary(s, { minTrades: 20 })));
});

// ---- aggregate ----

test('aggregate: 검증 평균·플러스 폴드 수·평균 괴리를 낸다', () => {
  const rows = [
    { train: { totalReturnPct: 100 }, test: { totalReturnPct: 10 }, bh: { totalReturnPct: 5 } },
    { train: { totalReturnPct: 50 }, test: { totalReturnPct: -4 }, bh: { totalReturnPct: -10 } },
  ];
  const a = aggregate(rows);
  assert.equal(a.meanTestPct, 3);
  assert.equal(a.positiveFolds, 1);
  assert.equal(a.beatsBhFolds, 2);
  assert.equal(a.totalFolds, 2);
  assert.equal(a.meanGapPct, 72); // (90 + 54) / 2
});

test('aggregate: 빈 입력은 null 지표를 돌려준다 (0으로 위장하지 않는다)', () => {
  const a = aggregate([]);
  assert.equal(a.meanTestPct, null);
  assert.equal(a.totalFolds, 0);
});

// ---- 게이트 판정 ----

test('aggregate: 게이트는 검증 평균 플러스 + 과반 폴드 플러스를 모두 요구한다', () => {
  const pass = aggregate([
    { train: { totalReturnPct: 0 }, test: { totalReturnPct: 10 }, bh: { totalReturnPct: 0 } },
    { train: { totalReturnPct: 0 }, test: { totalReturnPct: 5 }, bh: { totalReturnPct: 0 } },
    { train: { totalReturnPct: 0 }, test: { totalReturnPct: -1 }, bh: { totalReturnPct: 0 } },
  ]);
  assert.equal(pass.passesGate, true);

  // 평균은 플러스지만 과반 폴드가 마이너스 — 한 번의 대박에 기댄 경우
  const lucky = aggregate([
    { train: { totalReturnPct: 0 }, test: { totalReturnPct: 100 }, bh: { totalReturnPct: 0 } },
    { train: { totalReturnPct: 0 }, test: { totalReturnPct: -5 }, bh: { totalReturnPct: 0 } },
    { train: { totalReturnPct: 0 }, test: { totalReturnPct: -5 }, bh: { totalReturnPct: 0 } },
  ]);
  assert.equal(lucky.passesGate, false);
});
