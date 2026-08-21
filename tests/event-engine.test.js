const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  STATES,
  createEventState,
  onMaterialDetected,
  onPriceTick,
  onFillConfirmed,
  onExitConfirmed,
  onExitFailed,
  MAX_EXIT_RETRIES,
  halt,
} = require('../src/event-engine');

// 이 엔진의 입력은 지어낸 객체가 아니라 event-plan이 실제로 만들어내는 계획이다.
// 상류 모듈을 함께 불러오는 이유: 구현에 맞춰 손으로 빚은 입력은 "실제 생산자가
// 만드는 모양"과 어긋나도 초록으로 남는다 — 실제로 그 어긋남이 사고를 냈다.
const sources = require('../src/event-sources');
const material = require('../src/material');
const eventPlan = require('../src/event-plan');

// 이벤트 매매는 "재료를 보고 들어가서, 보유하는 동안 눈을 떼지 않고, 조건이 닿으면
// 즉시 시장가로 나온다"가 전부다. 이 파일이 못박는 것은 그 중 **나오는 규칙**과
// **들어가지 않아야 할 때 들어가지 않는 것**이다. 후자가 사고를 막는다.

const near = (a, b, msg) =>
  assert.ok(Math.abs(a - b) < 1e-9, `${msg ?? ''} — got ${a}, want ${b}`);

const T0 = 1_700_000_000_000; // 기준 시각(epoch ms)

const MATERIAL = { grade: 'A', kind: 'listing', symbol: 'ABC' };
const EVENT = { source: 'bithumb-notice', id: 1654570, title: '신규 거래지원 안내' };

// 익절 +300bps, 손절 -150bps, 최대 보유 60초.
const PLAN = { takeProfitBps: 300, stopLossBps: 150, maxHoldSec: 60, costBps: 28 };

const detect = (state, over = {}) =>
  onMaterialDetected(state, { event: EVENT, material: MATERIAL, plan: PLAN, now: T0, ...over });

// 실제 공지 페이로드(tests/fixtures)를 그대로 파싱해 돌려준다.
const FIXTURES = path.join(__dirname, 'fixtures');
const readFixtureEvents = () => [
  ...sources.parseBithumbNotices(JSON.parse(fs.readFileSync(path.join(FIXTURES, 'bithumb-notices.json'), 'utf8'))),
  ...sources.parseUpbitNotices(JSON.parse(fs.readFileSync(path.join(FIXTURES, 'upbit-notices.json'), 'utf8'))),
  ...sources.parseRss(fs.readFileSync(path.join(FIXTURES, 'blockmedia-rss.xml'), 'utf8'), 'blockmedia'),
];

const KNOWN_SYMBOLS = ['BTC', 'ETH', 'XRP', 'MEGA', 'BNB', 'SOL', 'DOGE', 'ADA', 'AVAX', 'LINK'];
const MARKET_CONTEXT = eventPlan.assessMarketContext({ btcChange24hBps: 50, breadthPct: 50 });

// event-trader.js의 tryEnter가 하는 것과 같은 순서로 실제 계획을 만든다.
const realPlanFor = (m) =>
  eventPlan.planEventTrade({
    grade: m.grade, direction: m.direction, marketContext: MARKET_CONTEXT,
    capital: 1_000_000, riskPct: 1, price: 100, feeBps: 4, minNotionalKrw: 5000,
  });

// 실제 생산자가 만드는 "매매하지 않음" 계획 — tp/sl/maxHold가 **전부 null**이다.
const realNoTradePlan = () =>
  eventPlan.planEventTrade({
    grade: 'C', direction: 'bullish', marketContext: MARKET_CONTEXT,
    capital: 1_000_000, riskPct: 1, price: 100,
  });

// ARMED를 지나 HOLDING까지 밀어넣는 헬퍼. 체결가는 기본 100원.
function holding({ fillPrice = 100, fillAt = T0 + 500, plan = PLAN } = {}) {
  const armed = detect(createEventState(), { plan }).state;
  return onFillConfirmed(armed, { price: fillPrice, quantity: 10, now: fillAt }).state;
}

// ---- createEventState ----

test('createEventState: IDLE로 시작하고 포지션 정보는 0이 아니라 null이다', () => {
  const s = createEventState();
  assert.equal(s.status, STATES.IDLE);
  // 없는 값을 0으로 위장하면 "진입가 0원"이 그대로 계산에 흘러든다.
  assert.equal(s.entryPrice, null);
  assert.equal(s.quantity, null);
  assert.equal(s.entryAt, null);
  assert.equal(s.plan, null);
  assert.equal(s.lastTrade, null);
});

// ---- onMaterialDetected ----

test('onMaterialDetected: IDLE에서 재료를 잡으면 ARMED가 되고 진입 지시를 낸다', () => {
  const { state, action } = detect(createEventState());
  assert.equal(state.status, STATES.ARMED);
  assert.equal(action.type, 'enter');
  assert.deepEqual(action.plan, PLAN);
  assert.deepEqual(action.event, EVENT);
  assert.deepEqual(action.material, MATERIAL);
});

test('onMaterialDetected: 실행 불가로 표시된 계획은 진입하지 않고 사유를 남긴다', () => {
  // **손으로 빚은 계획을 쓰지 않는다.** planEventTrade가 실제로 돌려주는 거절 계획은
  // takeProfitBps·stopLossBps·maxHoldSec가 전부 null이다. 유효한 숫자를 남겨둔 가짜
  // 입력으로 이 분기를 검증하면 실제 입력에서는 예외가 나는데도 테스트는 초록이다.
  const plan = realNoTradePlan();
  assert.equal(plan.executable, false);
  assert.equal(plan.takeProfitBps, null, '실제 생산자는 수치를 null로 비운다');
  assert.equal(plan.stopLossBps, null);
  assert.equal(plan.maxHoldSec, null);

  const { state, action } = detect(createEventState(), { plan });
  assert.equal(state.status, STATES.IDLE, '실행 불가 계획으로 ARMED가 되면 안 된다');
  assert.equal(action.type, 'notify');
  assert.equal(action.reason, plan.reason, '진입하지 않은 이유가 그대로 실려야 한다');
});

test('onMaterialDetected: 실제 공지 픽스처 전량을 흘려도 예외가 나지 않는다', () => {
  // 실제로 있었던 실패: 계획 검증이 모든 가드보다 먼저 실행돼, 매매하지 않기로
  // 판정된 공지(대다수)마다 RangeError가 났다. 예외는 호출자의 .catch(recordError)에
  // 삼켜져 "왜 진입하지 않았는가"가 어디에도 남지 않는다.
  const events = readFixtureEvents();
  assert.ok(events.length >= 30, `픽스처가 비었다: ${events.length}건`);

  const idle = createEventState();
  let entered = 0;
  let rejected = 0;
  for (const ev of events) {
    const m = material.classifyMaterial({
      title: ev.title, category: ev.category, source: ev.source, knownSymbols: KNOWN_SYMBOLS,
    });
    const plan = realPlanFor(m);
    const { action } = onMaterialDetected(idle, { event: ev, material: m, plan, now: T0 });
    if (action.type === 'enter') entered += 1;
    else {
      rejected += 1;
      assert.equal(typeof action.reason, 'string', `${ev.title}: 거절에는 사유가 있어야 한다`);
    }
  }
  assert.equal(entered + rejected, events.length);
  assert.ok(rejected > 0, '거절 경로가 실제 입력으로 도달해야 이 테스트가 의미 있다');
});

test('onMaterialDetected: HALTED에서는 실제 거절 계획을 받아도 던지지 않고 조용히 거절한다', () => {
  // "HALTED에서는 어떤 이벤트도 새 진입을 만들지 않는다"는 불변식은, 예외를 던져
  // HALTED 분기에 닿지도 못하는 것으로는 지켜지지 않는다.
  const halted = halt(createEventState(), '수동 중단').state;
  const { state, action } = detect(halted, { plan: realNoTradePlan() });
  assert.equal(state.status, STATES.HALTED);
  assert.equal(action.type, 'none');
  assert.match(action.reason, /중단/);
});

test('onMaterialDetected: 보유 중에 실제 거절 계획이 들어와도 던지지 않는다', () => {
  const held = holding();
  const { state, action } = detect(held, { plan: realNoTradePlan() });
  assert.equal(state.status, STATES.HOLDING);
  assert.equal(action.type, 'none');
  assert.match(action.reason, /동시 포지션/);
});

test('onMaterialDetected: 계획에 익절·손절·보유한도가 없으면 RangeError', () => {
  const s = createEventState();
  assert.throws(() => detect(s, { plan: null }), RangeError);
  assert.throws(() => detect(s, { plan: { ...PLAN, takeProfitBps: 0 } }), RangeError);
  assert.throws(() => detect(s, { plan: { ...PLAN, stopLossBps: undefined } }), RangeError);
  assert.throws(() => detect(s, { plan: { ...PLAN, maxHoldSec: NaN } }), RangeError);
});

test('onMaterialDetected: HOLDING 중 새 재료는 진입을 만들지 않는다 (동시 포지션 1개)', () => {
  const held = holding();
  const { state, action } = detect(held);
  assert.equal(state.status, STATES.HOLDING);
  assert.equal(state.event.id, EVENT.id, '보유 중인 포지션의 재료가 덮어써지면 안 된다');
  assert.equal(action.type, 'none');
  assert.match(action.reason, /동시 포지션/);
});

test('onMaterialDetected: EXITING 중 새 재료도 진입을 만들지 않는다', () => {
  const exiting = onPriceTick(holding(), { price: 104, now: T0 + 1000 }).state;
  assert.equal(exiting.status, STATES.EXITING);
  const { state, action } = detect(exiting, { event: { ...EVENT, id: 999 } });
  assert.equal(state.status, STATES.EXITING);
  assert.equal(action.type, 'none');
  assert.match(action.reason, /동시 포지션/);
});

test('onMaterialDetected: ARMED 중 새 재료도 차단된다 (진입 지시가 이미 나가 있다)', () => {
  const armed = detect(createEventState()).state;
  const { state, action } = detect(armed, { event: { ...EVENT, id: 999 } });
  assert.equal(state.status, STATES.ARMED);
  assert.equal(state.event.id, EVENT.id);
  assert.equal(action.type, 'none');
});

test('onMaterialDetected: HALTED에서는 어떤 재료도 새 진입을 만들지 않는다', () => {
  const halted = halt(createEventState(), '수동 중단').state;
  const { state, action } = detect(halted);
  assert.equal(state.status, STATES.HALTED);
  assert.equal(action.type, 'none');
  assert.match(action.reason, /중단/);
});

test('onMaterialDetected: 원본 상태를 변경하지 않는다', () => {
  const s = createEventState();
  const before = JSON.stringify(s);
  const { state } = detect(s);
  assert.equal(JSON.stringify(s), before);
  assert.notEqual(state, s);
});

// ---- onFillConfirmed ----

test('onFillConfirmed: ARMED에서 체결되면 HOLDING이 되고 모니터링이 시작된다', () => {
  const armed = detect(createEventState()).state;
  const { state, action } = onFillConfirmed(armed, { price: 100, quantity: 10, now: T0 + 500 });
  assert.equal(state.status, STATES.HOLDING);
  assert.equal(state.entryPrice, 100);
  assert.equal(state.quantity, 10);
  assert.equal(state.entryAt, T0 + 500);
  assert.equal(action.type, 'notify');
});

test('onFillConfirmed: 청산선은 계획가가 아니라 **실제 체결가** 기준으로 다시 계산한다', () => {
  // 재료 매매는 슬리피지가 크다. 계획가로 청산선을 고정하면 실제 손절폭이
  // 의도보다 넓어지거나 좁아진 채로 굳는다.
  const armed = detect(createEventState()).state;
  const { state } = onFillConfirmed(armed, { price: 110, quantity: 10, now: T0 + 500 });
  near(state.takeProfitPrice, 110 * 1.03, '익절선');
  near(state.stopLossPrice, 110 * 0.985, '손절선');
});

test('onFillConfirmed: 보유 마감 시각을 체결 시각 기준으로 계산한다', () => {
  const { state } = onFillConfirmed(detect(createEventState()).state, {
    price: 100, quantity: 10, now: T0 + 500,
  });
  assert.equal(state.deadlineAt, T0 + 500 + 60 * 1000);
});

test('onFillConfirmed: ARMED가 아닌 상태의 체결 확인은 무시된다', () => {
  const idle = createEventState();
  const { state, action } = onFillConfirmed(idle, { price: 100, quantity: 10, now: T0 });
  assert.equal(state.status, STATES.IDLE);
  assert.equal(state.entryPrice, null);
  assert.equal(action.type, 'none');
});

test('onFillConfirmed: 시각을 ISO 문자열로 줘도 동일하게 계산한다', () => {
  const iso = new Date(T0 + 500).toISOString();
  const { state } = onFillConfirmed(detect(createEventState()).state, {
    price: 100, quantity: 10, now: iso,
  });
  assert.equal(state.entryAt, T0 + 500);
  assert.equal(state.deadlineAt, T0 + 500 + 60_000);
});

// ---- onPriceTick: 청산 판정 세 가지 ----

test('onPriceTick: 익절선에 닿으면 시장가 청산 지시를 낸다', () => {
  const { state, action } = onPriceTick(holding(), { price: 103, now: T0 + 1000 });
  assert.equal(state.status, STATES.EXITING);
  assert.equal(state.exitReason, 'take_profit');
  assert.equal(action.type, 'exit');
  assert.equal(action.reason, 'take_profit');
  assert.equal(action.orderType, 'market', '재료 매매의 청산은 지정가로 기다리지 않는다');
  assert.equal(action.quantity, 10);
});

test('onPriceTick: 손절선에 닿으면 시장가 청산 지시를 낸다', () => {
  const { state, action } = onPriceTick(holding(), { price: 98.4, now: T0 + 1000 });
  assert.equal(state.status, STATES.EXITING);
  assert.equal(action.type, 'exit');
  assert.equal(action.reason, 'stop_loss');
  assert.equal(action.orderType, 'market');
});

test('onPriceTick: 보유 한도를 넘기면 시간초과로 청산한다', () => {
  const held = holding({ fillAt: T0 });
  const { state, action } = onPriceTick(held, { price: 100.5, now: T0 + 60_000 });
  assert.equal(state.status, STATES.EXITING);
  assert.equal(action.reason, 'timeout');
  assert.equal(action.orderType, 'market');
});

test('onPriceTick: 시간초과는 마감 시각 경계에서 발동한다 (그 직전에는 아니다)', () => {
  const held = holding({ fillAt: T0 });
  const before = onPriceTick(held, { price: 100.5, now: T0 + 59_999 });
  assert.equal(before.state.status, STATES.HOLDING);
  const at = onPriceTick(held, { price: 100.5, now: T0 + 60_000 });
  assert.equal(at.state.status, STATES.EXITING);
});

test('onPriceTick: 호가가 비어 가격을 몰라도 시간초과 청산은 나간다', () => {
  // 상장 공지로 잡은 코인은 매수호가가 비어 book.bid가 0이 되는 일이 흔하다.
  // 시간초과는 명세상 시각만의 함수인데, 가격 검증이 먼저 던지면 그 틱이 통째로
  // 사라지고 포지션은 마감 시각을 한참 넘겨도 영원히 빠져나오지 못한다.
  const held = holding({ fillAt: T0 });
  for (const price of [0, null, undefined, NaN, -1]) {
    const { state, action } = onPriceTick(held, { price, now: T0 + 60_000 + 9 * 60_000 });
    assert.equal(state.status, STATES.EXITING, `price=${price}에서 탈출하지 못했다`);
    assert.equal(action.type, 'exit');
    assert.equal(action.reason, 'timeout');
    assert.equal(action.orderType, 'market');
    assert.equal(action.quantity, 10, '수량은 잃지 않아야 청산 주문을 낼 수 있다');
    // 모르는 가격을 0으로 위장하지 않는다.
    assert.equal(action.price, null);
  }
});

test('onPriceTick: 가격이 유효하지 않고 시간도 남았으면 HOLDING을 유지하고 오염시키지 않는다', () => {
  const held = holding({ fillAt: T0 });
  const { state, action } = onPriceTick(held, { price: 0, now: T0 + 1000 });
  assert.equal(state.status, STATES.HOLDING);
  assert.equal(action.type, 'none');
  assert.match(action.reason, /가격/);
  assert.equal(state.lastPrice, 100, '유효하지 않은 가격이 마지막 가격을 덮으면 안 된다');
});

test('onPriceTick: low가 null이면 시장이 닿은 적 없는 가격에 손절을 내지 않는다', () => {
  // null <= 98.5 는 0 <= 98.5 로 참이 된다. 익절 방향으로 오른 틱에서 손절이 나갔다.
  const held = holding();
  const { state, action } = onPriceTick(held, { price: 101, low: null, high: null, now: T0 + 1000 });
  assert.equal(state.status, STATES.HOLDING, `${action.reason ?? action.type}`);
  assert.equal(action.type, 'none');
});

test('onPriceTick: 유효하지 않은 low/high는 무시하고 price로 대신한다', () => {
  const held = holding();
  for (const bad of [null, 0, -5, NaN, '98', {}]) {
    const r = onPriceTick(held, { price: 101, low: bad, high: bad, now: T0 + 1000 });
    assert.equal(r.state.status, STATES.HOLDING, `low/high=${JSON.stringify(bad)}`);
    assert.equal(r.action.type, 'none');
  }
});

test('onPriceTick: 유효한 low/high는 그대로 쓴다', () => {
  const held = holding();
  const lowHit = onPriceTick(held, { price: 101, low: 98, high: 101, now: T0 + 1000 });
  assert.equal(lowHit.action.reason, 'stop_loss', '봉의 저가가 손절선을 지났다');
  const highHit = onPriceTick(held, { price: 101, low: 99, high: 104, now: T0 + 1000 });
  assert.equal(highHit.action.reason, 'take_profit');
});

test('onPriceTick: 모순된 봉값이 와도 현재가가 지난 범위를 좁히지 못한다', () => {
  // 봉값과 현재가는 다른 요청에서 오거나 다른 시각을 가리킬 수 있어, 저가가 현재가보다
  // **높은** 모순된 봉이 실제로 온다. 봉값을 그대로 믿으면(min/max 래퍼 없이)
  // 현재가가 이미 손절선을 지났는데도 "저가가 아직 안 닿았다"며 포지션을 들고 있게 된다.
  // 청산 규칙은 현재가와 봉값 중 **더 나쁜 쪽**을 봐야 한다 — 둘 중 하나라도
  // 선을 지났으면 시장은 그 가격을 지난 것이다.
  const held = holding(); // 손절선 98.5, 익절선 103

  // ① 저가(99)가 현재가(98)보다 높은 모순 봉. Math.min이 없으면 lowest=99라 손절이 안 나간다.
  const lowContradicts = onPriceTick(held, { price: 98, low: 99, now: T0 + 1000 });
  assert.equal(lowContradicts.state.status, STATES.EXITING,
    '현재가 98이 손절선 98.5를 지났는데 봉의 저가 99에 가려 빠져나오지 못했다');
  assert.equal(lowContradicts.action.reason, 'stop_loss');

  // ② 대칭. 고가(102)가 현재가(104)보다 낮은 모순 봉. Math.max가 없으면 highest=102라
  //    익절선 103에 닿지 못한 것으로 읽힌다.
  const highContradicts = onPriceTick(held, { price: 104, high: 102, now: T0 + 1000 });
  assert.equal(highContradicts.state.status, STATES.EXITING,
    '현재가 104가 익절선 103을 지났는데 봉의 고가 102에 가려 실현하지 못했다');
  assert.equal(highContradicts.action.reason, 'take_profit');
});

test('onPriceTick: 같은 틱에서 익절·손절이 동시에 충족되면 손절을 택한다', () => {
  // 틱 하나로는 어느 쪽이 먼저였는지 알 수 없다. 익절을 택하면 성과가 조직적으로
  // 부풀려지고, 그 순간 백테스트(bracket-backtest.js)와 실전이 어긋난다.
  const held = holding({ fillPrice: 100 });
  // 손절선 98.5 이하이면서 익절선 103 이상 — 하나의 틱으로는 불가능하지만,
  // 호출자가 봉의 고가/저가를 함께 넘기는 경우를 가정한 방어 규칙이다.
  const { state, action } = onPriceTick(held, { price: 98, high: 105, now: T0 + 1000 });
  assert.equal(state.exitReason, 'stop_loss', '동시 충족이면 보수적인 쪽');
  assert.equal(action.reason, 'stop_loss');
});

test('onPriceTick: 조건에 닿지 않으면 HOLDING을 유지하고 마지막 가격만 갱신한다', () => {
  const held = holding();
  const { state, action } = onPriceTick(held, { price: 101, now: T0 + 1000 });
  assert.equal(state.status, STATES.HOLDING);
  assert.equal(state.lastPrice, 101);
  assert.equal(state.lastTickAt, T0 + 1000);
  assert.equal(action.type, 'none');
});

test('onPriceTick: IDLE 상태의 가격 틱은 아무 일도 하지 않는다', () => {
  const idle = createEventState();
  const { state, action } = onPriceTick(idle, { price: 999999, now: T0 });
  assert.equal(state, idle, '아무 일도 하지 않았으므로 같은 상태 객체여야 한다');
  assert.equal(action.type, 'none');
});

test('onPriceTick: ARMED(미체결) 상태의 틱도 청산 지시를 내지 않는다', () => {
  const armed = detect(createEventState()).state;
  const { state, action } = onPriceTick(armed, { price: 1, now: T0 + 1000 });
  assert.equal(state.status, STATES.ARMED);
  assert.equal(action.type, 'none');
});

test('onPriceTick: 이미 EXITING이면 두 번째 청산 지시가 나가지 않는다', () => {
  const exiting = onPriceTick(holding(), { price: 98, now: T0 + 1000 }).state;
  assert.equal(exiting.status, STATES.EXITING);
  const again = onPriceTick(exiting, { price: 90, now: T0 + 2000 });
  assert.equal(again.action.type, 'none', '이중 청산은 포지션을 뒤집는다');
  assert.equal(again.state.status, STATES.EXITING);
});

test('onPriceTick: HALTED 상태의 틱도 무시된다', () => {
  const halted = halt(holding(), '거래소 장애').state;
  const { action } = onPriceTick(halted, { price: 1, now: T0 + 1000 });
  assert.equal(action.type, 'none');
});

test('onPriceTick: 원본 상태를 변경하지 않는다', () => {
  const held = holding();
  const before = JSON.stringify(held);
  const { state } = onPriceTick(held, { price: 98, now: T0 + 1000 });
  assert.equal(JSON.stringify(held), before, '원본은 HOLDING 그대로여야 한다');
  assert.notEqual(state, held);
});

// ---- onExitConfirmed ----

test('onExitConfirmed: EXITING에서 확인되면 IDLE로 돌아가고 결과를 기록한다', () => {
  const exiting = onPriceTick(holding(), { price: 103, now: T0 + 1000 }).state;
  const { state, action } = onExitConfirmed(exiting, { price: 103, now: T0 + 1200 });
  assert.equal(state.status, STATES.IDLE);
  assert.equal(state.entryPrice, null, '포지션 정보는 비워야 다음 재료를 받을 수 있다');
  assert.equal(state.lastTrade.reason, 'take_profit');
  near(state.lastTrade.pnlBps, 300);
  assert.equal(action.type, 'notify');
});

test('onExitConfirmed: 손실 청산이면 pnlBps가 음수다', () => {
  const exiting = onPriceTick(holding(), { price: 98, now: T0 + 1000 }).state;
  const { state } = onExitConfirmed(exiting, { price: 98, now: T0 + 1200 });
  assert.ok(state.lastTrade.pnlBps < 0, `pnlBps ${state.lastTrade.pnlBps}`);
  near(state.lastTrade.pnlBps, -200);
});

test('onExitConfirmed: 비용을 모르면 순손익을 0으로 위장하지 않고 null로 둔다', () => {
  const plan = { takeProfitBps: 300, stopLossBps: 150, maxHoldSec: 60 }; // costBps 없음
  const exiting = onPriceTick(holding({ plan }), { price: 103, now: T0 + 1000 }).state;
  const { state } = onExitConfirmed(exiting, { price: 103, now: T0 + 1200 });
  assert.equal(state.lastTrade.netPnlBps, null);

  const withCost = onExitConfirmed(
    onPriceTick(holding(), { price: 103, now: T0 + 1000 }).state,
    { price: 103, now: T0 + 1200 }
  );
  near(withCost.state.lastTrade.netPnlBps, 300 - 28);
});

test('onExitConfirmed: 내지도 않은 청산의 확인은 무시된다 (HOLDING 유지)', () => {
  const held = holding();
  const { state, action } = onExitConfirmed(held, { price: 103, now: T0 + 1200 });
  assert.equal(state.status, STATES.HOLDING);
  assert.equal(action.type, 'none');
});

test('onExitConfirmed: 청산 후에는 다음 재료로 다시 진입할 수 있다', () => {
  const exiting = onPriceTick(holding(), { price: 103, now: T0 + 1000 }).state;
  const flat = onExitConfirmed(exiting, { price: 103, now: T0 + 1200 }).state;
  const { state, action } = detect(flat, { event: { ...EVENT, id: 777 }, now: T0 + 5000 });
  assert.equal(state.status, STATES.ARMED);
  assert.equal(action.type, 'enter');
});

// ---- onExitFailed ----
//
// 청산 **지시**와 청산 **주문 성공**은 다른 사건이다. 이 구분이 없으면 주문이
// 거절당한 순간 상태 기계는 "이미 나갔다"고 믿고, 포지션은 아무도 보지 않는다.

test('onExitFailed: EXITING에서 청산 주문이 실패하면 HOLDING으로 되돌려 다음 틱이 재시도한다', () => {
  const exiting = onPriceTick(holding(), { price: 98, now: T0 + 1000 }).state;
  const { state, action } = onExitFailed(exiting, { reason: '거래소 5xx', now: T0 + 1100 });

  assert.equal(state.status, STATES.HOLDING, '재시도할 수 있는 상태로 돌아와야 한다');
  assert.equal(state.entryPrice, 100, '포지션 정보를 잃으면 청산할 수량조차 모른다');
  assert.equal(state.quantity, 10);
  assert.equal(state.exitReason, null, '나가지 않은 청산이 나간 것으로 남으면 안 된다');
  assert.equal(state.exitOrderedAt, null);
  assert.match(String(state.lastExitError), /5xx/, '실패 사유는 남긴다');
  assert.notEqual(action.type, 'none');

  // 그리고 실제로 다음 틱이 다시 청산 지시를 낸다.
  const retry = onPriceTick(state, { price: 98, now: T0 + 2000 });
  assert.equal(retry.action.type, 'exit');
  assert.equal(retry.action.reason, 'stop_loss');
  assert.equal(retry.action.quantity, 10);
});

test('onExitFailed: 마감 시각을 넘긴 뒤 실패해도 다음 틱이 시간초과로 다시 나간다', () => {
  const held = holding({ fillAt: T0 });
  const exiting = onPriceTick(held, { price: 100.5, now: T0 + 60_000 }).state;
  const back = onExitFailed(exiting, { reason: '주문 거절', now: T0 + 60_100 }).state;
  const retry = onPriceTick(back, { price: 100.5, now: T0 + 61_000 });
  assert.equal(retry.action.type, 'exit');
  assert.equal(retry.action.reason, 'timeout');
});

test('onExitFailed: HALTED로 굳은 포지션은 수량을 든 채 침묵하지 않는다', () => {
  // 저장소의 유일한 halt 호출처가 정확히 "청산 주문이 나가지 못했을 때"다.
  // 그 경로에서 아무 지시도 나오지 않으면 포지션은 영구 고아가 된다.
  const exiting = onPriceTick(holding(), { price: 98, now: T0 + 1000 }).state;
  const halted = halt(exiting, '청산 실패').state;
  const { state, action } = onExitFailed(halted, { reason: '청산 실패', now: T0 + 1200 });

  assert.equal(state.status, STATES.HALTED, '중단은 사람이 풀어야 한다');
  assert.equal(state.quantity, 10, '포지션 정보를 잃으면 사람도 손쓸 수 없다');
  assert.equal(state.entryPrice, 100);
  assert.equal(action.needsManualIntervention, true);
  assert.equal(action.quantity, 10);
  assert.equal(action.entryPrice, 100);
});

// ---- 가격을 모르는 채 나온 청산 ----
//
// onPriceTick은 가격을 모르면 `price: null`을 실어 시간초과 청산을 지시한다
// (호가가 통째로 빈 종목에서 나올 수 없게 되는 것을 막으려고 그렇게 만들었다).
// 그런데 그 지시를 받아 청산한 뒤 확인을 넣을 자리가 없으면, 상태 기계는
// EXITING에 굳고 포지션은 아무도 보지 않는다 — 막으려던 바로 그 상태다.

test('onExitConfirmed: 체결가를 모르면 null로 받되 손익을 지어내지 않는다', () => {
  // holding()은 T0+500에 체결되고 PLAN.maxHoldSec는 60초다 → 마감 T0+60,500.
  const exiting = onPriceTick(holding(), { price: undefined, now: T0 + 61_000 }).state;
  assert.equal(exiting.status, STATES.EXITING, '먼저 가격 없는 청산이 지시됐는지 확인');

  const { state, action } = onExitConfirmed(exiting, { price: null, now: T0 + 61_100 });
  assert.equal(state.status, STATES.IDLE, '확인을 못 받으면 EXITING에 굳는다');
  assert.equal(state.quantity, null, '포지션이 정리돼야 한다');
  assert.equal(state.lastTrade.exitPrice, null, '모르는 체결가를 지어내면 기록이 거짓이 된다');
  assert.equal(state.lastTrade.pnlBps, null, '가격을 모르는데 손익을 계산할 수는 없다');
  assert.equal(action.type, 'notify');
});

test('onExitConfirmed: 0이나 음수는 여전히 거부한다', () => {
  // null은 "모른다"이고 0은 "0원에 체결됐다"는 확정된 거짓이다. 둘을 같이 받으면
  // -100% 손익이 기록에 남아 복기와 롤백 판정을 오염시킨다.
  const exiting = onPriceTick(holding(), { price: 98, now: T0 + 1000 }).state;
  for (const bad of [0, -1, NaN, '98']) {
    assert.throws(() => onExitConfirmed(exiting, { price: bad, now: T0 + 1100 }), RangeError, String(bad));
  }
});

// ---- 재시도가 끝나지 않을 때 ----
//
// 재시도를 멈추면 안 된다 — 포지션은 반드시 나와야 하고, 멈추는 순간 고아가 된다.
// 그러나 거래소가 계속 거절하면 무한히 조용히 돌기만 하는 것도 같은 결과다.
// 그래서 **재시도는 영원히 계속하되, 몇 번 실패한 뒤에는 사람을 부른다.**

test('onExitFailed: 반복 실패를 센다', () => {
  let s = onPriceTick(holding(), { price: 98, now: T0 + 1000 }).state;
  s = onExitFailed(s, { reason: '거래소 5xx', now: T0 + 1100 }).state;
  assert.equal(s.exitFailCount, 1);
  s = onPriceTick(s, { price: 98, now: T0 + 2000 }).state;
  s = onExitFailed(s, { reason: '거래소 5xx', now: T0 + 2100 }).state;
  assert.equal(s.exitFailCount, 2);
});

// 실패를 n회 반복시키고 마지막 액션을 돌려준다.
function failExitTimes(n) {
  let s = holding();
  let action = null;
  for (let i = 0; i < n; i += 1) {
    s = onPriceTick(s, { price: 98, now: T0 + 1000 * (i + 1) }).state;
    assert.equal(s.status, STATES.EXITING, `${i + 1}번째 재시도 지시가 나와야 한다`);
    const r = onExitFailed(s, { reason: '거래소 5xx', now: T0 + 1000 * (i + 1) + 50 });
    action = r.action;
    s = r.state;
  }
  return { s, action };
}

test('onExitFailed: 3회 연속 실패하면 사람을 부르되 재시도는 계속한다', () => {
  // **횟수를 리터럴로 박는다.** MAX_EXIT_RETRIES로 루프를 돌리면 상수를 바꿔도
  // 테스트가 따라 움직여 절대 실패하지 않는 자기참조가 된다 — 이 저장소는
  // STALE_MARKERS에서 정확히 같은 사고를 겪었다.
  const { s, action } = failExitTimes(3);
  assert.equal(action.needsManualIntervention, true, '3번 연속 실패했는데 아무도 부르지 않는다');
  assert.equal(action.failCount, 3, '알림 문구가 "청산 undefined회 연속 실패"로 나간다');
  assert.equal(action.reason, 'exit_retry_exhausted');
  assert.equal(action.quantity, 10, '사람이 손으로 청산하려면 수량이 필요하다');
  assert.equal(action.entryPrice, 100);
  assert.equal(s.status, STATES.HOLDING, '재시도를 포기하면 포지션이 고아가 된다');
  assert.equal(onPriceTick(s, { price: 98, now: T0 + 99_000 }).action.type, 'exit');
});

test('onExitFailed: 2회까지는 사람을 부르지 않는다', () => {
  // 일시적 5xx 한 번에 사람을 깨우면 그 알림은 곧 무시된다.
  // 경계 양쪽을 붙여야 상한 자체가 고정된다.
  for (const n of [1, 2]) {
    const { action } = failExitTimes(n);
    assert.notEqual(action.needsManualIntervention, true, `${n}회에서 불렀다`);
    assert.equal(action.reason, 'exit_retry');
    assert.equal(action.failCount, n);
  }
});

test('onExitConfirmed: 청산에 성공하면 실패 횟수를 지운다', () => {
  // 지우지 않으면 다음 포지션이 앞선 실패를 물려받아 첫 실패에 사람을 부른다.
  let s = onPriceTick(holding(), { price: 98, now: T0 + 1000 }).state;
  s = onExitFailed(s, { reason: '거래소 5xx', now: T0 + 1100 }).state;
  assert.equal(s.exitFailCount, 1);
  s = onPriceTick(s, { price: 98, now: T0 + 2000 }).state;
  s = onExitConfirmed(s, { price: 98, now: T0 + 2100 }).state;
  assert.equal(s.exitFailCount, 0);
});

test('createEventState: 실패 횟수는 0에서 시작한다', () => {
  assert.equal(createEventState().exitFailCount, 0);
});

test('MAX_EXIT_RETRIES: 값 자체를 고정한다', () => {
  // 위 두 테스트가 리터럴 3을 쓰므로 상수도 3으로 못박아 둘이 어긋나지 않게 한다.
  assert.equal(MAX_EXIT_RETRIES, 3);
});

test('onExitFailed: 청산을 내지도 않은 상태에서는 아무 일도 하지 않는다', () => {
  for (const s of [createEventState(), holding(), detect(createEventState()).state]) {
    const { state, action } = onExitFailed(s, { reason: '오호출', now: T0 + 1000 });
    assert.equal(state, s, '아무 일도 하지 않았으므로 같은 상태 객체여야 한다');
    assert.equal(action.type, 'none');
  }
});

test('onExitFailed: 원본 상태를 변경하지 않는다', () => {
  const exiting = onPriceTick(holding(), { price: 98, now: T0 + 1000 }).state;
  const before = JSON.stringify(exiting);
  onExitFailed(exiting, { reason: '거래소 5xx', now: T0 + 1100 });
  assert.equal(JSON.stringify(exiting), before);
});

// ---- halt ----

test('halt: HOLDING 중 중단하면 포지션을 방치하지 않도록 청산 지시를 낸다', () => {
  // HALTED에서는 틱을 무시하므로, 포지션을 든 채 멈추면 아무도 보지 않는
  // 포지션이 남는다. 그게 이 프로젝트에서 가장 비싼 실패다.
  const { state, action } = halt(holding(), '거래소 장애');
  assert.equal(state.status, STATES.HALTED);
  assert.equal(action.type, 'exit');
  assert.equal(action.reason, 'halt');
  assert.equal(action.orderType, 'market');
});

test('halt: 이미 EXITING이면 중단해도 이중 청산 지시를 내지 않는다', () => {
  const exiting = onPriceTick(holding(), { price: 98, now: T0 + 1000 }).state;
  const { state, action } = halt(exiting, '거래소 장애');
  assert.equal(state.status, STATES.HALTED);
  assert.notEqual(action.type, 'exit', '이중 청산은 포지션을 뒤집는다');
});

test('halt: EXITING을 중단하면 수량을 든 채 침묵하지 않고 사람을 부른다', () => {
  // HALTED에서는 틱을 판정하지 않으므로, 여기서 'none'을 돌려주면 포지션은
  // 아무 지시도 없이 갇힌다. 되돌아갈 경로가 없으니 최소한 알리기라도 해야 한다.
  const exiting = onPriceTick(holding(), { price: 98, now: T0 + 1000 }).state;
  const { state, action } = halt(exiting, '청산 실패');
  assert.equal(state.quantity, 10, '포지션 정보는 보존된다');
  assert.equal(state.entryPrice, 100);
  assert.equal(action.needsManualIntervention, true);
  assert.equal(action.quantity, 10, '사람이 손으로 청산하려면 수량을 알아야 한다');
  assert.equal(action.entryPrice, 100);
});

test('halt: IDLE에서 중단하면 청산할 것이 없다', () => {
  const { state, action } = halt(createEventState(), '점검');
  assert.equal(state.status, STATES.HALTED);
  assert.equal(state.haltReason, '점검');
  assert.notEqual(action.type, 'exit');
});

test('halt: 중단 상태에서 청산이 확인되어도 IDLE로 자동 복귀하지 않는다', () => {
  const { state: halted } = halt(holding(), '거래소 장애');
  const { state } = onExitConfirmed(halted, { price: 99, now: T0 + 2000 });
  assert.equal(state.status, STATES.HALTED, '중단은 사람이 풀어야 한다');
  assert.equal(state.entryPrice, null, '포지션은 비워졌다');
  assert.ok(state.lastTrade, '결과는 기록된다');
});

test('halt: 두 번 중단해도 최초 사유를 보존한다', () => {
  const first = halt(createEventState(), '거래소 장애').state;
  const { state, action } = halt(first, '수동 중단');
  assert.equal(state.haltReason, '거래소 장애', '원인 추적은 최초 사유가 중요하다');
  assert.equal(action.type, 'none');
});
