'use strict';

// 조건 주문(브래킷) 설계 — 진입 + 상단 익절 + 하단 손절. 순수 함수.
//
// **이 모듈의 존재 이유는 "확실한 수익"이 존재하지 않는다는 것을 숫자로 드러내는 것이다.**
//
// 상단·하단 조건 주문은 확실한 수익을 만들지 않는다. 작은 이익을 자주 얻고 큰 손실을
// 가끔 겪도록 **분포를 바꿀** 뿐이며, 기대값은 승률과 손익비와 비용이 함께 정한다.
// 그 관계를 한 수로 요약한 것이 **손익분기 승률**이다:
//
//     p* = (손절폭 + 왕복비용) / (익절폭 + 손절폭)
//
// 익절을 "보수적으로" 좁게 잡을수록 p*는 급격히 1에 가까워지고, 비용이 익절폭에
// 근접하면 p*가 1을 넘는다 — 그때는 **100% 이겨도 손실**이다.

const MIN_NOTIONAL_KRW = 5000; // 빗썸 최소 주문금액 대략치. 실제 값은 거래소 공지 기준으로 조정.

function assertPositive(value, name) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${name}은(는) 양의 유한수여야 합니다: ${value}`);
  }
}

function assertNonNegative(value, name) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new RangeError(`${name}은(는) 0 이상의 유한수여야 합니다: ${value}`);
  }
}

// 손익분기 승률. 1을 넘으면 어떤 승률로도 수익이 불가능하다는 뜻이다.
function breakevenWinRate({ tpBps, slBps, costBps } = {}) {
  assertPositive(tpBps, 'tpBps');
  assertPositive(slBps, 'slBps');
  assertNonNegative(costBps, 'costBps');
  return (slBps + costBps) / (tpBps + slBps);
}

// 거래당 기대 수익(bps). 승률이 손익분기와 같으면 정확히 0이 된다.
function expectancyBps({ tpBps, slBps, costBps, winRate } = {}) {
  assertPositive(tpBps, 'tpBps');
  assertPositive(slBps, 'slBps');
  assertNonNegative(costBps, 'costBps');
  if (typeof winRate !== 'number' || !Number.isFinite(winRate) || winRate < 0 || winRate > 1) {
    throw new RangeError(`winRate는 0~1 사이여야 합니다: ${winRate}`);
  }
  return winRate * (tpBps - costBps) - (1 - winRate) * (slBps + costBps);
}

// 진입가와 위험 한도로 주문을 설계한다.
//
// 수량은 "한 번에 잃어도 되는 금액 ÷ 주당 손절 손실"로 정한다. 명목 금액을 먼저
// 정하고 손절을 나중에 붙이면, 손절이 넓은 종목에서 한 번에 계좌가 크게 흔들린다.
function planBracket({
  entryPrice,
  takeProfitBps,
  stopLossBps,
  capital,
  riskPct = 1,
  costBps = 0,
  assumedWinRate = null,
  minNotional = MIN_NOTIONAL_KRW,
} = {}) {
  assertPositive(entryPrice, 'entryPrice');
  assertPositive(takeProfitBps, 'takeProfitBps');
  assertPositive(stopLossBps, 'stopLossBps');
  assertPositive(capital, 'capital');
  assertPositive(riskPct, 'riskPct');
  assertNonNegative(costBps, 'costBps');

  const takeProfitPrice = entryPrice * (1 + takeProfitBps / 10000);
  const stopLossPrice = entryPrice * (1 - stopLossBps / 10000);

  const riskAmount = capital * (riskPct / 100);
  const lossPerUnit = entryPrice - stopLossPrice;
  let quantity = riskAmount / lossPerUnit;
  let notional = quantity * entryPrice;

  // 레버리지는 들이지 않는다 — 명목이 자본을 넘으면 자본 한도로 자른다.
  const cappedByCapital = notional > capital;
  if (cappedByCapital) {
    quantity = capital / entryPrice;
    notional = capital;
  }

  const be = breakevenWinRate({ tpBps: takeProfitBps, slBps: stopLossBps, costBps });
  const expectancy =
    assumedWinRate == null
      ? null
      : expectancyBps({ tpBps: takeProfitBps, slBps: stopLossBps, costBps, winRate: assumedWinRate });

  // 실행 가능 여부를 여기서 판정한다. 불가능한 주문을 "일단 내보고 나중에 보는" 것이
  // 이 판에서 가장 비싼 실수다.
  let reason = null;
  if (be > 1) {
    reason =
      `손익분기 승률이 ${(be * 100).toFixed(1)}%로 100%를 넘습니다 — ` +
      `익절폭(${takeProfitBps}bps)이 왕복 비용(${costBps}bps)을 감당하지 못해 전부 이겨도 손실입니다.`;
  } else if (notional < minNotional) {
    reason = `주문 명목(${Math.round(notional).toLocaleString()}원)이 최소 주문금액(${minNotional.toLocaleString()}원) 미만입니다.`;
  }

  return {
    entryPrice,
    takeProfitPrice,
    stopLossPrice,
    quantity,
    notional,
    riskAmount: Math.min(riskAmount, notional * (stopLossBps / 10000)),
    cappedByCapital,
    breakevenWinRate: be,
    expectancyBps: expectancy,
    executable: reason === null,
    reason,
  };
}

module.exports = { MIN_NOTIONAL_KRW, breakevenWinRate, expectancyBps, planBracket };
