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

// risk_on은 AND 조건이라 두 축을 동시에 경계에 두면 어느 한쪽 문턱이 크게 움직여도
// 결과가 뒤집히지 않는다 — 문턱을 고정하려면 **한 축만** 경계에 두고 다른 축은 넉넉히
// 넘겨 둬야 한다. 아래 두 테스트가 각각 BTC 문턱과 시장폭 문턱을 따로 못박는다.
test('assessMarketContext: risk_on의 BTC 문턱은 200bps 초과다 (시장폭은 넉넉히 넘긴 상태)', () => {
  assert.equal(assessMarketContext({ btcChange24hBps: 200, breadthPct: 70 }).regime, 'neutral');
  assert.equal(assessMarketContext({ btcChange24hBps: 200.1, breadthPct: 70 }).regime, 'risk_on');
});

test('assessMarketContext: risk_on의 시장폭 문턱은 60% 초과다 (BTC는 넉넉히 넘긴 상태)', () => {
  assert.equal(assessMarketContext({ btcChange24hBps: 250, breadthPct: 60 }).regime, 'neutral');
  assert.equal(assessMarketContext({ btcChange24hBps: 250, breadthPct: 60.1 }).regime, 'risk_on');
});

test('assessMarketContext: risk_off 문턱도 축별로 고정된다 (OR 조건)', () => {
  assert.equal(assessMarketContext({ btcChange24hBps: -200, breadthPct: 70 }).regime, 'neutral');
  assert.equal(assessMarketContext({ btcChange24hBps: -200.1, breadthPct: 70 }).regime, 'risk_off');
  assert.equal(assessMarketContext({ btcChange24hBps: 300, breadthPct: 40 }).regime, 'neutral');
  assert.equal(assessMarketContext({ btcChange24hBps: 300, breadthPct: 39.9 }).regime, 'risk_off');
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

// ---- planEventTrade: 손상된 시황 객체 ----
//
// marketContext는 이 모듈이 만들지 않는다 — 호출자가 만들어 넣는다. 그래서 다른
// 입력값과 달리 "여기 오기 전에 검증됐겠지"를 가정할 수 없다. 배수는 익절폭에 그대로
// 곱해지므로 손상된 값 하나가 계획 전체를 조용히 망가뜨린다.

test('planEventTrade: 배수가 null이면 매매하지 않는다 (300 * null === 0이라 조용히 익절 0이 된다)', () => {
  // NaN이었다면 하류에서 시끄럽게 터졌을 자리다. null은 곱셈에서 0이 되어
  // "진입 즉시 익절"인 계획을 정상처럼 통과시킨다.
  const p = planEventTrade({ ...base, marketContext: { regime: 'neutral', multiplier: null }, grade: 'A', direction: 'bullish' });
  assert.equal(p.executable, false);
  assert.equal(p.side, null);
  assert.equal(p.takeProfitBps, null);
  assert.match(p.reason, /배수/);
});

test('planEventTrade: 배수가 상한을 넘으면 매매하지 않는다 (익절에 영영 닿지 않는 계획을 막는다)', () => {
  // 상한이 없으면 손상된 시황이 익절 3,000억bps짜리 계획을 만든다 —
  // 손절과 시간초과로만 빠져나오는, 기대값이 음수로 고정된 포지션이다.
  const p = planEventTrade({ ...base, marketContext: { regime: 'neutral', multiplier: 1e9 }, grade: 'A', direction: 'bullish' });
  assert.equal(p.executable, false);
  assert.equal(p.side, null);
  assert.match(p.reason, /배수/);
});

test('planEventTrade: 숫자가 아닌 배수는 비교 연산에 조용히 실려 가지 않는다', () => {
  // 범위 비교만으로는 못 잡는 값들이다. NaN·undefined는 어느 부등호도 참이 아니라
  // 그대로 통과해 익절이 NaN이 되고, 문자열 '1.3'과 true는 비교에서 숫자로
  // 강제 변환돼 "정상 계획"처럼 통과한다 — 시황 판정이 손상된 사실이 묻힌다.
  for (const multiplier of [NaN, undefined, '1.3', true]) {
    const p = planEventTrade({ ...base, marketContext: { regime: 'neutral', multiplier }, grade: 'A', direction: 'bullish' });
    assert.equal(p.executable, false, `배수 ${String(multiplier)}`);
    assert.equal(p.takeProfitBps, null);
    assert.match(p.reason, /배수/);
  }
});

test('planEventTrade: 배수가 하한 미만이면 던지지 않고 매매하지 않는다', () => {
  // 이 모듈의 원칙은 "매매 불가는 던지지 않고 noTrade로 돌려준다"다. 던지면
  // 호출자가 넘긴 적도 없는 내부 파라미터명(takeProfitBps)이 에러로 새어 나온다.
  for (const multiplier of [0.0001, 0, -1]) {
    const p = planEventTrade({ ...base, marketContext: { regime: 'neutral', multiplier }, grade: 'A', direction: 'bullish' });
    assert.equal(p.executable, false, `배수 ${multiplier}`);
    assert.equal(p.side, null);
    assert.match(p.reason, /배수/);
  }
});

test('planEventTrade: 계획에는 판정된 시황을 그대로 실어 보낸다', () => {
  // 사후에 "어떤 장에서 낸 주문인가"를 못 붙이면 체결 기록만으로는 검증이 불가능하다.
  assert.equal(planEventTrade({ ...base, marketContext: RISK_ON, grade: 'A', direction: 'bullish' }).regime, 'risk_on');
  assert.equal(planEventTrade({ ...base, marketContext: NEUTRAL, grade: 'A', direction: 'bullish' }).regime, 'neutral');
  assert.equal(planEventTrade({ ...base, marketContext: RISK_OFF, grade: 'A', direction: 'bullish' }).regime, 'risk_off');
});

// ---- planEventTrade: 등급 키 ----

test('planEventTrade: 등급은 대소문자를 가리지 않는다', () => {
  const upper = planEventTrade({ ...base, grade: 'B', direction: 'bullish' });
  const lower = planEventTrade({ ...base, grade: 'b', direction: 'bullish' });
  assert.deepEqual(
    [lower.takeProfitBps, lower.stopLossBps, lower.maxHoldSec, lower.executable],
    [upper.takeProfitBps, upper.stopLossBps, upper.maxHoldSec, upper.executable]
  );
  assert.equal(planEventTrade({ ...base, grade: 'c', direction: 'bullish' }).executable, false);
});

test('planEventTrade: 문자열이 아닌 등급은 등급표를 인덱싱하지 못한다', () => {
  for (const grade of [5, null, undefined, {}, ['S'], true]) {
    const p = planEventTrade({ ...base, grade, direction: 'bullish' });
    assert.equal(p.executable, false, `등급 ${JSON.stringify(grade)}`);
    assert.equal(p.side, null);
    assert.match(p.reason, /등급/);
  }
});

test('planEventTrade: 프로토타입 속성 이름은 등급이 아니다', () => {
  // 'constructor' in GRADE_PLAYBOOK 은 true다 — in은 프로토타입 체인까지 뒤진다.
  // 지금은 toUpperCase()가 우연히 막아주고 있을 뿐이라, 표 조회 자체를 자기 속성으로 한정해야 한다.
  for (const grade of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
    const p = planEventTrade({ ...base, grade, direction: 'bullish' });
    assert.equal(p.executable, false, `등급 ${grade}`);
    assert.equal(p.quantity, null);
    assert.match(p.reason, /등급/);
  }
});

test('planEventTrade: 프로토타입이 오염돼도 등급표는 자기 속성만 본다', () => {
  // 프로토타입 오염은 JSON 병합 한 번으로 들어온다. 표를 in으로 조회하면 오염된
  // 이름이 그대로 "아는 등급"이 되어, 익절 9,999bps짜리 남의 플레이북으로 주문이 나간다.
  Object.defineProperty(Object.prototype, 'Z', {
    value: { takeProfitBps: 9999, stopLossBps: 1, maxHoldSec: 60 },
    configurable: true,
    enumerable: false,
  });
  try {
    const p = planEventTrade({ ...base, grade: 'Z', direction: 'bullish' });
    assert.equal(p.executable, false);
    assert.equal(p.takeProfitBps, null);
    assert.match(p.reason, /등급/);
  } finally {
    delete Object.prototype.Z;
  }
});

// ---- planEventTrade: 비용 ----

test('planEventTrade: 비용은 편도 수수료의 왕복(×2)으로 계산된다', () => {
  // 왕복을 편도로 반만 세면 손익분기 승률이 실제보다 낮게 나온다 — 계획서상으로만
  // 되는 매매가 만들어진다. 손익분기 승률 = (손절 + 왕복비용) / (익절 + 손절).
  const a = planEventTrade({ ...base, feeBps: 8, grade: 'A', direction: 'bullish' });
  near(a.breakevenWinRate, (150 + 8 * 2) / (300 + 150), '편도 8bps → 왕복 16bps');

  const b = planEventTrade({ ...base, feeBps: 50, grade: 'A', direction: 'bullish' });
  near(b.breakevenWinRate, (150 + 50 * 2) / (300 + 150), '편도 50bps → 왕복 100bps');

  // 수수료가 오른 만큼 손익분기 승률도 정확히 그 두 배만큼 올라야 한다.
  near(b.breakevenWinRate - a.breakevenWinRate, ((50 - 8) * 2) / (300 + 150));
});

test('planEventTrade: 왕복 비용을 감당 못 할 때 이유에 왕복 금액을 적는다', () => {
  const p = planEventTrade({
    ...base, marketContext: RISK_OFF, feeBps: 150, grade: 'B', direction: 'bullish',
  });
  assert.equal(p.executable, false);
  assert.match(p.reason, /300bps/, '편도 150bps의 왕복은 300bps다');
});

test('planEventTrade: 수수료를 명시하지 않으면 무비용으로 가정하지 않는다', () => {
  // 기본값 0은 "비용 없는 계획"을 만든다. 비용을 낙관적으로 가정한 계획은
  // 실측과 어긋나 검증 자체를 무의미하게 만든다 — 이 저장소가 반복해 세운 원칙이다.
  const { feeBps, ...noFee } = base;
  assert.throws(
    () => planEventTrade({ ...noFee, grade: 'B', direction: 'bullish' }),
    /feeBps.*명시/s,
    '"잘못된 숫자"가 아니라 "비용을 적어야 한다"고 말해야 한다'
  );
});

// ---- planEventTrade: 관문별 검증 ----

test('planEventTrade: 음수 수수료는 event-plan의 관문에서 걸린다', () => {
  // 예전 테스트는 RangeError만 봤다 — 이 관문을 지워도 planBracket이 대신 던져서
  // 초록이었다. 어느 관문이 발동했는지 메시지로 확인해야 관문의 존재가 고정된다.
  assert.throws(
    () => planEventTrade({ ...base, feeBps: -1, grade: 'S', direction: 'bullish' }),
    /feeBps/
  );
});

test('planEventTrade: 최소 주문금액이 0 이하면 관문에서 걸린다', () => {
  // 이 관문이 없으면 minNotionalKrw=0이 조용히 통과해 "최소 주문금액 미달" 판정이
  // 영원히 뜨지 않는다 — 08-17 사고를 못 잡는 상태로 되돌아간다.
  for (const minNotionalKrw of [0, -5, NaN]) {
    assert.throws(
      () => planEventTrade({ ...base, minNotionalKrw, grade: 'S', direction: 'bullish' }),
      /minNotionalKrw/,
      `minNotionalKrw ${minNotionalKrw}`
    );
  }
});

test('planEventTrade: 위험 비중 기본값은 1%다', () => {
  // 자본 100만 × 1% = 위험 1만. S급 손절 200bps → 주당 손실 2원 → 5,000주 = 명목 50만.
  const { riskPct, ...noRisk } = base;
  const p = planEventTrade({ ...noRisk, grade: 'S', direction: 'bullish' });
  near(p.quantity, 5000);
  near(p.notional, 500000);
  assert.equal(p.cappedByCapital, false, '기본값이 100%였다면 자본 한도에 걸린다');
});

test('planEventTrade: 최소 주문금액 기본값은 빗썸 기준 5,000원이다', () => {
  const { minNotionalKrw, ...noMin } = base;
  const p = planEventTrade({ ...noMin, capital: 100000, riskPct: 0.05, grade: 'S', direction: 'bullish' });
  near(p.notional, 2500);
  assert.equal(p.executable, false, '명목 2,500원은 기본 최소 주문금액 5,000원에 못 미친다');
  assert.match(p.reason, /5,000원/);
});

// ---- planEventTrade: 최소명목 미달의 진단 ----
//
// 이 문자열의 존재 이유가 08-17 사고 재발 방지다. 조언이 틀리면 읽는 사람이
// 엉뚱한 손잡이를 돌리게 되므로, 문구가 상황과 맞는지까지 테스트로 고정한다.

test('planEventTrade: 위험 비중으로 해결되는 경우 필요한 비중을 숫자로 알려준다', () => {
  // 명목 2,500원 → 5,000원이 되려면 위험 비중이 0.05%에서 0.10%로 두 배여야 한다.
  const p = planEventTrade({
    ...base, capital: 100000, riskPct: 0.05, grade: 'S', direction: 'bullish',
  });
  assert.equal(p.executable, false);
  assert.match(p.reason, /최소 주문금액/);
  assert.match(p.reason, /0\.10%/, '"올리세요"가 아니라 얼마로 올려야 하는지를 적는다');
});

test('planEventTrade: 자본 한도에 걸린 계획에는 위험 비중을 올리라고 하지 않는다', () => {
  // 위험 비중이 이미 100%이고 명목이 자본 한도에 잘려 있다. 비중을 올려도
  // 명목은 1원도 커지지 않는다 — 여기서 "비중을 올리세요"는 틀린 진단이다.
  const p = planEventTrade({
    ...base, capital: 1000, riskPct: 100, grade: 'S', direction: 'bullish',
  });
  assert.equal(p.executable, false);
  assert.equal(p.cappedByCapital, true);
  assert.doesNotMatch(p.reason, /위험 비중을 올리/, '틀린 손잡이를 돌리게 만드는 조언이다');
  assert.doesNotMatch(p.reason, /위험 비중을 [\d.]+% 이상으로 올리/);
  assert.match(p.reason, /자본 한도/, '왜 비중이 소용없는지까지 적어야 같은 사고가 반복되지 않는다');
});

test('planEventTrade: 비중을 올리면 될 것처럼 보이지만 자본 한도에 걸린 경우도 구분한다', () => {
  // 자본 4,000원 × 3% = 위험 120원 → S급 손절 200bps → 60주 = 명목 6,000원인데
  // 자본 한도에 4,000원으로 잘린다. 산술만 보면 "비중을 3.75%로 올리면 5,000원"이지만
  // 실제로는 명목이 자본에 묶여 있어 비중을 아무리 올려도 4,000원 그대로다.
  const p = planEventTrade({
    ...base, capital: 4000, riskPct: 3, grade: 'S', direction: 'bullish',
  });
  assert.equal(p.cappedByCapital, true);
  assert.equal(p.executable, false);
  assert.doesNotMatch(p.reason, /3\.75%/, '자본 한도를 무시한 역산은 틀린 조언이다');
  assert.match(p.reason, /자본 한도/);
});

test('planEventTrade: 위험 비중 상한으로도 못 넘으면 필요한 자본을 알려준다', () => {
  // 자본 50원. 비중을 100%까지 올려도 명목이 5,000원에 닿지 않는다.
  const p = planEventTrade({
    ...base, capital: 50, riskPct: 1, grade: 'S', direction: 'bullish',
  });
  assert.equal(p.executable, false);
  assert.equal(p.cappedByCapital, false, '이 조합은 자본 한도에 걸리기 전에 최소명목에서 막힌다');
  assert.match(p.reason, /100%/);
  assert.match(p.reason, /10,000원/, '필요한 자본을 계산해서 적는다');
});

// ---- 기록: risk_off 배수의 함정 ----

test('planEventTrade: risk_off는 익절만 좁혀 손익분기 승률을 올린다 (구조적 손익비 악화)', () => {
  // 배수는 익절에만 곱하고 손절·수량은 그대로 두므로, risk_off는 "덜 먹히는 장에서
  // 더 자주 맞아야 본전인 규칙"이 된다. 의도된 사양이지만 값을 조정할 사람이
  // 반드시 알아야 하는 함정이라 숫자로 남긴다.
  const flat = planEventTrade({ ...base, marketContext: NEUTRAL, grade: 'B', direction: 'bullish' });
  const off = planEventTrade({ ...base, marketContext: RISK_OFF, grade: 'B', direction: 'bullish' });

  assert.equal(off.stopLossBps, flat.stopLossBps, '손절은 그대로다');
  near(off.quantity, flat.quantity, '수량도 그대로다');
  near(flat.breakevenWinRate, 0.464); // (100 + 16) / (150 + 100)
  near(off.breakevenWinRate, 116 / 205); // (100 + 16) / (105 + 100) ≈ 56.6%
  assert.ok(off.breakevenWinRate > flat.breakevenWinRate, 'risk_off가 요구 승률을 10%p 넘게 올린다');
});
