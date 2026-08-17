'use strict';

// 시장 국면 판정 — 순수 함수.
//
// **왜 필요한가:** 전 구간 평균으로 전략을 평가하면 서로 다른 시장이 섞인다.
// 실제로 반전 전략은 구간마다 순기대값이 −4bps에서 +35bps까지 흔들렸다.
// 국면을 나누면 안 되는 구간에서 손을 뗄 수 있다.
//
// ⚠ **인과성이 유일한 안전 요건이다.** i봉의 국면을 정할 때 i봉 이후를 한 톨이라도
// 보면 백테스트에서만 잘 되고 실전에서 재현되지 않는다. 전 구간을 눈으로 보고
// "여기는 하락장이었다"고 나누는 것이 정확히 그 실수다.
//
// ⚠ **이 모듈은 국면을 매길 뿐, 어느 국면에서 매매할지는 정하지 않는다.**
// 정적으로 고른 국면(bear/turbulent만 매매)은 심볼 홀드아웃을 세 번 통과하고도
// 시간축 홀드아웃에서 −31.7bps로 뒤집혔다. 국면은 BTC 하나가 정하므로 심볼을
// 나눠도 독립 표본이 생기지 않았기 때문이다 — 같은 급락 에피소드를 다시 센 것이다.
// 국면별 매매 여부는 반드시 그 시점까지의 성적으로만 판단해야 한다.
// 상세: docs/regime-validation.md

const TREND_BARS = 48; // 30분봉 48개 = 24시간
const VOL_BARS = 48;
const PCT_BARS = 480; // 변동성 백분위 기준 10일

const BEAR_THRESHOLD = -0.02;
const BULL_THRESHOLD = 0.02;
const CALM_PCT = 0.33;
const TURBULENT_PCT = 0.67;

const NO_REGIME = { label: null, trend: null, vol: null, trendReturn: null, volPercentile: null };

// 마지막 VOL_BARS개 로그수익률의 표준편차
function realizedVol(candles, end) {
  let sum = 0;
  let sumSq = 0;
  for (let k = end - VOL_BARS + 1; k <= end; k += 1) {
    const r = Math.log(candles[k].close / candles[k - 1].close);
    sum += r;
    sumSq += r * r;
  }
  const mean = sum / VOL_BARS;
  return Math.sqrt(Math.max(0, sumSq / VOL_BARS - mean * mean));
}

const WARMUP = Math.max(TREND_BARS, PCT_BARS + VOL_BARS);

// 배열의 **마지막 봉** 기준 국면. 인과성은 여기서 보장된다 —
// 마지막 봉보다 뒤를 참조할 방법 자체가 없다.
function classifyRegime(candles) {
  if (!Array.isArray(candles)) {
    throw new TypeError('candles는 배열이어야 합니다');
  }
  // 없는 과거를 추정해 국면을 붙이면 초반 구간이 통째로 거짓 신호가 된다.
  if (candles.length < WARMUP + 1) return { ...NO_REGIME };

  const i = candles.length - 1;
  const trendReturn = candles[i].close / candles[i - TREND_BARS].close - 1;

  const current = realizedVol(candles, i);
  let below = 0;
  let total = 0;
  for (let k = i - PCT_BARS; k < i; k += 1) {
    if (k < VOL_BARS) continue;
    total += 1;
    if (realizedVol(candles, k) < current) below += 1;
  }
  const volPercentile = total > 0 ? below / total : 0;

  const trend = trendReturn < BEAR_THRESHOLD ? 'bear' : trendReturn > BULL_THRESHOLD ? 'bull' : 'flat';
  const vol = volPercentile < CALM_PCT ? 'calm' : volPercentile > TURBULENT_PCT ? 'turbulent' : 'normal';

  return { label: `${trend}/${vol}`, trend, vol, trendReturn, volPercentile };
}

// 봉마다의 국면. classifyRegime을 매 시점 잘라 부르는 것과 같은 결과를 내되,
// 변동성을 한 번만 계산해 O(n²)를 피한다.
function regimeSeries(candles) {
  if (!Array.isArray(candles)) {
    throw new TypeError('candles는 배열이어야 합니다');
  }
  const out = new Array(candles.length).fill(null);
  if (candles.length < WARMUP + 1) return out;

  const vols = new Array(candles.length).fill(null);
  for (let i = VOL_BARS; i < candles.length; i += 1) vols[i] = realizedVol(candles, i);

  for (let i = WARMUP; i < candles.length; i += 1) {
    const trendReturn = candles[i].close / candles[i - TREND_BARS].close - 1;

    let below = 0;
    let total = 0;
    for (let k = i - PCT_BARS; k < i; k += 1) {
      if (vols[k] == null) continue;
      total += 1;
      if (vols[k] < vols[i]) below += 1;
    }
    const volPercentile = total > 0 ? below / total : 0;

    const trend = trendReturn < BEAR_THRESHOLD ? 'bear' : trendReturn > BULL_THRESHOLD ? 'bull' : 'flat';
    const vol = volPercentile < CALM_PCT ? 'calm' : volPercentile > TURBULENT_PCT ? 'turbulent' : 'normal';
    out[i] = `${trend}/${vol}`;
  }
  return out;
}

module.exports = {
  classifyRegime,
  regimeSeries,
  TREND_BARS,
  VOL_BARS,
  PCT_BARS,
  WARMUP,
};
