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

function isPositive(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function assertPositive(value, name) {
  if (!isPositive(value)) {
    throw new RangeError(`${name}은(는) 양의 유한수여야 합니다: ${value}`);
  }
}

// 계획의 구조적 결함(누락·NaN)은 호출자의 버그이므로 던진다. 반면 "실행 불가"는
// 정상적인 판단 결과이므로 던지지 않고 진입을 거절한다 — 둘은 다른 사건이다.
//
// **검증은 실제로 진입하는 경로에서만 한다.** event-plan.noTrade()는 매매하지
// 않기로 판정한 계획의 익절·손절·보유한도를 전부 null로 비워 돌려주는데(0으로
// 위장하지 않으려는 의도적 설계다), 이걸 거절 가드보다 먼저 검사하면 "매매하지
// 않음"이라는 정상 판단이 예외가 된다. 실제 공지의 대다수가 그 모양이라,
// 호출자의 .catch()가 그 예외를 삼키는 동안 거절 사유는 어디에도 남지 않는다.
function assertPlanNumbers(plan) {
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
    // 청산 주문이 거절당한 이력. 재시도로 돌아가도 실패 사실은 지우지 않는다 —
    // 같은 사유로 계속 실패하는 포지션은 사람이 봐야 한다.
    lastExitError: null,
    lastExitFailedAt: null,
    // 연속 실패 횟수. 상한을 넘으면 재시도는 계속하되 사람을 부른다.
    exitFailCount: 0,
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
//
// 판정 순서가 곧 안전 순서다: 진입을 **막는** 가드가 먼저고, 계획의 숫자 검증은
// 실제로 주문을 낼 경로에서만 한다. 순서가 뒤집히면 "진입하지 않는다"는 결론이
// 예외로 바뀌고, 그 예외는 상태 기계의 안전 분기에 닿지도 못한다.
function onMaterialDetected(state, { event = null, material = null, plan, now } = {}) {
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

  // 계획 객체 자체가 없는 것은 판단 결과가 아니라 호출자의 버그다 — 여기서만 던진다.
  if (!plan || typeof plan !== 'object') {
    throw new RangeError(`plan은 객체여야 합니다: ${JSON.stringify(plan)}`);
  }

  // planBracket이 실행 불가로 판정한 계획은 그대로 거절한다. 불가능한 주문을
  // "일단 내보고 나중에 보는" 것이 이 판에서 가장 비싼 실수다(bracket.js와 같은 판단).
  if (plan.executable === false) {
    return {
      state,
      action: { type: 'notify', reason: plan.reason ?? '실행 불가로 표시된 계획입니다', event, material },
    };
  }

  // 여기서부터가 진입 경로다. 이제야 숫자를 검증한다 — 이 값들로 청산선을 긋는다.
  assertPlanNumbers(plan);

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
  const at = toEpochMs(now, 'now');

  // **시간초과는 가격과 무관하다.** 명세가 정의하는 조건은 오직 경과 시각뿐이고,
  // 가격 검증을 앞에 두면 그 정의가 조용히 바뀐다. 상장 공지로 잡은 코인은
  // 매수호가가 통째로 비어 bid가 0/undefined로 오는 일이 흔한데, 그 틱마다
  // 예외가 나면 호출자의 .catch()가 삼키고 포지션은 마감을 몇 시간 넘겨도
  // 빠져나오지 못한다. 나올 수 없는 것보다 가격을 모르는 채 나오는 편이 낫다.
  const expired = at >= state.deadlineAt;

  // 익절·손절은 가격을 알아야 판정할 수 있다. 모르면 그 두 개만 포기한다.
  const priceKnown = isPositive(price);

  // low/high는 봉 폴링용 보조 입력이라 호출자가 무엇을 넣을지 통제할 수 없다.
  // undefined만 걸러내면 null이 통과해 `null <= 손절선`이 `0 <= 손절선`으로
  // 참이 되고, 오르고 있는 틱에서 손절 주문이 나간다 — 시장이 닿은 적 없는
  // 가격에 청산하는 것이라 기록까지 거짓이 된다. 유효한 양수만 쓴다.
  // min/max로 감싸는 이유: 봉값이 현재가와 어긋나게 와도 실제로 지나간 범위를
  // 좁히지 않기 위해서다.
  const lowest = priceKnown ? (isPositive(low) ? Math.min(low, price) : price) : null;
  const highest = priceKnown ? (isPositive(high) ? Math.max(high, price) : price) : null;

  // **손절 우선.** 하나의 틱(또는 봉)만으로는 어느 쪽이 먼저였는지 알 수 없다.
  // 익절을 먼저라고 가정하면 성과가 조직적으로 부풀려지고, 그 순간 실전이
  // bracket-backtest.js의 가정과 어긋난다. 보수적인 쪽이 덜 틀린다.
  let reason = null;
  if (priceKnown && lowest <= state.stopLossPrice) reason = 'stop_loss';
  else if (priceKnown && highest >= state.takeProfitPrice) reason = 'take_profit';
  else if (expired) reason = 'timeout';

  if (reason === null) {
    // 유효하지 않은 가격으로 lastPrice를 덮지 않는다. 대시보드의 미실현 손익과
    // 다음 판정이 그 값을 그대로 믿는다.
    const observed = priceKnown ? { lastPrice: price, lastTickAt: at } : { lastTickAt: at };
    return {
      state: { ...state, ...observed },
      action: none(
        priceKnown
          ? '청산 조건에 닿지 않았습니다'
          : `가격이 유효하지 않아 익절·손절을 판정할 수 없습니다: ${price} (시간초과 전)`
      ),
    };
  }

  return {
    state: {
      ...state,
      status: STATES.EXITING,
      ...(priceKnown ? { lastPrice: price } : {}),
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
      // 모르는 가격을 0으로 위장하지 않는다. 시장가 주문에는 가격이 필요 없고,
      // 0이 손익 계산에 흘러들면 -100% 같은 거짓 기록이 남는다.
      price: priceKnown ? price : null,
      quantity: state.quantity,
      entryPrice: state.entryPrice,
      event: state.event,
    },
  };
}

// 청산 주문이 **나가지 못했을 때**. 청산 지시와 주문 성공은 다른 사건인데 이
// 구분이 없으면 상태 기계는 EXITING인 채로 "이미 나갔다"고 믿고, 아무도 보지
// 않는 포지션이 남는다. 저장소의 유일한 halt 호출처가 정확히 이 상황이다.
// 이만큼 연속 실패하면 사람을 부른다. 재시도를 멈추는 값이 아니다 —
// 재시도는 계속되고 알림의 성격만 바뀐다.
const MAX_EXIT_RETRIES = 3;

function onExitFailed(state, { reason = null, now } = {}) {
  const at = now === undefined ? null : toEpochMs(now, 'now');
  const failure = reason == null ? '청산 주문 실패' : String(reason);

  if (state.status === STATES.EXITING) {
    // HOLDING으로 되돌린다. 그래야 다음 틱이 같은 조건을 다시 판정해 청산을
    // 재시도한다 — 손절·시간초과 조건은 사라진 게 아니라 그대로 남아 있다.
    //
    // **재시도에 상한을 두지 않는다.** 포기하는 순간 포지션은 아무도 보지 않는
    // 고아가 되고, 그게 이 함수가 막으려던 바로 그 상태다. 대신 몇 번 연속으로
    // 실패하면 사람을 부른다 — 거래소가 계속 거절하는데 조용히 도는 것은
    // 고아가 되는 것과 결과가 같다. 한 번의 일시적 5xx로 깨우지는 않는다.
    // 그런 알림은 곧 무시되고, 무시되는 알림은 없는 알림이다.
    const fails = (state.exitFailCount || 0) + 1;
    return {
      state: {
        ...state,
        status: STATES.HOLDING,
        exitReason: null,
        exitOrderedAt: null,
        lastExitError: failure,
        lastExitFailedAt: at,
        exitFailCount: fails,
      },
      action: {
        type: 'notify',
        reason: fails >= MAX_EXIT_RETRIES ? 'exit_retry_exhausted' : 'exit_retry',
        ...(fails >= MAX_EXIT_RETRIES ? { needsManualIntervention: true } : {}),
        detail: failure,
        failCount: fails,
        quantity: state.quantity,
        entryPrice: state.entryPrice,
        event: state.event,
      },
    };
  }

  // 이미 중단된 채로 포지션을 들고 있다면 되돌릴 곳이 없다 — HALTED에서 틱을
  // 판정하지 않는 것은 의도된 규칙이고, 여기서 HOLDING으로 풀면 중단이 무의미해진다.
  // 대신 침묵하지 않는다. 사람이 손으로 청산하려면 수량과 진입가가 필요하다.
  if (state.status === STATES.HALTED && state.quantity !== null) {
    return {
      state: { ...state, lastExitError: failure, lastExitFailedAt: at },
      action: {
        type: 'notify',
        reason: 'exit_failed_while_halted',
        needsManualIntervention: true,
        detail: failure,
        quantity: state.quantity,
        entryPrice: state.entryPrice,
        exitReason: state.exitReason,
        event: state.event,
      },
    };
  }

  return { state, action: none(`청산을 내지 않은 ${state.status} 상태의 실패 통보는 무시합니다`) };
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
  // 그러나 'none'으로 끝내서도 안 된다: HALTED에서는 틱을 판정하지 않으므로
  // 자동 복귀 경로가 없고, 이 저장소에서 EXITING을 중단시키는 유일한 호출처는
  // **청산 주문이 실패했을 때**다. 즉 "이미 나가 있다"는 전제가 대체로 틀린다.
  // 새 주문을 내지는 않되, 남은 포지션을 사람이 볼 수 있게 알린다.
  if (state.status === STATES.EXITING) {
    return {
      state: halted,
      action: {
        type: 'notify',
        reason: 'halt_while_exiting',
        needsManualIntervention: true,
        detail: '청산 주문이 이미 나가 있어 추가 지시를 내지 않습니다 — 체결 여부를 사람이 확인해야 합니다',
        quantity: state.quantity,
        entryPrice: state.entryPrice,
        exitReason: state.exitReason,
        event: state.event,
        haltReason: reason ?? null,
      },
    };
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
  onExitFailed,
  MAX_EXIT_RETRIES,
  halt,
};
