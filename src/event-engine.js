'use strict';

// 이벤트 매매 상태 기계 — 순수 전이 함수. 네트워크·주문 전송은 이 파일에 두지 않는다.
//
// 유목민식 단타는 "재료를 잡고 → 들어가고 → 보유하는 동안 눈을 떼지 않고 →
// 조건이 닿으면 즉시 시장가로 나온다"가 전부다. 이 모듈은 그 중 **판단**만 맡는다.
// 호출자가 상태와 관측값을 넘기면 "무엇을 해야 하는지"(action)를 돌려주고,
// 실제 주문은 호출자가 낸다.
//
// 이렇게 쪼갠 이유: 청산 규칙은 **재현 가능해야** 한다. 주문 코드와 붙어 있으면
// 거래소를 띄우지 않고는 규칙을 검증할 수 없고, 검증할 수 없는 청산 규칙은
// 실전에서 처음 시험받는다. 이 판에서 그건 가장 비싼 방식이다.
//
// 상태는 다섯뿐이고, 전이 규칙 자체가 안전장치다:
//   IDLE    — 재료 대기
//   ARMED   — 재료 포착, 진입 지시를 냈고 체결을 기다린다
//   HOLDING — 보유 중. 이 상태에서만 틱을 판정한다 (모니터링 모드)
//   EXITING — 청산 주문을 냈고 체결을 기다린다. 여기서 또 청산을 내면 포지션이 뒤집힌다
//   HALTED  — 중단. 어떤 재료도 새 진입을 만들지 못한다

const STATES = {
  IDLE: 'IDLE',
  ARMED: 'ARMED',
  HOLDING: 'HOLDING',
  EXITING: 'EXITING',
  HALTED: 'HALTED',
};

// 포지션을 이미 쥐고 있거나 쥐려는 중인 상태들. 동시 포지션 1개 규칙의 기준이다.
const ENGAGED = new Set([STATES.ARMED, STATES.HOLDING, STATES.EXITING]);

const none = (reason) => ({ type: 'none', reason });

// 시각은 epoch ms로 다룬다. 다만 이 저장소의 다른 모듈은 ISO 문자열을 쓰므로
// 둘 다 받아 정규화한다 — 문자열과 숫자가 섞여 뺄셈이 NaN이 되면 시간초과 청산이
// 조용히 영원히 발동하지 않는다. 그 실패는 로그에도 남지 않는다.
function toEpochMs(value, name) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (value instanceof Date && Number.isFinite(value.getTime())) return value.getTime();
  if (typeof value === 'string') {
    const t = Date.parse(value);
    if (Number.isFinite(t)) return t;
  }
  throw new RangeError(`${name}은(는) epoch ms 또는 ISO 시각이어야 합니다: ${JSON.stringify(value)}`);
}

function assertPositive(value, name) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${name}은(는) 양의 유한수여야 합니다: ${value}`);
  }
}

// 계획의 구조적 결함(누락·NaN)은 호출자의 버그이므로 던진다. 반면 "실행 불가"는
// 정상적인 판단 결과이므로 던지지 않고 진입을 거절한다 — 둘은 다른 사건이다.
function assertPlan(plan) {
  if (!plan || typeof plan !== 'object') {
    throw new RangeError(`plan은 객체여야 합니다: ${JSON.stringify(plan)}`);
  }
  assertPositive(plan.takeProfitBps, 'plan.takeProfitBps');
  assertPositive(plan.stopLossBps, 'plan.stopLossBps');
  assertPositive(plan.maxHoldSec, 'plan.maxHoldSec');
}

function createEventState() {
  return {
    status: STATES.IDLE,
    event: null,
    material: null,
    plan: null,
    // 값이 없을 때 0으로 위장하지 않는다. "진입가 0원"이 계산에 흘러들면
    // 손절선도 0이 되어 어떤 가격에서도 청산이 발동하지 않는다.
    entryPrice: null,
    quantity: null,
    entryAt: null,
    deadlineAt: null,
    takeProfitPrice: null,
    stopLossPrice: null,
    lastPrice: null,
    lastTickAt: null,
    exitReason: null,
    exitOrderedAt: null, // EXITING이 응답 없이 굳는 것을 호출자가 감시할 수 있도록 남긴다
    haltReason: null,
    lastTrade: null,
  };
}

// 포지션 관련 필드만 초기화한다. haltReason·lastTrade는 보존한다.
function flatten(state, lastTrade) {
  const fresh = createEventState();
  return {
    ...fresh,
    status: state.status,
    haltReason: state.haltReason,
    lastTrade: lastTrade === undefined ? state.lastTrade : lastTrade,
  };
}

// 재료 포착. 진입할 수 있는 상태는 IDLE뿐이다.
function onMaterialDetected(state, { event = null, material = null, plan, now } = {}) {
  assertPlan(plan);

  if (state.status === STATES.HALTED) {
    return { state, action: none(`중단 상태입니다(${state.haltReason ?? '사유 없음'}) — 새 진입을 만들지 않습니다`) };
  }

  if (ENGAGED.has(state.status)) {
    // ARMED도 막는다. 진입 지시가 이미 나가 체결을 기다리는 중이라, 여기서 새
    // 재료를 받으면 같은 계좌로 두 건이 체결될 수 있다.
    return {
      state,
      action: none(
        `동시 포지션은 1개입니다 — 현재 ${state.status} 상태라 새 재료로 진입하지 않습니다`
      ),
    };
  }

  // planBracket이 실행 불가로 판정한 계획은 그대로 거절한다. 불가능한 주문을
  // "일단 내보고 나중에 보는" 것이 이 판에서 가장 비싼 실수다(bracket.js와 같은 판단).
  if (plan.executable === false) {
    return {
      state,
      action: { type: 'notify', reason: plan.reason ?? '실행 불가로 표시된 계획입니다', event, material },
    };
  }

  const armedAt = now === undefined ? null : toEpochMs(now, 'now');

  return {
    state: { ...state, status: STATES.ARMED, event, material, plan, armedAt },
    action: { type: 'enter', reason: 'material_detected', event, material, plan },
  };
}

// 진입 체결 확인. 여기서 비로소 모니터링(HOLDING)이 시작된다.
function onFillConfirmed(state, { price, quantity = null, now } = {}) {
  if (state.status !== STATES.ARMED) {
    return { state, action: none(`ARMED가 아닌 ${state.status} 상태의 체결 확인은 무시합니다`) };
  }
  assertPositive(price, 'price');
  const entryAt = toEpochMs(now, 'now');

  // 청산선은 **계획가가 아니라 실제 체결가** 기준으로 다시 계산한다.
  // 재료 매매는 슬리피지가 크다. 계획가로 고정하면 의도한 손절폭과 실제 손절폭이
  // 어긋난 채로 굳고, 위험 관리는 그 어긋난 값 위에서 돌아간다.
  const { takeProfitBps, stopLossBps, maxHoldSec } = state.plan;

  return {
    state: {
      ...state,
      status: STATES.HOLDING,
      entryPrice: price,
      quantity,
      entryAt,
      deadlineAt: entryAt + maxHoldSec * 1000,
      takeProfitPrice: price * (1 + takeProfitBps / 10000),
      stopLossPrice: price * (1 - stopLossBps / 10000),
      lastPrice: price,
      lastTickAt: entryAt,
    },
    action: { type: 'notify', reason: 'entry_filled', price, quantity },
  };
}

// 모니터링 모드의 핵심. HOLDING에서만 판정하고, 세 조건 중 하나라도 닿으면
// 즉시 시장가 청산을 지시한다.
//
// low/high를 함께 받는 이유: 호출자가 봉(캔들) 단위로 폴링하면 한 틱 안에
// 익절선과 손절선이 모두 지나갔을 수 있다. 없으면 price로 대신한다.
function onPriceTick(state, { price, low, high, now } = {}) {
  if (state.status !== STATES.HOLDING) {
    // 아무 일도 하지 않았다는 것을 참조 동일성으로 드러낸다.
    // 특히 EXITING에서 여기로 들어오는 틱을 흘려보내는 것이 이중 청산 방지다.
    return { state, action: none(`${state.status} 상태의 틱은 판정하지 않습니다`) };
  }
  assertPositive(price, 'price');
  const at = toEpochMs(now, 'now');

  const lowest = low === undefined ? price : low;
  const highest = high === undefined ? price : high;

  const hitStop = lowest <= state.stopLossPrice;
  const hitTarget = highest >= state.takeProfitPrice;
  const expired = at >= state.deadlineAt;

  // **손절 우선.** 하나의 틱(또는 봉)만으로는 어느 쪽이 먼저였는지 알 수 없다.
  // 익절을 먼저라고 가정하면 성과가 조직적으로 부풀려지고, 그 순간 실전이
  // bracket-backtest.js의 가정과 어긋난다. 보수적인 쪽이 덜 틀린다.
  let reason = null;
  if (hitStop) reason = 'stop_loss';
  else if (hitTarget) reason = 'take_profit';
  else if (expired) reason = 'timeout';

  if (reason === null) {
    return {
      state: { ...state, lastPrice: price, lastTickAt: at },
      action: none('청산 조건에 닿지 않았습니다'),
    };
  }

  return {
    state: {
      ...state,
      status: STATES.EXITING,
      lastPrice: price,
      lastTickAt: at,
      exitReason: reason,
      exitOrderedAt: at,
    },
    action: {
      type: 'exit',
      reason,
      // 재료 매매의 청산은 지정가로 기다리지 않는다. 재료가 꺼질 때의 호가는
      // 몇 초 만에 사라지고, 못 나온 포지션 하나가 이긴 거래 여러 건을 지운다.
      orderType: 'market',
      price,
      quantity: state.quantity,
      entryPrice: state.entryPrice,
      event: state.event,
    },
  };
}

// 청산 체결 확인. 포지션을 비우고 결과를 기록한다.
function onExitConfirmed(state, { price, now } = {}) {
  // 중단 중에도 청산 확인은 받아야 한다. halt가 마지막 청산을 지시하기 때문이다.
  const hadExitOrder = state.status === STATES.EXITING || (state.status === STATES.HALTED && state.exitReason);
  if (!hadExitOrder) {
    return { state, action: none(`내지 않은 청산의 확인은 무시합니다 (현재 ${state.status})`) };
  }
  assertPositive(price, 'price');
  const exitAt = toEpochMs(now, 'now');

  const pnlBps = (price / state.entryPrice - 1) * 10000;
  const costBps = state.plan && typeof state.plan.costBps === 'number' ? state.plan.costBps : null;

  const lastTrade = {
    event: state.event,
    material: state.material,
    reason: state.exitReason,
    entryPrice: state.entryPrice,
    exitPrice: price,
    quantity: state.quantity,
    entryAt: state.entryAt,
    exitAt,
    holdSec: (exitAt - state.entryAt) / 1000,
    pnlBps,
    // 비용을 모르면 0으로 위장하지 않는다 — 수수료를 뺀 값처럼 보이는 총손익이
    // 가장 위험한 숫자다.
    netPnlBps: costBps === null ? null : pnlBps - costBps,
  };

  // HALTED는 사람이 풀어야 한다. 청산이 끝났다고 스스로 IDLE로 돌아가면
  // 중단시킨 이유가 사라지지 않은 채 다음 재료에 다시 진입한다.
  const nextStatus = state.status === STATES.HALTED ? STATES.HALTED : STATES.IDLE;

  return {
    state: flatten({ ...state, status: nextStatus }, lastTrade),
    action: { type: 'notify', reason: 'exit_filled', trade: lastTrade },
  };
}

// 중단. 어떤 상태에서도 HALTED로 갈 수 있다.
function halt(state, reason) {
  if (state.status === STATES.HALTED) {
    // 최초 사유를 보존한다. 뒤에 덮어쓴 "수동 중단"만 남으면 원인을 추적할 수 없다.
    return { state, action: none(`이미 중단 상태입니다(${state.haltReason ?? '사유 없음'})`) };
  }

  const halted = { ...state, status: STATES.HALTED, haltReason: reason ?? null };

  // HALTED에서는 틱을 판정하지 않는다. 그러므로 포지션을 든 채 멈추면 아무도
  // 보지 않는 포지션이 남는다 — 중단은 위험을 줄이려는 행동인데 그 반대가 된다.
  // 보유 중이었다면 나가라고 지시한다.
  if (state.status === STATES.HOLDING) {
    return {
      state: { ...halted, exitReason: 'halt', exitOrderedAt: state.lastTickAt },
      action: {
        type: 'exit',
        reason: 'halt',
        orderType: 'market',
        price: state.lastPrice,
        quantity: state.quantity,
        entryPrice: state.entryPrice,
        event: state.event,
        haltReason: reason ?? null,
      },
    };
  }

  // EXITING이면 청산 지시가 이미 나가 있다 — 여기서 또 내면 이중 청산이다.
  if (state.status === STATES.EXITING) {
    return { state: halted, action: none('청산 주문이 이미 나가 있어 추가 지시를 내지 않습니다') };
  }

  // ARMED면 체결되지 않은 진입 주문이 남아 있을 수 있다. 취소는 호출자 몫이다.
  if (state.status === STATES.ARMED) {
    return { state: halted, action: { type: 'notify', reason: 'halt_while_armed', haltReason: reason ?? null } };
  }

  return { state: halted, action: { type: 'notify', reason: 'halted', haltReason: reason ?? null } };
}

module.exports = {
  STATES,
  createEventState,
  onMaterialDetected,
  onPriceTick,
  onFillConfirmed,
  onExitConfirmed,
  halt,
};
