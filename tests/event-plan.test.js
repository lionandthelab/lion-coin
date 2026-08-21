const { test } = require('node:test');
const assert = require('node:assert/strict');

const { GRADE_PLAYBOOK, assessMarketContext, planEventTrade } = require('../src/event-plan');

const near = (a, b, msg) =>
  assert.ok(Math.abs(a - b) < 1e-9, `${msg ?? ''} — got ${a}, want ${b}`);

// 재료 매매는 "재료의 급"과 "시황"이 손절·익절을 정한다. 이 테스트가 못박는 것은
// 세 가지다: ① 현물에서 악재는 매매 대상이 아니다, ② 시황 배수는 익절에만 곱한다,
// ③ 계산된 명목이 최소 주문금액 아래로 떨어지는 조용한 실패를 드러낸다.

// ---- assessMarketContext ----

test('assessMarketContext: BTC 강세 + 넓은 시장폭이면 risk_on, 배수 1.3', () => {
  const ctx = assessMarketContext({ btcChange24hBps: 300, breadthPct: 70 });
  assert.equal(ctx.regime, 'risk_on');
  near(ctx.multiplier, 1.3);
  assert.match(ctx.reason, /300/);
});

test('assessMarketContext: 어중간한 시황은 neutral, 배수 1.0', () => {
  const ctx = assessMarketContext({ btcChange24hBps: 50, breadthPct: 50 });
  assert.equal(ctx.regime, 'neutral');
  near(ctx.multiplier, 1.0);
});

test('assessMarketContext: BTC가 크게 빠지면 risk_off, 배수 0.7', () => {
  const ctx = assessMarketContext({ btcChange24hBps: -300, breadthPct: 70 });
  assert.equal(ctx.regime, 'risk_off');
  near(ctx.multiplier, 0.7);
});

test('assessMarketContext: BTC가 올라도 시장폭이 좁으면 risk_off (OR 조건)', () => {
  // BTC만 보고 risk_on으로 판정하면 "BTC 혼자 오르고 알트는 죽은 장"에서
  // 익절을 넓게 잡게 된다 — 재료가 가장 안 먹히는 장이다.
  const ctx = assessMarketContext({ btcChange24hBps: 300, breadthPct: 30 });
  assert.equal(ctx.regime, 'risk_off');
  near(ctx.multiplier, 0.7);
});

test('assessMarketContext: 경계값은 어느 쪽에도 넣지 않는다 (초과/미만이 기준)', () => {
  assert.equal(assessMarketContext({ btcChange24hBps: 200, breadthPct: 60 }).regime, 'neutral');
  assert.equal(assessMarketContext({ btcChange24hBps: -200, breadthPct: 50 }).regime, 'neutral');
  assert.equal(assessMarketContext({ btcChange24hBps: 300, breadthPct: 40 }).regime, 'neutral');
});

test('assessMarketContext: 시황 데이터가 없으면 neutral로 위장하지 않고 null을 돌려준다', () => {
  const ctx = assessMarketContext({});
  assert.equal(ctx.regime, null);
  assert.equal(ctx.multiplier, null);
  assert.match(ctx.reason, /데이터/);

  assert.equal(assessMarketContext({ btcChange24hBps: 300, breadthPct: null }).regime, null);
  assert.equal(assessMarketContext({ btcChange24hBps: NaN, breadthPct: 70 }).regime, null);
});

// ---- planEventTrade: 현물 제약 ----

const RISK_ON = { regime: 'risk_on', multiplier: 1.3, reason: 'test' };
const NEUTRAL = { regime: 'neutral', multiplier: 1.0, reason: 'test' };
const RISK_OFF = { regime: 'risk_off', multiplier: 0.7, reason: 'test' };

const base = {
  marketContext: NEUTRAL,
  capital: 1000000,
  riskPct: 0.5,
  price: 100,
  feeBps: 8,
  minNotionalKrw: 5000,
};

test('planEventTrade: 악재는 side가 null이고 매매하지 않는다 (현물은 공매도 불가)', () => {
  const p = planEventTrade({ ...base, grade: 'S', direction: 'bearish' });
  assert.equal(p.side, null);
  assert.equal(p.executable, false);
  assert.match(p.reason, /현물은 하락에 베팅할 수 없음/);
});

test('planEventTrade: 악재는 등급이 아무리 높아도 수량을 만들지 않는다', () => {
  // 여기서 0을 돌려주면 하류가 "0주 매수"를 정상 주문으로 읽을 수 있다.
  const p = planEventTrade({ ...base, grade: 'S', direction: 'bearish' });
  assert.equal(p.quantity, null);
  assert.equal(p.notional, null);
  assert.equal(p.takeProfitBps, null);
  assert.equal(p.stopLossBps, null);
  assert.equal(p.maxHoldSec, null);
});

test('planEventTrade: 방향을 모르면 매매하지 않는다', () => {
  const p = planEventTrade({ ...base, grade: 'A', direction: 'unknown' });
  assert.equal(p.side, null);
  assert.equal(p.executable, false);
});

// ---- planEventTrade: 등급별 기본값 ----

test('planEventTrade: C급은 매매하지 않는다', () => {
  const p = planEventTrade({ ...base, grade: 'C', direction: 'bullish' });
  assert.equal(p.side, null);
  assert.equal(p.executable, false);
  assert.match(p.reason, /C급/);
});

test('planEventTrade: 알 수 없는 등급은 매매하지 않는다', () => {
  const p = planEventTrade({ ...base, grade: 'D', direction: 'bullish' });
  assert.equal(p.executable, false);
  assert.match(p.reason, /등급/);
});

test('planEventTrade: 등급마다 익절·손절·최대보유가 다르게 나온다', () => {
  const s = planEventTrade({ ...base, grade: 'S', direction: 'bullish' });
  const a = planEventTrade({ ...base, grade: 'A', direction: 'bullish' });
  const b = planEventTrade({ ...base, grade: 'B', direction: 'bullish' });

  assert.deepEqual(
    [s.takeProfitBps, s.stopLossBps, s.maxHoldSec],
    [500, 200, 600]
  );
  assert.deepEqual(
    [a.takeProfitBps, a.stopLossBps, a.maxHoldSec],
    [300, 150, 900]
  );
  assert.deepEqual(
    [b.takeProfitBps, b.stopLossBps, b.maxHoldSec],
    [150, 100, 1800]
  );
});

test('planEventTrade: 급이 높을수록 익절이 넓고 보유시간이 짧다', () => {
  const grades = ['S', 'A', 'B'].map((grade) => planEventTrade({ ...base, grade, direction: 'bullish' }));
  for (let i = 1; i < grades.length; i += 1) {
    assert.ok(grades[i - 1].takeProfitBps > grades[i].takeProfitBps, '익절은 급이 높을수록 넓다');
    assert.ok(grades[i - 1].maxHoldSec < grades[i].maxHoldSec, '급이 높을수록 빨리 실현한다');
  }
});

test('planEventTrade: 모든 등급에서 손절이 익절보다 좁다 (손익비로 먹는다)', () => {
  for (const grade of ['S', 'A', 'B']) {
    const p = planEventTrade({ ...base, grade, direction: 'bullish' });
    assert.ok(p.stopLossBps < p.takeProfitBps, `${grade}급 손절 ${p.stopLossBps} < 익절 ${p.takeProfitBps}`);
  }
});

// ---- planEventTrade: 시황 배수 ----

test('planEventTrade: risk_on이면 익절이 1.3배로 넓어진다', () => {
  const p = planEventTrade({ ...base, marketContext: RISK_ON, grade: 'A', direction: 'bullish' });
  near(p.takeProfitBps, 390); // 300 * 1.3
});

test('planEventTrade: risk_off면 익절이 0.7배로 좁아진다', () => {
  const p = planEventTrade({ ...base, marketContext: RISK_OFF, grade: 'A', direction: 'bullish' });
  near(p.takeProfitBps, 210); // 300 * 0.7
});

test('planEventTrade: 시황 배수는 손절에 곱해지지 않는다', () => {
  // 시황이 나쁘다고 손절을 넓히면 손실만 커진다. 손절은 등급이 정한 값 그대로다.
  const on = planEventTrade({ ...base, marketContext: RISK_ON, grade: 'A', direction: 'bullish' });
  const flat = planEventTrade({ ...base, marketContext: NEUTRAL, grade: 'A', direction: 'bullish' });
  const off = planEventTrade({ ...base, marketContext: RISK_OFF, grade: 'A', direction: 'bullish' });

  assert.equal(on.stopLossBps, GRADE_PLAYBOOK.A.stopLossBps);
  assert.equal(flat.stopLossBps, GRADE_PLAYBOOK.A.stopLossBps);
  assert.equal(off.stopLossBps, GRADE_PLAYBOOK.A.stopLossBps);
  assert.ok(on.takeProfitBps > flat.takeProfitBps && flat.takeProfitBps > off.takeProfitBps);
});

test('planEventTrade: 시황 배수는 최대보유시간도 바꾸지 않는다', () => {
  const on = planEventTrade({ ...base, marketContext: RISK_ON, grade: 'S', direction: 'bullish' });
  const off = planEventTrade({ ...base, marketContext: RISK_OFF, grade: 'S', direction: 'bullish' });
  assert.equal(on.maxHoldSec, 600);
  assert.equal(off.maxHoldSec, 600);
});

test('planEventTrade: 시황 배수는 수량을 바꾸지 않는다 (수량은 손절폭이 정한다)', () => {
  const on = planEventTrade({ ...base, marketContext: RISK_ON, grade: 'A', direction: 'bullish' });
  const off = planEventTrade({ ...base, marketContext: RISK_OFF, grade: 'A', direction: 'bullish' });
  near(on.quantity, off.quantity, '익절만 줄고 위험은 그대로다');
});

test('planEventTrade: 시황을 모르면 매매하지 않는다', () => {
  const unknown = assessMarketContext({});
  const p = planEventTrade({ ...base, marketContext: unknown, grade: 'S', direction: 'bullish' });
  assert.equal(p.executable, false);
  assert.equal(p.side, null);
  assert.match(p.reason, /시황/);

  const missing = planEventTrade({ ...base, marketContext: undefined, grade: 'S', direction: 'bullish' });
  assert.equal(missing.executable, false);
});

// ---- planEventTrade: 수량과 명목 ----

test('planEventTrade: 수량은 위험금액 ÷ 주당 손절 손실이다', () => {
  // 자본 100만 × 0.5% = 위험 5,000원. B급 손절 100bps → 주당 손실 1원 → 5,000주
  const p = planEventTrade({ ...base, grade: 'B', direction: 'bullish' });
  near(p.quantity, 5000);
  near(p.notional, 500000);
  assert.equal(p.cappedByCapital, false);
  assert.equal(p.side, 'buy');
  assert.equal(p.executable, true);
  assert.equal(p.reason, null);
});

test('planEventTrade: 명목이 자본을 넘으면 자본 한도로 자른다 (레버리지 없음)', () => {
  // 자본 100만 × 5% = 위험 5만. S급 손절 200bps → 주당 손실 2원 → 25,000주 = 명목 250만
  const p = planEventTrade({ ...base, riskPct: 5, grade: 'S', direction: 'bullish' });
  assert.equal(p.cappedByCapital, true);
  near(p.notional, 1000000);
  near(p.quantity, 10000);
});

test('planEventTrade: 명목이 최소 주문금액 미만이면 실행 불가이고 이유를 명시한다', () => {
  // 자본 10만 × 0.05% = 위험 50원. S급 손절 200bps → 주당 손실 2원 → 25주 = 명목 2,500원
  const p = planEventTrade({
    ...base, capital: 100000, riskPct: 0.05, grade: 'S', direction: 'bullish',
  });
  assert.equal(p.executable, false);
  assert.match(p.reason, /최소 주문금액/);
  assert.match(p.reason, /체결/, '신호는 떠도 한 건도 체결되지 않는다는 사실을 남겨야 한다');
  // 얼마나 모자란지는 그대로 보여준다 — 진단이 안 되면 같은 사고가 반복된다.
  near(p.notional, 2500);
});

test('planEventTrade: 실행 불가면 side를 null로 막는다 (하류의 실수 방지)', () => {
  const p = planEventTrade({
    ...base, capital: 100000, riskPct: 0.05, grade: 'S', direction: 'bullish',
  });
  assert.equal(p.side, null, 'executable를 확인하지 않는 호출자가 주문을 내지 못하게 한다');
});

test('planEventTrade: 익절이 왕복 비용을 감당 못 하면 실행 불가', () => {
  // risk_off에서 B급 익절은 105bps인데 왕복 수수료가 300bps면 전부 이겨도 손실이다.
  const p = planEventTrade({
    ...base, marketContext: RISK_OFF, feeBps: 150, grade: 'B', direction: 'bullish',
  });
  assert.equal(p.executable, false);
  assert.equal(p.side, null);
  assert.match(p.reason, /승률/);
});

test('planEventTrade: 가격·자본이 0 이하면 RangeError', () => {
  assert.throws(() => planEventTrade({ ...base, price: 0, grade: 'S', direction: 'bullish' }), RangeError);
  assert.throws(() => planEventTrade({ ...base, capital: 0, grade: 'S', direction: 'bullish' }), RangeError);
  assert.throws(() => planEventTrade({ ...base, riskPct: 0, grade: 'S', direction: 'bullish' }), RangeError);
  assert.throws(() => planEventTrade({ ...base, feeBps: -1, grade: 'S', direction: 'bullish' }), RangeError);
});

test('planEventTrade: 검증은 매매 불가 판정보다 나중이다 — 악재면 가격이 없어도 던지지 않는다', () => {
  // 악재 공지는 가격 조회 없이도 즉시 걸러져야 한다.
  const p = planEventTrade({ marketContext: NEUTRAL, grade: 'S', direction: 'bearish' });
  assert.equal(p.executable, false);
  assert.equal(p.side, null);
});
