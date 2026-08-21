'use strict';

// 이벤트(재료) 매매 계획 — 재료의 급과 시황으로 손절·익절·보유시간·주문금액을 정한다. 순수 함수.
//
// **이 모듈의 존재 이유:** 재료를 남보다 빨리 찾는 것만으로는 돈이 되지 않는다.
// 유목민식 단타에서 실제로 손익을 가르는 것은 "이 재료가 어느 급인지"와
// "지금 시황이 재료를 살려주는지"를 보고 **미리** 손절과 익절을 못박아 두는 일이다.
// 진입한 뒤에 정하면 그때는 이미 호가창이 정한다.
//
// 설계의 뼈대는 세 가지다.
//
// ① **손절은 익절보다 항상 좁다.** 재료 매매는 승률로 먹는 게임이 아니라 손익비로
//    먹는 게임이다. 재료가 안 먹히면 즉시 빠져나오고, 먹히면 짧게 실현한다.
//    급이 높을수록 익절은 넓게, 보유는 짧게 — 큰 재료일수록 초반에 다 움직인다.
//
// ② **시황 배수는 익절폭에만 곱한다.** 손절폭에는 절대 곱하지 않는다.
//    시황이 나쁘다는 것은 "재료가 덜 먹힌다"는 뜻이지 "더 버텨야 한다"는 뜻이 아니다.
//    나쁜 시황에서 손절을 넓히면 덜 먹히는 재료를 더 크게 잃는 쪽으로만 바뀐다.
//
// ③ **현물에서 악재는 매매 대상이 아니다.** 빗썸 현물은 공매도가 불가능하다.
//    악재를 "재료"로만 취급하면 하락 재료에 매수 주문이 나간다 — 이 모듈에서
//    가장 치명적인 실패 모드라 다른 어떤 계산보다 먼저 막는다.

const { planBracket, MIN_NOTIONAL_KRW } = require('./bracket');

// 등급별 기본값. 이 표가 곧 "재료의 급"의 정의다 — 급을 나눠놓고 같은 손절·익절을
// 쓰면 등급 분류 자체가 매매에 아무 영향을 못 준다.
const GRADE_PLAYBOOK = {
  S: { takeProfitBps: 500, stopLossBps: 200, maxHoldSec: 600 },
  A: { takeProfitBps: 300, stopLossBps: 150, maxHoldSec: 900 },
  B: { takeProfitBps: 150, stopLossBps: 100, maxHoldSec: 1800 },
  // C는 항목을 비워 두는 게 아니라 "매매하지 않음"을 명시적으로 적는다.
  // 기본값이 없다는 이유로 다른 등급 값이 잘못 흘러드는 것을 막는다.
  C: null,
};

const RISK_ON_BTC_BPS = 200; // BTC 24h 초과 상승
const RISK_OFF_BTC_BPS = -200; // BTC 24h 초과 하락
const RISK_ON_BREADTH = 60; // 상승 종목 비율(%)
const RISK_OFF_BREADTH = 40;

const MULTIPLIERS = { risk_on: 1.3, neutral: 1.0, risk_off: 0.7 };

const UNKNOWN_CONTEXT = {
  regime: null,
  multiplier: null,
  reason: '시황 데이터(BTC 24h 변동, 시장폭)가 없어 국면을 판정할 수 없습니다.',
};

function isFiniteNumber(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

function assertPositive(value, name) {
  if (!isFiniteNumber(value) || value <= 0) {
    throw new RangeError(`${name}은(는) 양의 유한수여야 합니다: ${value}`);
  }
}

function assertNonNegative(value, name) {
  if (!isFiniteNumber(value) || value < 0) {
    throw new RangeError(`${name}은(는) 0 이상의 유한수여야 합니다: ${value}`);
  }
}

// 시황 판정. 재료가 얼마나 먹히는 장인지를 한 수(배수)로 요약한다.
//
// 데이터가 없으면 neutral로 위장하지 않고 regime을 null로 돌려준다. "모르는 상태"와
// "보통인 상태"는 다르다 — 전자는 매매를 멈춰야 하고 후자는 그대로 진행한다.
function assessMarketContext({ btcChange24hBps, breadthPct } = {}) {
  if (!isFiniteNumber(btcChange24hBps) || !isFiniteNumber(breadthPct)) {
    return { ...UNKNOWN_CONTEXT };
  }

  // 나쁜 쪽을 먼저 본다. risk_off는 OR 조건이라 "BTC만 오르고 알트는 죽은 장"을
  // 잡아낸다 — 재료가 가장 안 먹히는데 지표 하나만 보면 강세로 착각하기 쉬운 장이다.
  if (btcChange24hBps < RISK_OFF_BTC_BPS || breadthPct < RISK_OFF_BREADTH) {
    return {
      regime: 'risk_off',
      multiplier: MULTIPLIERS.risk_off,
      reason: `BTC 24h ${btcChange24hBps}bps, 시장폭 ${breadthPct}% — 재료가 죽는 장이라 익절을 좁힙니다.`,
    };
  }
  if (btcChange24hBps > RISK_ON_BTC_BPS && breadthPct > RISK_ON_BREADTH) {
    return {
      regime: 'risk_on',
      multiplier: MULTIPLIERS.risk_on,
      reason: `BTC 24h ${btcChange24hBps}bps, 시장폭 ${breadthPct}% — 재료가 더 크게 먹히는 장입니다.`,
    };
  }
  return {
    regime: 'neutral',
    multiplier: MULTIPLIERS.neutral,
    reason: `BTC 24h ${btcChange24hBps}bps, 시장폭 ${breadthPct}% — 기대감 보정 없이 등급 기본값을 씁니다.`,
  };
}

// 매매하지 않기로 판정했을 때의 결과. 수치를 0으로 채우지 않는다 —
// 0은 하류에서 "0주 매수"처럼 유효한 주문으로 읽힐 수 있다.
function noTrade(reason) {
  return {
    side: null,
    takeProfitBps: null,
    stopLossBps: null,
    maxHoldSec: null,
    quantity: null,
    notional: null,
    cappedByCapital: false,
    breakevenWinRate: null,
    regime: null,
    executable: false,
    reason,
  };
}

// 재료 하나에 대한 실제 주문 계획.
//
// 판정 순서가 곧 안전 순서다: 방향 → 등급 → 시황 → 숫자. 앞의 관문에서 걸린 재료는
// 가격을 조회하지 않아도 걸러져야 하므로 숫자 검증을 뒤에 둔다.
function planEventTrade({
  grade,
  direction,
  marketContext,
  capital,
  riskPct = 1,
  price,
  feeBps = 0,
  minNotionalKrw = MIN_NOTIONAL_KRW,
} = {}) {
  // ① 현물 제약. 이걸 놓치면 악재 공지에 매수 주문이 나간다.
  if (direction === 'bearish') {
    return noTrade('현물은 하락에 베팅할 수 없음 — 빗썸 현물은 공매도가 불가능해 악재는 매매 대상이 아닙니다.');
  }
  if (direction !== 'bullish') {
    return noTrade(`재료의 방향이 'bullish'가 아닙니다(받은 값: ${JSON.stringify(direction)}) — 방향을 모르면 매매하지 않습니다.`);
  }

  // ② 등급.
  const key = typeof grade === 'string' ? grade.toUpperCase() : grade;
  if (!(key in GRADE_PLAYBOOK)) {
    return noTrade(`알 수 없는 재료 등급입니다(받은 값: ${JSON.stringify(grade)}) — 등급을 모르면 매매하지 않습니다.`);
  }
  const playbook = GRADE_PLAYBOOK[key];
  if (playbook === null) {
    return noTrade(`${key}급은 매매하지 않습니다 — 비용과 슬리피지를 넘길 만큼 움직이지 않는 재료입니다.`);
  }

  // ③ 시황. 모르는 채로는 익절폭을 정할 수 없다.
  const ctx = marketContext ?? UNKNOWN_CONTEXT;
  if (ctx.regime == null || !isFiniteNumber(ctx.multiplier)) {
    return noTrade(`시황을 판정할 수 없어 매매하지 않습니다 — ${ctx.reason ?? UNKNOWN_CONTEXT.reason}`);
  }

  // ④ 숫자.
  assertPositive(price, 'price');
  assertPositive(capital, 'capital');
  assertPositive(riskPct, 'riskPct');
  assertNonNegative(feeBps, 'feeBps');
  assertPositive(minNotionalKrw, 'minNotionalKrw');

  // 기대감 배수는 익절에만 곱한다. 손절은 등급이 정한 값 그대로 간다 —
  // 나쁜 시황에서 손절을 넓히면 손실만 커지기 때문이다.
  // 0.1bps 아래는 주문에서 의미가 없어 반올림한다(부동소수 잔여값 제거 목적도 있다).
  const takeProfitBps = Math.round(playbook.takeProfitBps * ctx.multiplier * 10) / 10;
  const stopLossBps = playbook.stopLossBps;
  const maxHoldSec = playbook.maxHoldSec; // 보유시간도 시황이 아니라 재료의 급이 정한다.

  // 수량 산출은 planBracket과 같은 원칙(위험금액 ÷ 주당 손절 손실, 레버리지 없음)을
  // 쓴다. 같은 규칙을 두 번 적으면 한쪽만 고쳐지는 날이 반드시 온다.
  const bracket = planBracket({
    entryPrice: price,
    takeProfitBps,
    stopLossBps,
    capital,
    riskPct,
    costBps: feeBps * 2,
    minNotional: minNotionalKrw,
  });

  let reason = null;
  if (bracket.breakevenWinRate > 1) {
    reason =
      `손익분기 승률이 ${(bracket.breakevenWinRate * 100).toFixed(1)}%로 100%를 넘습니다 — ` +
      `${ctx.regime} 보정 후 익절 ${takeProfitBps}bps가 왕복 비용 ${feeBps * 2}bps를 감당하지 못해 전부 이겨도 손실입니다.`;
  } else if (bracket.notional < minNotionalKrw) {
    // 실제로 있었던 사고: 손절폭을 넓히면서 위험 비중을 그대로 뒀더니 계산된 명목이
    // 최소 주문금액 아래로 떨어졌다. 개별 값은 전부 정상 범위라 어디서도 경고가 뜨지
    // 않은 채, 신호는 계속 뜨는데 단 한 건도 체결되지 않았다 — 가장 조용한 실패다.
    reason =
      `위험 비중 ${riskPct}%와 ${key}급 손절 ${stopLossBps}bps 조합에서 계산된 주문 명목이 ` +
      `${Math.round(bracket.notional).toLocaleString()}원으로 최소 주문금액 ${minNotionalKrw.toLocaleString()}원에 ` +
      `못 미칩니다 — 신호는 떠도 단 한 건도 체결되지 않습니다. 위험 비중을 올리거나 자본을 키우세요.`;
  }

  return {
    // 실행 불가면 side까지 null로 막는다. executable을 확인하지 않는 호출자가
    // side만 보고 주문을 내는 경로를 아예 없앤다 — 매매 코드에서는 방어가 중복이어도 싸다.
    side: reason === null ? 'buy' : null,
    takeProfitBps,
    stopLossBps,
    maxHoldSec,
    quantity: bracket.quantity,
    notional: bracket.notional,
    cappedByCapital: bracket.cappedByCapital,
    breakevenWinRate: bracket.breakevenWinRate,
    regime: ctx.regime,
    executable: reason === null,
    reason,
  };
}

module.exports = { GRADE_PLAYBOOK, MULTIPLIERS, assessMarketContext, planEventTrade };
