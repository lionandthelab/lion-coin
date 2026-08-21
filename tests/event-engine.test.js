const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  STATES,
  createEventState,
  onMaterialDetected,
  onPriceTick,
  onFillConfirmed,
  onExitConfirmed,
  halt,
} = require('../src/event-engine');

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
  // planBracket이 executable:false를 돌려준 계획 — 최소 주문금액 미달 등.
  const plan = { ...PLAN, executable: false, reason: '주문 명목이 최소 주문금액 미만입니다.' };
  const { state, action } = detect(createEventState(), { plan });
  assert.equal(state.status, STATES.IDLE, '실행 불가 계획으로 ARMED가 되면 안 된다');
  assert.equal(action.type, 'notify');
  assert.match(action.reason, /최소 주문금액/);
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
  assert.equal(action.type, 'none');
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
