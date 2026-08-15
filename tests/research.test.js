const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  grid,
  buildFolds,
  scoreSummary,
  aggregate,
  stitchSegments,
  curveMetrics,
  walkForwardEfficiency,
  evaluateWfGate,
} = require('../src/research');

const near = (actual, expected, msg) =>
  assert.ok(Math.abs(actual - expected) < 1e-6, `${msg ?? ''} — got ${actual}, want ${expected}`);

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
  assert.deepEqual(folds[0], { trainFrom: 0, trainEnd: 400, testEnd: 600 });
  assert.deepEqual(folds[1], { trainFrom: 0, trainEnd: 600, testEnd: 800 });
  assert.deepEqual(folds[2], { trainFrom: 0, trainEnd: 800, testEnd: 1000 });
});

// 앵커드는 오래된 장세를 계속 학습에 넣는다. 롤링은 최근 구간만 봐서
// 국면 변화에 빠르게 적응하는 대신 표본이 작아진다 — 둘 다 재본다.
test('buildFolds: rolling 모드는 학습창 길이를 고정하고 통째로 민다', () => {
  const folds = buildFolds(1000, {
    foldCount: 3,
    firstTrainRatio: 0.4,
    minTestSize: 10,
    mode: 'rolling',
  });
  assert.deepEqual(folds[0], { trainFrom: 0, trainEnd: 400, testEnd: 600 });
  assert.deepEqual(folds[1], { trainFrom: 200, trainEnd: 600, testEnd: 800 });
  assert.deepEqual(folds[2], { trainFrom: 400, trainEnd: 800, testEnd: 1000 });
});

test('buildFolds: 알 수 없는 모드는 RangeError', () => {
  assert.throws(() => buildFolds(1000, { mode: 'nope' }), RangeError);
});

test('buildFolds: 검증 구간이 최소 크기에 못 미치면 그 폴드는 버린다', () => {
  const folds = buildFolds(100, { foldCount: 6, firstTrainRatio: 0.4, minTestSize: 50 });
  assert.equal(folds.length, 0);
});

test('buildFolds: 마지막 폴드가 전체 길이를 넘지 않는다', () => {
  const folds = buildFolds(997, { foldCount: 3, firstTrainRatio: 0.4, minTestSize: 10 });
  assert.ok(folds[folds.length - 1].testEnd <= 997);
});

test('buildFolds: 폴드들의 검증 구간은 빈틈 없이 이어진다', () => {
  const folds = buildFolds(1000, { foldCount: 4, firstTrainRatio: 0.4, minTestSize: 10 });
  for (let i = 1; i < folds.length; i += 1) {
    assert.equal(folds[i].trainEnd, folds[i - 1].testEnd, `폴드 ${i} 경계 불연속`);
  }
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

// ---- stitchSegments ----
// 폴드별 수익률을 산술평균하면 복리가 반영되지 않고, 폴드 경계를 걸친 낙폭도
// 보이지 않는다. 각 폴드의 아웃오브샘플 구간을 하나의 연속 포지션 배열로
// 이어붙여야 실제로 그 전략을 계속 굴렸을 때의 곡선이 나온다.

test('stitchSegments: 각 구간의 해당 슬라이스만 이어붙인다', () => {
  const out = stitchSegments([
    { from: 2, to: 4, positions: [0, 0, 1, 1, 0, 0] },
    { from: 4, to: 6, positions: [0, 0, 0, 0, -1, -1] },
  ]);
  assert.equal(out.from, 2);
  assert.equal(out.to, 6);
  assert.deepEqual(out.positions, [1, 1, -1, -1]);
});

test('stitchSegments: 구간이 끊기면 Error (조용히 이어붙이지 않는다)', () => {
  assert.throws(
    () =>
      stitchSegments([
        { from: 0, to: 2, positions: [1, 1, 1, 1] },
        { from: 3, to: 4, positions: [1, 1, 1, 1] },
      ]),
    /연속/
  );
});

test('stitchSegments: 빈 입력은 Error', () => {
  assert.throws(() => stitchSegments([]), /비어/);
});

// ---- curveMetrics ----

test('curveMetrics: 총수익률과 최대낙폭', () => {
  const m = curveMetrics([100, 120, 90, 110], { periodsPerYear: 365 });
  near(m.totalReturnPct, 10);
  near(m.maxDrawdownPct, 25); // 고점 120 → 저점 90
});

test('curveMetrics: 기간을 연율화해 CAGR을 낸다', () => {
  // 365봉(=1년) 동안 2배 → CAGR 100%
  const equity = Array.from({ length: 366 }, (_, i) => 100 * (1 + i / 365));
  const m = curveMetrics(equity, { periodsPerYear: 365 });
  near(m.cagrPct, 100, 'CAGR');
});

test('curveMetrics: 낙폭이 0이면 Calmar는 null (무한대를 지표로 쓰지 않는다)', () => {
  const m = curveMetrics([100, 110, 120], { periodsPerYear: 365 });
  assert.equal(m.calmar, null);
});

test('curveMetrics: 변동이 없으면 샤프는 null', () => {
  const m = curveMetrics([100, 100, 100], { periodsPerYear: 365 });
  assert.equal(m.sharpe, null);
});

test('curveMetrics: 곡선이 2개 미만이면 Error', () => {
  assert.throws(() => curveMetrics([100], { periodsPerYear: 365 }), /2개/);
});

// ---- walkForwardEfficiency ----
// 학습 구간에서 낸 성과 대비 검증 구간에서 실제로 얼마나 살아남았는지.
// 1에 가까울수록 견고하고, 0에 가까우면 학습 구간에만 맞춘 것이다.

test('walkForwardEfficiency: 검증이 학습만큼 나오면 1', () => {
  near(walkForwardEfficiency([10, 20], [10, 20]), 1);
});

test('walkForwardEfficiency: 검증이 학습의 절반이면 0.5', () => {
  near(walkForwardEfficiency([20, 20], [10, 10]), 0.5);
});

test('walkForwardEfficiency: 학습 성과가 0 이하면 null (비율이 무의미)', () => {
  assert.equal(walkForwardEfficiency([0, 0], [10, 10]), null);
  assert.equal(walkForwardEfficiency([-5, -5], [10, 10]), null);
});

// ---- 워크포워드 게이트 ----

test('evaluateWfGate: 모든 조건을 만족해야 통과', () => {
  const base = {
    totalReturnPct: 40,
    maxDrawdownPct: 20,
    bhReturnPct: 10,
    tradeCount: 50,
    wfe: 0.6,
  };
  assert.equal(evaluateWfGate(base).passes, true);

  assert.equal(evaluateWfGate({ ...base, totalReturnPct: -1 }).passes, false, '마이너스 수익');
  assert.equal(evaluateWfGate({ ...base, bhReturnPct: 50 }).passes, false, '매수보유 미달');
  assert.equal(evaluateWfGate({ ...base, maxDrawdownPct: 60 }).passes, false, '낙폭 초과');
  assert.equal(evaluateWfGate({ ...base, tradeCount: 5 }).passes, false, '표본 부족');
  assert.equal(evaluateWfGate({ ...base, wfe: 0.05 }).passes, false, '학습에만 맞춰짐');
});

test('evaluateWfGate: 실패 사유를 모두 돌려준다', () => {
  const r = evaluateWfGate({
    totalReturnPct: -5,
    maxDrawdownPct: 80,
    bhReturnPct: 10,
    tradeCount: 2,
    wfe: null,
  });
  assert.equal(r.passes, false);
  assert.ok(r.reasons.length >= 4, `사유 ${r.reasons.length}건`);
});
