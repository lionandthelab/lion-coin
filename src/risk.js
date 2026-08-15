'use strict';

// 리스크 가드 — 전략이 낸 원신호에 손절과 일일 손실 한도를 씌운다. 순수 함수.
//
// 실거래에서 시드를 지키는 것은 진입 신호가 아니라 이 층이다. 그래서 전략과
// 분리해 따로 테스트하고, 어떤 전략을 쓰든 같은 가드를 통과하게 한다.
//
// 판정은 전부 **종가 기준**이다. 봉 중간의 저가에 손절이 걸렸다고 가정하면
// 실제로는 못 잡았을 손절을 잡은 것처럼 백테스트가 좋아진다(체결 낙관 편향).
// 백테스트 엔진이 다음 봉 시가에 체결하므로, 여기서 나온 청산 결정도
// 실제로는 한 봉 뒤에 체결된다 — 이 지연은 의도된 것이며 실거래와 같다.

const MS_PER_DAY = 86400000;

function assertNonNegativeOrNull(value, name) {
  if (value === null || value === undefined) return;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new RangeError(`${name}은(는) 0 이상의 수 또는 null이어야 합니다: ${value}`);
  }
}

function applyRiskGuards(
  candles,
  rawPositions,
  { atrSeries, atrStopMult = 3, dailyLossLimitPct = 5 } = {}
) {
  if (!Array.isArray(candles) || !Array.isArray(rawPositions)) {
    throw new TypeError('candles와 rawPositions는 배열이어야 합니다');
  }
  if (rawPositions.length !== candles.length) {
    throw new TypeError(
      `rawPositions 길이(${rawPositions.length})가 candles 길이(${candles.length})와 다릅니다`
    );
  }
  if (!Array.isArray(atrSeries) || atrSeries.length !== candles.length) {
    throw new TypeError(
      `atrSeries 길이(${atrSeries?.length})가 candles 길이(${candles.length})와 다릅니다`
    );
  }
  assertNonNegativeOrNull(atrStopMult, 'atrStopMult');
  assertNonNegativeOrNull(dailyLossLimitPct, 'dailyLossLimitPct');

  const out = new Array(candles.length);

  let inPosition = false;
  let entryPrice = null;
  let peakClose = null;
  let stoppedOut = false; // 손절 직후 같은 신호로 즉시 재진입하는 것을 막는다

  let currentDay = null;
  let realizedDayFactor = 1; // 그날 청산된 구간들의 누적 수익 배수
  let dayHalted = false;

  for (let i = 0; i < candles.length; i += 1) {
    const { openTime, close } = candles[i];

    const day = Math.floor(openTime / MS_PER_DAY);
    if (day !== currentDay) {
      currentDay = day;
      realizedDayFactor = 1;
      dayHalted = false;
    }

    let desired = rawPositions[i];

    if (inPosition) {
      peakClose = Math.max(peakClose, close);
      const atrValue = atrSeries[i];
      if (atrStopMult != null && atrValue != null && close <= peakClose - atrStopMult * atrValue) {
        desired = 0;
        stoppedOut = true;
      }
    }

    if (stoppedOut) {
      // 원신호가 한 번 꺼져야 재진입을 허용한다.
      if (rawPositions[i] === 0) stoppedOut = false;
      desired = 0;
    }

    // 미실현 손실까지 포함해 한도를 본다 — 청산될 때까지 기다리면 이미 늦다.
    if (dailyLossLimitPct != null && !dayHalted && inPosition) {
      const dayFactor = realizedDayFactor * (close / entryPrice);
      if ((dayFactor - 1) * 100 <= -dailyLossLimitPct) {
        desired = 0;
        dayHalted = true;
      }
    }
    if (dayHalted) desired = 0;

    if (!inPosition && desired === 1) {
      inPosition = true;
      entryPrice = close;
      peakClose = close;
    } else if (inPosition && desired === 0) {
      realizedDayFactor *= close / entryPrice;
      inPosition = false;
      entryPrice = null;
      peakClose = null;
      if (dailyLossLimitPct != null && (realizedDayFactor - 1) * 100 <= -dailyLossLimitPct) {
        dayHalted = true;
      }
    }

    out[i] = desired;
  }

  return out;
}

module.exports = { applyRiskGuards, MS_PER_DAY };
