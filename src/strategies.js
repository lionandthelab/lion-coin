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

// 테스트·구성용 기준 전략. always는 항상 전량 롱(invert면 전량 숏), never는 항상 현금.
function always(candles, params = {}) {
  const sign = params.invert ? -1 : 1;
  return guard(candles, candles.map(() => sign), params);
}

function never(candles, params = {}) {
  return guard(candles, candles.map(() => 0), params);
}

// ────────────────────────────────────────────────────────────────────────────
// 사이징 계층 — 신호가 아니라 "얼마나 실을지"를 정한다.
//
// 연속 노출 엔진([-1,1])이 열리면서 처음 시도할 수 있게 된 레버다. 지금까지는
// 전량 진입/청산만 가능해 이 축을 아예 못 건드렸다.
// ────────────────────────────────────────────────────────────────────────────

// 실현 변동성이 목표보다 크면 노출을 줄이고, 작으면 늘린다(1 상한).
// 같은 신호라도 변동성이 클 때 덜 싣는 것만으로 위험조정 성과가 달라진다.
function volTarget(candles, params = {}) {
  const {
    inner = 'emaCrossLS',
    innerParams = {},
    volLookback = 30,
    targetVolPct = 40, // 연율 기준 목표 변동성
    periodsPerYear = 2190, // 4h 기본값
  } = params;
  assertPositiveInt(volLookback, 'volLookback');
  if (!(targetVolPct > 0)) {
    throw new RangeError(`targetVolPct는 양수여야 합니다: ${targetVolPct}`);
  }

  const fn = STRATEGIES[inner];
  if (!fn) throw new RangeError(`알 수 없는 내부 전략: ${inner}`);
  // 내부 전략은 가드 없이 방향만 낸다 — 가드는 사이징 후 최종 노출에 한 번만 씌운다.
  const signal = fn(candles, { ...innerParams, atrStopMult: null, dailyLossLimitPct: null });

  const price = closes(candles);
  const raw = new Array(candles.length).fill(0);

  for (let i = volLookback; i < candles.length; i += 1) {
    const rets = [];
    for (let k = i - volLookback + 1; k <= i; k += 1) {
      if (price[k - 1] > 0) rets.push(price[k] / price[k - 1] - 1);
    }
    if (rets.length < 2) continue;
    const avg = rets.reduce((a, b) => a + b, 0) / rets.length;
    const variance = rets.reduce((a, r) => a + (r - avg) ** 2, 0) / (rets.length - 1);
    const annualVolPct = Math.sqrt(variance) * Math.sqrt(periodsPerYear) * 100;
    if (!(annualVolPct > 0)) continue;

    // 상한 1 — 레버리지는 들이지 않는다.
    const scale = Math.min(1, targetVolPct / annualVolPct);
    raw[i] = signal[i] * scale;
  }

  return guard(candles, raw, params);
}

// 전략 포트폴리오 — 구성원 노출의 가중 평균.
//
// 앙상블(다수결)과 다르다. 앙상블은 합의될 때만 전량 진입하지만, 포트폴리오는
// 자본을 나눠 싣는다. 서로 다른 국면에서 틀리는 전략들을 섞으면 개별 성과가
// 약해도 위험조정 성과는 나아질 수 있다 — 분산은 검증된 거의 유일한 공짜 점심이다.
function portfolio(candles, params = {}) {
  const {
    members = [
      { strategy: 'emaCrossLS', params: {}, weight: 1 },
      { strategy: 'donchianLS', params: {}, weight: 1 },
      { strategy: 'tsMomentum', params: {}, weight: 1 },
    ],
  } = params;

  if (!Array.isArray(members) || members.length === 0) {
    throw new RangeError('portfolio에는 최소 1개의 구성원이 필요합니다');
  }
  const totalWeight = members.reduce((a, m) => a + (m.weight ?? 1), 0);
  if (!(totalWeight > 0)) {
    throw new RangeError(`가중치 합이 0보다 커야 합니다: ${totalWeight}`);
  }

  const legs = members.map((m) => {
    const fn = STRATEGIES[m.strategy];
    if (!fn) throw new RangeError(`알 수 없는 구성원 전략: ${m.strategy}`);
    return {
      weight: m.weight ?? 1,
      positions: fn(candles, { ...(m.params || {}), atrStopMult: null, dailyLossLimitPct: null }),
    };
  });

  const raw = candles.map((_, i) => {
    const sum = legs.reduce((a, l) => a + l.weight * l.positions[i], 0);
    return sum / totalWeight;
  });

  return guard(candles, raw, params);
}

// ────────────────────────────────────────────────────────────────────────────
// 봇 역이용 계열
//
// 남을 속이는 주문(스푸핑·레이어링·워시트레이딩)은 만들지 않는다. 시장조작이고
// 거래소 규정 위반이다. 대신 다른 참여자의 **예측 가능한 강제 행동**을 읽고
// 그 반대편에 선다 — 이건 시장을 속이는 게 아니라 유동성을 공급하는 쪽이다.
// ────────────────────────────────────────────────────────────────────────────

// 스탑 사냥 되받기.
// 추세추종 봇과 개인 손절이 직전 고/저점 **바깥**에 몰린다. 가격이 그 구간을
// 잠깐 뚫어 스탑을 털고(스윕) 곧바로 구간 안으로 되돌아오면, 방금 강제로
// 체결된 물량의 반대편이 유리하다. 뚫고 그대로 머무는 건 진짜 돌파이므로 건드리지 않는다.
function stopRunReversal(candles, params = {}) {
  const { lookback = 20, holdBars = 3 } = params;
  assertPositiveInt(lookback, 'lookback');
  assertPositiveInt(holdBars, 'holdBars');

  const raw = new Array(candles.length).fill(0);
  let held = 0;
  let barsLeft = 0;

  for (let i = lookback; i < candles.length; i += 1) {
    if (barsLeft > 0) {
      barsLeft -= 1;
      raw[i] = held;
      if (barsLeft === 0) held = 0;
      continue;
    }

    const window = candles.slice(i - lookback, i);
    const highest = Math.max(...window.map((c) => c.high));
    const lowest = Math.min(...window.map((c) => c.low));
    const { high, low, close } = candles[i];

    // 위로 스윕: 고점을 넘었으나 종가는 구간 안으로 복귀 → 롱 스탑이 털린 것
    if (high > highest && close <= highest) {
      held = -1;
      barsLeft = holdBars - 1;
      raw[i] = held;
    } else if (low < lowest && close >= lowest) {
      held = 1;
      barsLeft = holdBars - 1;
      raw[i] = held;
    }
    if (barsLeft === 0) held = 0;
  }

  return guard(candles, raw, params);
}

// 청산 캐스케이드 되받기.
// 강제청산은 가격을 보지 않고 시장가로 나온다. 그래서 거래량 급증과 함께
// 평소보다 훨씬 큰 봉이 만들어지고, 그 과도한 부분은 되돌려지는 경향이 있다.
// 두 조건을 모두 요구한다 — 거래량 없는 큰 봉은 그냥 추세이고,
// 큰 봉 없는 거래량 급증은 그냥 관심이다.
function liquidationFade(candles, params = {}) {
  const { lookback = 50, volMult = 3, rangeMult = 2, holdBars = 3 } = params;
  assertPositiveInt(lookback, 'lookback');
  assertPositiveInt(holdBars, 'holdBars');

  const raw = new Array(candles.length).fill(0);
  let held = 0;
  let barsLeft = 0;

  for (let i = lookback; i < candles.length; i += 1) {
    if (barsLeft > 0) {
      barsLeft -= 1;
      raw[i] = held;
      if (barsLeft === 0) held = 0;
      continue;
    }

    const window = candles.slice(i - lookback, i);
    const avgVol = window.reduce((a, c) => a + c.volume, 0) / window.length;
    const avgRange = window.reduce((a, c) => a + (c.high - c.low), 0) / window.length;
    const c = candles[i];
    const range = c.high - c.low;

    if (avgVol > 0 && avgRange > 0 && c.volume >= avgVol * volMult && range >= avgRange * rangeMult) {
      // 봉의 방향과 반대로 선다.
      const dir = c.close < c.open ? 1 : c.close > c.open ? -1 : 0;
      if (dir !== 0) {
        held = dir;
        barsLeft = holdBars - 1;
        raw[i] = held;
      }
    }
    if (barsLeft === 0) held = 0;
  }

  return guard(candles, raw, params);
}

const STRATEGIES = {
  stopRunReversal,
  liquidationFade,
  always,
  never,
  volTarget,
  portfolio,
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
  stopRunReversal,
  liquidationFade,
  always,
  never,
  volTarget,
  portfolio,
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
