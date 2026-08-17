const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  REVIEW_EVERY,
  shouldReview,
  reviewTrades,
  proposeAdjustment,
} = require('../src/review');

// 10거래마다 복기해 전략을 조정하는 로직.
//
// **가장 위험한 실패 방식은 잡음에 반응해 파라미터를 흔드는 것이다.** 10거래는
// 매우 작은 표본이다. 익절 500bps / 손절 200bps 구조에서 승률 40%면 기대값이
// 0인데, 10거래에서 승률 20%가 나올 확률은 우연만으로도 상당하다.
// 그래서 이 모듈은 **멈출 근거**를 찾는 데 보수적이지 않고(손실은 빨리 끊는다),
// **바꿀 근거**를 찾는 데는 보수적이어야 한다.

const t = (returnBps, outcome = returnBps > 0 ? 'tp' : 'sl') => ({
  returnBps, outcome, symbol: 'X', at: '2026-08-17T00:00:00.000Z',
});

test('shouldReview: 10거래마다 참', () => {
  assert.equal(shouldReview(10), true);
  assert.equal(shouldReview(20), true);
  assert.equal(shouldReview(9), false);
  assert.equal(shouldReview(11), false);
});

test('shouldReview: 0거래에서는 복기하지 않는다', () => {
  assert.equal(shouldReview(0), false);
});

test('REVIEW_EVERY는 10이다', () => {
  assert.equal(REVIEW_EVERY, 10);
});

// ---- 복기 집계 ----

test('reviewTrades: 최근 N거래의 실적을 낸다', () => {
  const trades = Array.from({ length: 25 }, (_, i) => t(i < 15 ? -100 : 200));
  const r = reviewTrades(trades, { window: 10 });
  assert.equal(r.count, 10);
  assert.equal(r.wins, 10, '마지막 10건만 본다');
  assert.ok(Math.abs(r.expectancyBps - 200) < 1e-9);
});

test('reviewTrades: 거래가 창보다 적으면 있는 만큼만 본다', () => {
  const r = reviewTrades([t(100), t(-50)], { window: 10 });
  assert.equal(r.count, 2);
});

test('reviewTrades: 거래가 없으면 지표를 0으로 위장하지 않는다', () => {
  const r = reviewTrades([], { window: 10 });
  assert.equal(r.count, 0);
  assert.equal(r.expectancyBps, null);
  assert.equal(r.winRate, null);
});

test('reviewTrades: 기대 승률 대비 부족분을 함께 낸다', () => {
  // 익절 500 / 손절 200 / 비용 25 → 손익분기 승률 (200+25)/(500+200) = 32.1%
  const trades = Array.from({ length: 10 }, (_, i) => t(i < 3 ? 475 : -225));
  const r = reviewTrades(trades, { window: 10, takeProfitBps: 500, stopLossBps: 200, costBps: 25 });
  assert.ok(Math.abs(r.breakevenWinRate - 225 / 700) < 1e-9);
  assert.ok(Math.abs(r.winRate - 0.3) < 1e-9);
  assert.equal(r.belowBreakeven, true, '30% < 32.1%');
});

test('reviewTrades: 최대 연속 손실을 센다', () => {
  const r = reviewTrades([t(100), t(-100), t(-100), t(-100), t(100), t(-100)], { window: 10 });
  assert.equal(r.maxLossStreak, 3);
});

// ---- 조정 제안 ----
// 손실을 끊는 데는 민감하게, 파라미터를 바꾸는 데는 둔감하게.

test('proposeAdjustment: 표본이 모자라면 아무것도 바꾸지 않는다', () => {
  const p = proposeAdjustment(reviewTrades([t(-300), t(-300)], { window: 10 }), {});
  assert.equal(p.action, 'hold');
  assert.match(p.reason, /표본/);
});

test('proposeAdjustment: 누적 손실이 한도를 넘으면 매매를 멈춘다', () => {
  // 10거래에서 평균 -300bps는 우연으로 보기 어렵다 — 즉시 멈춘다
  const review = reviewTrades(Array.from({ length: 10 }, () => t(-300)), { window: 10 });
  const p = proposeAdjustment(review, { maxDrawdownBps: 1000 });
  assert.equal(p.action, 'halt');
  assert.match(p.reason, /손실/);
});

test('proposeAdjustment: 실적이 기대 범위 안이면 그대로 둔다', () => {
  // 승률 40%, 익절 500 / 손절 200 → 기대값 플러스. 흔들 이유가 없다.
  const review = reviewTrades(
    Array.from({ length: 10 }, (_, i) => t(i < 4 ? 475 : -225)),
    { window: 10, takeProfitBps: 500, stopLossBps: 200, costBps: 25 }
  );
  const p = proposeAdjustment(review, {});
  assert.equal(p.action, 'hold');
});

test('proposeAdjustment: 한 번의 복기로 파라미터를 바꾸지 않는다', () => {
  // 10거래는 파라미터를 바꿀 근거가 되지 못한다. 연속으로 나빠야 움직인다.
  const bad = reviewTrades(Array.from({ length: 10 }, (_, i) => t(i < 1 ? 475 : -225)),
    { window: 10, takeProfitBps: 500, stopLossBps: 200, costBps: 25 });
  // 중단 판정이 조정보다 우선하므로, 조정 경로를 보려면 손실 한도를 넉넉히 준다
  const opts = { maxDrawdownBps: 100000 };
  const once = proposeAdjustment(bad, { ...opts, consecutiveBadReviews: 0 });
  assert.notEqual(once.action, 'adjust', '한 번 나빴다고 바꾸면 잡음을 쫓게 된다');

  const thrice = proposeAdjustment(bad, { ...opts, consecutiveBadReviews: 2 });
  assert.equal(thrice.action, 'adjust');
  assert.ok(thrice.patch, '무엇을 어떻게 바꿀지 함께 낸다');
});

test('proposeAdjustment: 조정은 설정 검증을 통과하는 값이어야 한다', () => {
  const { validateConfigPatch } = require('../src/trading-config');
  const base = {
    strategy: 'reversal', interval: '30m', maxSymbols: 60, minTradeValue24h: 3e8,
    lookback: 20, volMult: 5, takeProfitBps: 500, stopLossBps: 200, feeBps: 4,
    capitalKrw: 39000, riskPct: 1, scanIntervalSec: 60, maxSpreadBps: 30,
    maxBreakevenWinRate: 0.6, maxConcurrentPositions: 1, minNotionalKrw: 5000, maxHoldBars: 6,
  };
  const bad = reviewTrades(Array.from({ length: 10 }, () => t(-225)),
    { window: 10, takeProfitBps: 500, stopLossBps: 200, costBps: 25 });
  const p = proposeAdjustment(bad, { consecutiveBadReviews: 2, maxDrawdownBps: 100000 });
  if (p.action === 'adjust') {
    assert.equal(validateConfigPatch(p.patch, base).ok, true, `검증 실패: ${JSON.stringify(p.patch)}`);
  }
});

test('proposeAdjustment: 제안에는 사람이 읽을 근거가 붙는다', () => {
  const review = reviewTrades(Array.from({ length: 10 }, () => t(-300)), { window: 10 });
  const p = proposeAdjustment(review, { maxDrawdownBps: 1000 });
  assert.ok(p.reason && p.reason.length > 5, '근거 없는 자동 조정은 검증할 수 없다');
  assert.ok(Array.isArray(p.evidence), '판단에 쓴 수치를 남긴다');
});
