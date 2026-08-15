'use strict';

// 전략 — (candles, params) => targetPositions[]. 순수 함수.
//
// 각 전략은 "원신호 생성 → 리스크 가드 적용"의 2단으로 되어 있고, 가드를 포함한
// 결과만 밖으로 내보낸다. 손절 없는 신호를 실수로 백테스트에 넣을 수 없게 하려는 것이다.
// 가드 자체의 검증은 risk.js가 담당한다.
//
// targetPositions[i]는 "i번 봉 종가까지의 정보로 낸 판단"이며, 체결은 백테스트
// 엔진이 i+1번 봉 시가에 한다. 전략은 절대 candles[i] 이후를 읽지 않는다.

const { ema, rsi, atr, closes } = require('./indicators');
const { applyRiskGuards } = require('./risk');

const DEFAULT_GUARDS = { atrPeriod: 14, atrStopMult: 3, dailyLossLimitPct: 5 };

function assertPositiveInt(value, name) {
  if (!Number.isInteger(value) || value < 1) {
    throw new RangeError(`${name}은(는) 양의 정수여야 합니다: ${value}`);
  }
}

function guard(candles, rawPositions, params) {
  const { atrPeriod, atrStopMult, dailyLossLimitPct } = { ...DEFAULT_GUARDS, ...params };
  assertPositiveInt(atrPeriod, 'atrPeriod');
  return applyRiskGuards(candles, rawPositions, {
    atrSeries: atr(candles, atrPeriod),
    atrStopMult,
    dailyLossLimitPct,
  });
}

// 추세 추종: 빠른 EMA가 느린 EMA 위에 있는 동안 보유.
function emaCross(candles, params = {}) {
  const { fast = 12, slow = 26 } = params;
  assertPositiveInt(fast, 'fast');
  assertPositiveInt(slow, 'slow');
  if (fast >= slow) {
    throw new RangeError(`fast(${fast})는 slow(${slow})보다 작아야 합니다`);
  }

  const price = closes(candles);
  const fastEma = ema(price, fast);
  const slowEma = ema(price, slow);

  const raw = candles.map((_, i) =>
    fastEma[i] != null && slowEma[i] != null && fastEma[i] > slowEma[i] ? 1 : 0
  );
  return guard(candles, raw, params);
}

// 역추세: RSI가 과매도로 내려가면 진입, 과매수로 올라가면 청산.
// 두 임계 사이에서는 직전 포지션을 유지한다(히스테리시스) — 임계 하나로 판정하면
// 경계에서 신호가 떨리며 수수료만 나간다.
function rsiReversion(candles, params = {}) {
  const { rsiPeriod = 14, buyBelow = 30, sellAbove = 70 } = params;
  assertPositiveInt(rsiPeriod, 'rsiPeriod');
  if (!(buyBelow < sellAbove)) {
    throw new RangeError(`buyBelow(${buyBelow})는 sellAbove(${sellAbove})보다 작아야 합니다`);
  }

  const values = rsi(closes(candles), rsiPeriod);
  const raw = new Array(candles.length).fill(0);
  let position = 0;

  for (let i = 0; i < candles.length; i += 1) {
    const value = values[i];
    if (value != null) {
      if (value < buyBelow) position = 1;
      else if (value > sellAbove) position = 0;
    }
    raw[i] = position;
  }
  return guard(candles, raw, params);
}

// 돌파: 직전 N봉 최고가를 넘으면 진입, 직전 M봉 최저가를 깨면 청산.
// 비교 구간에 현재 봉을 넣지 않는다 — 자기 자신의 고가를 넘을 수는 없다.
function donchianBreakout(candles, params = {}) {
  const { entryLookback = 20, exitLookback = 10 } = params;
  assertPositiveInt(entryLookback, 'entryLookback');
  assertPositiveInt(exitLookback, 'exitLookback');

  const raw = new Array(candles.length).fill(0);
  let position = 0;

  for (let i = 0; i < candles.length; i += 1) {
    const lookback = position === 1 ? exitLookback : entryLookback;
    if (i < lookback) {
      raw[i] = position;
      continue;
    }
    const window = candles.slice(i - lookback, i);
    if (position === 0) {
      const highest = Math.max(...window.map((c) => c.high));
      if (candles[i].close > highest) position = 1;
    } else {
      const lowest = Math.min(...window.map((c) => c.low));
      if (candles[i].close < lowest) position = 0;
    }
    raw[i] = position;
  }
  return guard(candles, raw, params);
}

const STRATEGIES = { emaCross, rsiReversion, donchianBreakout };

module.exports = { emaCross, rsiReversion, donchianBreakout, STRATEGIES, DEFAULT_GUARDS };
