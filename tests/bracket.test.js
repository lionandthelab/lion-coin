const { test } = require('node:test');
const assert = require('node:assert/strict');

const { breakevenWinRate, expectancyBps, planBracket } = require('../src/bracket');

const near = (a, b, msg) =>
  assert.ok(Math.abs(a - b) < 1e-9, `${msg ?? ''} — got ${a}, want ${b}`);

// 상단·하단 조건 주문은 "확실한 수익"을 만들지 않는다. 작은 이익을 자주 +
// 큰 손실을 가끔으로 **분포를 바꿀** 뿐이다. 그 사실을 숫자로 드러내는 것이
// 이 모듈의 존재 이유다 — 손익분기 승률이 그것이다.

// ---- breakevenWinRate ----

test('breakevenWinRate: 비용이 0이면 익절·손절 폭 비율로만 결정된다', () => {
  // TP +100bps / SL -100bps → 50%
  near(breakevenWinRate({ tpBps: 100, slBps: 100, costBps: 0 }), 0.5);
  // TP +200 / SL -100 → 1/3
  near(breakevenWinRate({ tpBps: 200, slBps: 100, costBps: 0 }), 1 / 3);
});

test('breakevenWinRate: 비용이 손익분기 승률을 밀어올린다', () => {
  // 빗썸 상위권 왕복 28bps, TP·SL 각 50bps → (50+28)/(50+50) = 78%
  near(breakevenWinRate({ tpBps: 50, slBps: 50, costBps: 28 }), 0.78);
});

test('breakevenWinRate: 익절을 좁게 잡을수록 급격히 나빠진다', () => {
  const wide = breakevenWinRate({ tpBps: 100, slBps: 100, costBps: 28 });
  const narrow = breakevenWinRate({ tpBps: 30, slBps: 30, costBps: 28 });
  assert.ok(narrow > wide);
  near(narrow, (30 + 28) / 60);
});

test('breakevenWinRate: 1을 넘으면 어떤 승률로도 불가능하다는 뜻이다', () => {
  // TP 20bps인데 왕복 비용 45bps(빗썸 하위권) → 100% 이겨도 손실
  const p = breakevenWinRate({ tpBps: 20, slBps: 50, costBps: 45 });
  assert.ok(p > 1, `손익분기 승률 ${p}`);
});

test('breakevenWinRate: 손절을 넓히면 손익분기 승률이 올라간다', () => {
  const tight = breakevenWinRate({ tpBps: 50, slBps: 50, costBps: 10 });
  const loose = breakevenWinRate({ tpBps: 50, slBps: 200, costBps: 10 });
  assert.ok(loose > tight, '손절을 넓히면 한 번의 손실을 메우기 어려워진다');
});

test('breakevenWinRate: 폭이 0 이하면 RangeError', () => {
  assert.throws(() => breakevenWinRate({ tpBps: 0, slBps: 50, costBps: 10 }), RangeError);
  assert.throws(() => breakevenWinRate({ tpBps: 50, slBps: -1, costBps: 10 }), RangeError);
  assert.throws(() => breakevenWinRate({ tpBps: 50, slBps: 50, costBps: -1 }), RangeError);
});

// ---- expectancyBps ----

test('expectancyBps: 손익분기 승률에서 기대값이 0이다', () => {
  const args = { tpBps: 50, slBps: 50, costBps: 28 };
  near(expectancyBps({ ...args, winRate: breakevenWinRate(args) }), 0);
});

test('expectancyBps: 승률이 손익분기보다 높으면 양수', () => {
  assert.ok(expectancyBps({ tpBps: 50, slBps: 50, costBps: 28, winRate: 0.9 }) > 0);
});

test('expectancyBps: 승률이 손익분기보다 낮으면 음수', () => {
  assert.ok(expectancyBps({ tpBps: 50, slBps: 50, costBps: 28, winRate: 0.7 }) < 0);
});

test('expectancyBps: 승률이 0~1을 벗어나면 RangeError', () => {
  assert.throws(() => expectancyBps({ tpBps: 50, slBps: 50, costBps: 0, winRate: 1.2 }), RangeError);
});

// ---- planBracket ----

test('planBracket: 진입가 기준 상단·하단 가격과 수량을 낸다', () => {
  const p = planBracket({
    entryPrice: 100,
    takeProfitBps: 100, // +1%
    stopLossBps: 50, //  -0.5%
    capital: 1000000,
    // 손절이 0.5%로 좁으면 계좌의 1%를 거는 것만으로 명목이 자본의 200%가 되어
    // 레버리지 한도에 걸린다. 좁은 손절은 자동으로 큰 명목을 요구한다.
    riskPct: 0.25,
    costBps: 28,
  });
  near(p.takeProfitPrice, 101);
  near(p.stopLossPrice, 99.5);
  // 손실 허용액 2,500원 ÷ 주당 손실 0.5원 = 5,000주
  near(p.quantity, 5000);
  near(p.notional, 500000);
  assert.equal(p.cappedByCapital, false);
});

test('planBracket: 좁은 손절 + 큰 위험비중은 자본 한도에 걸린다', () => {
  const p = planBracket({
    entryPrice: 100, takeProfitBps: 100, stopLossBps: 50,
    capital: 1000000, riskPct: 1, costBps: 28,
  });
  assert.equal(p.cappedByCapital, true);
  near(p.notional, 1000000);
});

test('planBracket: 명목이 자본을 넘으면 자본 한도로 줄인다 (레버리지 금지)', () => {
  const p = planBracket({
    entryPrice: 100, takeProfitBps: 100, stopLossBps: 50,
    capital: 1000000, riskPct: 10, costBps: 28,
  });
  assert.ok(p.notional <= 1000000 + 1e-6, `명목 ${p.notional}`);
  assert.equal(p.cappedByCapital, true);
});

test('planBracket: 손익분기 승률과 기대값을 함께 돌려준다', () => {
  const p = planBracket({
    entryPrice: 100, takeProfitBps: 50, stopLossBps: 50,
    capital: 1000000, riskPct: 1, costBps: 28, assumedWinRate: 0.7,
  });
  near(p.breakevenWinRate, 0.78);
  assert.ok(p.expectancyBps < 0, '가정 승률 70% < 손익분기 78% → 기대값 음수');
});

test('planBracket: 최소 주문금액에 못 미치면 실행 불가로 표시한다', () => {
  const p = planBracket({
    entryPrice: 100, takeProfitBps: 100, stopLossBps: 50,
    capital: 10000, riskPct: 0.1, costBps: 28, minNotional: 5000,
  });
  assert.equal(p.executable, false);
  assert.match(p.reason, /최소/);
});

test('planBracket: 손익분기 승률이 1을 넘으면 실행 불가로 표시한다', () => {
  const p = planBracket({
    entryPrice: 100, takeProfitBps: 20, stopLossBps: 50,
    capital: 1000000, riskPct: 1, costBps: 45,
  });
  assert.equal(p.executable, false);
  assert.match(p.reason, /승률/);
});

test('planBracket: 정상 설정은 실행 가능으로 표시한다', () => {
  const p = planBracket({
    entryPrice: 100, takeProfitBps: 300, stopLossBps: 100,
    capital: 1000000, riskPct: 1, costBps: 28,
  });
  assert.equal(p.executable, true);
  assert.equal(p.reason, null);
});

test('planBracket: 진입가·자본이 0 이하면 RangeError', () => {
  assert.throws(() => planBracket({ entryPrice: 0, takeProfitBps: 100, stopLossBps: 50, capital: 1000 }), RangeError);
  assert.throws(() => planBracket({ entryPrice: 100, takeProfitBps: 100, stopLossBps: 50, capital: 0 }), RangeError);
});
