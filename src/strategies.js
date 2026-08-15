'use strict';

// 전략 — (candles, params) => targetPositions[]. 순수 함수.
//
// 각 전략은 "원신호 생성 → 리스크 가드 적용"의 2단으로 되어 있고, 가드를 포함한
// 결과만 밖으로 내보낸다. 손절 없는 신호를 실수로 백테스트에 넣을 수 없게 하려는 것이다.
// 가드 자체의 검증은 risk.js가 담당한다.
//
// targetPositions[i]는 "i번 봉 종가까지의 정보로 낸 판단"이며, 체결은 백테스트
// 엔진이 i+1번 봉 시가에 한다. 전략은 절대 candles[i] 이후를 읽지 않는다.

const { ema, rsi, atr, closes, rollingPercentileRank } = require('./indicators');
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

// 펀딩비 역발상: 펀딩 백분위가 낮으면(롱이 몰리지 않았으면) 진입, 높으면(과열) 청산.
//
// 앞의 세 전략과 달리 신호가 가격에서 나오지 않는다. candles[i].funding은
// funding.js의 attachFunding이 붙여 주며, 그 함수가 룩어헤드를 막는 책임을 진다.
function fundingReversion(candles, params = {}) {
  const { fundingLookback = 90, buyBelowPct = 30, sellAbovePct = 80 } = params;
  assertPositiveInt(fundingLookback, 'fundingLookback');
  if (!(buyBelowPct < sellAbovePct)) {
    throw new RangeError(
      `buyBelowPct(${buyBelowPct})는 sellAbovePct(${sellAbovePct})보다 작아야 합니다`
    );
  }

  const ranks = rollingPercentileRank(
    candles.map((c) => (c.funding == null ? null : c.funding)),
    fundingLookback
  );

  const raw = new Array(candles.length).fill(0);
  let position = 0;

  for (let i = 0; i < candles.length; i += 1) {
    const rank = ranks[i];
    if (rank != null) {
      if (rank < buyBelowPct) position = 1;
      else if (rank > sellAbovePct) position = 0;
    }
    raw[i] = position;
  }
  return guard(candles, raw, params);
}

// ────────────────────────────────────────────────────────────────────────────
// 롱/숏 전략군
//
// 검증 6폴드 중 4개가 하락장이었고, 롱 온리가 거기서 할 수 있는 최선은
// "현금 보유로 덜 잃기"였다. 아래 전략들은 -1(숏)을 낼 수 있어 하락에서도
// 수익을 노린다. 무기한 선물이 전제이며 백테스트는 펀딩 비용을 함께 문다.
// ────────────────────────────────────────────────────────────────────────────

// 추세 추종 롱숏 — 빠른 EMA가 위면 롱, 아래면 숏.
function emaCrossLS(candles, params = {}) {
  const { fast = 12, slow = 26, invert = false } = params;
  assertPositiveInt(fast, 'fast');
  assertPositiveInt(slow, 'slow');
  if (fast >= slow) {
    throw new RangeError(`fast(${fast})는 slow(${slow})보다 작아야 합니다`);
  }

  const price = closes(candles);
  const fastEma = ema(price, fast);
  const slowEma = ema(price, slow);
  const sign = invert ? -1 : 1;

  const raw = candles.map((_, i) => {
    if (fastEma[i] == null || slowEma[i] == null) return 0;
    if (fastEma[i] === slowEma[i]) return 0;
    return (fastEma[i] > slowEma[i] ? 1 : -1) * sign;
  });
  return guard(candles, raw, params);
}

// 돌파 롱숏 — 직전 N봉 고가 돌파는 롱, 저가 이탈은 숏. 중간에서는 직전 방향 유지.
function donchianLS(candles, params = {}) {
  const { entryLookback = 20, exitLookback = 10 } = params;
  assertPositiveInt(entryLookback, 'entryLookback');
  assertPositiveInt(exitLookback, 'exitLookback');

  const lookback = Math.max(entryLookback, exitLookback);
  const raw = new Array(candles.length).fill(0);
  let position = 0;

  for (let i = 0; i < candles.length; i += 1) {
    if (i < lookback) {
      raw[i] = position;
      continue;
    }
    const upper = candles.slice(i - entryLookback, i);
    const lower = candles.slice(i - exitLookback, i);
    const highest = Math.max(...upper.map((c) => c.high));
    const lowest = Math.min(...lower.map((c) => c.low));

    if (candles[i].close > highest) position = 1;
    else if (candles[i].close < lowest) position = -1;
    raw[i] = position;
  }
  return guard(candles, raw, params);
}

// 시계열 모멘텀 — 룩백 대비 올랐으면 롱, 내렸으면 숏.
// 자산군을 가리지 않고 가장 오래 살아남은 이례현상으로 알려져 있어, 기준 삼아 넣는다.
function tsMomentum(candles, params = {}) {
  const { lookback = 168 } = params; // 1h 기준 1주
  assertPositiveInt(lookback, 'lookback');

  const price = closes(candles);
  const raw = candles.map((_, i) => {
    if (i < lookback) return 0;
    const change = price[i] - price[i - lookback];
    if (change === 0) return 0;
    return change > 0 ? 1 : -1;
  });
  return guard(candles, raw, params);
}

// 변동성 돌파 — 이번 봉 시가에서 직전 변동폭의 k배만큼 움직이면 그 방향으로.
// 국내 단타에서 널리 쓰이는 형태를 롤링 구간으로 옮긴 것이다.
function volBreakout(candles, params = {}) {
  const { rangeLookback = 24, k = 0.5 } = params;
  assertPositiveInt(rangeLookback, 'rangeLookback');
  if (typeof k !== 'number' || !Number.isFinite(k) || k <= 0) {
    throw new RangeError(`k는 양의 유한수여야 합니다: ${k}`);
  }

  const raw = new Array(candles.length).fill(0);

  for (let i = rangeLookback; i < candles.length; i += 1) {
    const window = candles.slice(i - rangeLookback, i);
    const range = Math.max(...window.map((c) => c.high)) - Math.min(...window.map((c) => c.low));
    if (range <= 0) continue; // 변동폭이 없으면 임계도 없다

    const { open, close } = candles[i];
    if (close > open + k * range) raw[i] = 1;
    else if (close < open - k * range) raw[i] = -1;
  }
  return guard(candles, raw, params);
}

// 펀딩 롱숏 — 과열(백분위 상단)이면 숏, 냉각(하단)이면 롱.
// fundingReversion의 롱숏 확장. 신호가 가격이 아닌 포지셔닝에서 나온다.
function fundingLS(candles, params = {}) {
  const { fundingLookback = 90, buyBelowPct = 30, sellAbovePct = 80 } = params;
  assertPositiveInt(fundingLookback, 'fundingLookback');
  if (!(buyBelowPct < sellAbovePct)) {
    throw new RangeError(
      `buyBelowPct(${buyBelowPct})는 sellAbovePct(${sellAbovePct})보다 작아야 합니다`
    );
  }

  const ranks = rollingPercentileRank(
    candles.map((c) => (c.funding == null ? null : c.funding)),
    fundingLookback
  );

  const raw = new Array(candles.length).fill(0);
  let position = 0;
  for (let i = 0; i < candles.length; i += 1) {
    const rank = ranks[i];
    if (rank != null) {
      if (rank < buyBelowPct) position = 1;
      else if (rank > sellAbovePct) position = -1;
    }
    raw[i] = position;
  }
  return guard(candles, raw, params);
}

// 앙상블 — 서로 다른 가설을 가진 구성원의 표를 합쳐 임계를 넘을 때만 움직인다.
// 개별 전략이 각자 다른 국면에서 틀리므로, 합의될 때만 나서면 오신호가 줄어든다는 가설.
function ensemble(candles, params = {}) {
  const {
    members = [
      { strategy: 'emaCrossLS', params: {} },
      { strategy: 'donchianLS', params: {} },
      { strategy: 'tsMomentum', params: {} },
    ],
    threshold = 2,
  } = params;

  if (!Array.isArray(members) || members.length === 0) {
    throw new RangeError('ensemble에는 최소 1개의 구성원이 필요합니다');
  }
  if (!Number.isInteger(threshold) || threshold < 1 || threshold > members.length) {
    throw new RangeError(`threshold는 1~${members.length} 사이 정수여야 합니다: ${threshold}`);
  }

  // 구성원은 가드 없이 원신호만 낸다 — 가드는 합의된 최종 포지션에 한 번만 씌운다.
  const votes = members.map((m) => {
    const fn = STRATEGIES[m.strategy];
    if (!fn) throw new RangeError(`알 수 없는 구성원 전략: ${m.strategy}`);
    return fn(candles, { ...(m.params || {}), atrStopMult: null, dailyLossLimitPct: null });
  });

  const raw = candles.map((_, i) => {
    const sum = votes.reduce((a, v) => a + v[i], 0);
    if (sum >= threshold) return 1;
    if (sum <= -threshold) return -1;
    return 0;
  });
  return guard(candles, raw, params);
}

const STRATEGIES = {
  emaCross,
  rsiReversion,
  donchianBreakout,
  fundingReversion,
  emaCrossLS,
  donchianLS,
  tsMomentum,
  volBreakout,
  fundingLS,
  ensemble,
};

module.exports = {
  emaCross,
  rsiReversion,
  donchianBreakout,
  fundingReversion,
  emaCrossLS,
  donchianLS,
  tsMomentum,
  volBreakout,
  fundingLS,
  ensemble,
  STRATEGIES,
  DEFAULT_GUARDS,
};
