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

// 한 구간의 수익 배수. 숏은 가격이 내려야 이익이므로 분자·분모가 뒤집힌다.
function legFactor(side, entryPrice, exitPrice) {
  return side > 0 ? exitPrice / entryPrice : entryPrice / exitPrice;
}

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

  let side = 0; // 1 = 롱, -1 = 숏, 0 = 현금
  let entryPrice = null;
  let extremeClose = null; // 롱이면 고점, 숏이면 저점
  let stoppedSide = 0; // 손절 직후 같은 방향으로 즉시 재진입하는 것을 막는다

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

    if (side !== 0) {
      // 롱은 고점을, 숏은 저점을 추적한다. 손절선도 방향에 따라 뒤집힌다.
      extremeClose = side > 0 ? Math.max(extremeClose, close) : Math.min(extremeClose, close);
      const atrValue = atrSeries[i];
      if (atrStopMult != null && atrValue != null) {
        const stopLine = extremeClose - side * atrStopMult * atrValue;
        const hit = side > 0 ? close <= stopLine : close >= stopLine;
        if (hit) {
          stoppedSide = side;
          // 손절은 "이 방향 포지션이 끝났다"는 뜻이다. 같은 봉에 반대 방향
          // 신호가 나 있다면 그건 새 판단이므로 살린다.
          desired = rawPositions[i] === -side ? rawPositions[i] : 0;
        }
      }
    }

    // 같은 방향으로의 재진입만 막는다. 반대 방향 신호는 새 판단이므로 허용한다.
    if (stoppedSide !== 0) {
      if (rawPositions[i] === stoppedSide) desired = 0;
      else stoppedSide = 0;
    }

    // 미실현 손실까지 포함해 한도를 본다 — 청산될 때까지 기다리면 이미 늦다.
    if (dailyLossLimitPct != null && !dayHalted && side !== 0) {
      const dayFactor = realizedDayFactor * legFactor(side, entryPrice, close);
      if ((dayFactor - 1) * 100 <= -dailyLossLimitPct) {
        desired = 0;
        dayHalted = true;
      }
    }
    if (dayHalted) desired = 0;

    if (side !== 0 && desired !== side) {
      realizedDayFactor *= legFactor(side, entryPrice, close);
      side = 0;
      entryPrice = null;
      extremeClose = null;
      if (dailyLossLimitPct != null && (realizedDayFactor - 1) * 100 <= -dailyLossLimitPct) {
        dayHalted = true;
        desired = 0;
      }
    }
    if (side === 0 && desired !== 0) {
      side = desired;
      entryPrice = close;
      extremeClose = close;
    }

    out[i] = desired;
  }

  return out;
}

module.exports = { applyRiskGuards, MS_PER_DAY };
