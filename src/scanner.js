'use strict';

// 돌파 스캐너 — 여러 마켓을 순환하며 돌파 순간을 포착한다. 순수 함수.
//
// 돌파 판정은 세 조건을 **모두** 요구한다:
//   1. 직전 N봉 고가 돌파
//   2. 거래량 급증 — 거래량 없는 돌파는 얇은 호가가 잠깐 밀린 것이다
//   3. 종가가 돌파선 위에서 마감 — 되밀린 것은 가짜 돌파다
//
// 그리고 후보 자격은 신호가 아니라 **비용**이 정한다. 스프레드가 넓으면
// 아무리 좋은 돌파여도 익절폭을 비용이 먹는다 (docs 참조: 빗썸 101위 밖은
// 스프레드 중앙 36bps).

const { atr } = require('./indicators');
const { breakevenWinRate } = require('./bracket');

function assertPositiveInt(value, name) {
  if (!Number.isInteger(value) || value < 1) {
    throw new RangeError(`${name}은(는) 양의 정수여야 합니다: ${value}`);
  }
}

// 거래소가 돌려주는 마지막 봉은 진행 중이다. 그 봉으로 판정하면 "종가가 돌파선
// 위에서 마감" 조건이 현재가에 불과해 매 초 뒤집히고, 거래량은 봉의 경과 비율만큼만
// 쌓여 있어 배수 조건이 봉 초반엔 거의 안 걸리고 후반엔 쉽게 걸린다.
// 무엇보다 백테스트는 완성된 봉을 쓰므로, 이걸 안 버리면 실거래가 다른 전략이 된다.
function dropUnclosedCandle(candles, intervalMs, now = Date.now()) {
  if (!Array.isArray(candles) || candles.length === 0) return candles || [];
  const last = candles[candles.length - 1];
  return now < last.openTime + intervalMs ? candles.slice(0, -1) : candles;
}

const NO_BREAKOUT = {
  isBreakout: false,
  level: null,
  volumeRatio: 0,
  atr: 0,
  breakoutAtrRatio: 0,
};

function detectBreakout(candles, { lookback = 20, volMult = 3, atrPeriod = 14 } = {}) {
  assertPositiveInt(lookback, 'lookback');
  assertPositiveInt(atrPeriod, 'atrPeriod');
  if (!Array.isArray(candles)) {
    throw new TypeError('candles는 배열이어야 합니다');
  }
  // 신규 상장 종목은 봉이 모자란다. 없는 과거를 추정해 돌파를 만들어내지 않는다.
  if (candles.length < Math.max(lookback, atrPeriod) + 1) return { ...NO_BREAKOUT };

  const i = candles.length - 1;
  const window = candles.slice(i - lookback, i);
  const level = Math.max(...window.map((c) => c.high));
  const avgVol = window.reduce((s, c) => s + c.volume, 0) / window.length;
  const last = candles[i];

  const atrSeries = atr(candles, atrPeriod);
  const a = atrSeries[i] ?? 0;
  const volumeRatio = avgVol > 0 ? last.volume / avgVol : 0;

  // 고가만 넘고 종가가 되밀린 것은 가짜 돌파다 — 스탑만 털고 돌아오는 움직임이다.
  const brokeOut = last.high > level && last.close > level;
  const isBreakout = brokeOut && volumeRatio >= volMult;

  return {
    isBreakout,
    level,
    volumeRatio,
    atr: a,
    // 돌파 폭을 변동성으로 정규화한다 — 종목마다 1%의 의미가 다르다.
    breakoutAtrRatio: a > 0 ? (last.close - level) / a : 0,
    closePrice: last.close,
  };
}

// 반전 신호 — 거래량 급증을 동반한 급락 직후의 되돌림을 노린다.
//
// **왜 돌파의 반대인가:** 검증에서 돌파 진입은 무작위 진입보다 조직적으로 나빴다.
// 320개 파라미터 조합 중 315개에서 기여가 음수였다. 절반쯤 음수면 잡음이지만
// 98%가 음수인 건 방향을 가리킨다 — 30분봉에서 거래량 터진 돌파를 사는 건
// 단기 고점을 사는 것이다.
//
// 그 반대를 보류해 둔 24종목에서 검증했고 재현됐다: 승률 48.9% vs 무작위 35.1%,
// 기여 +37.0bps (t=4.30). 시간 4분할에서도 네 구간 모두 무작위를 이겼다.
// ⚠ 단, 비용 차감 후 순기대값은 +12.7bps로 얇다 — docs/reversal-validation.md 참조.
//
// 판정은 돌파와 대칭이다. 세 조건을 모두 요구한다:
//   1. 직전 N봉 저가 하향 이탈
//   2. 거래량 급증 — 조용한 하락은 되돌릴 에너지가 없다
//   3. 종가가 이탈선 아래에서 마감 — 아래꼬리만 달고 회복한 봉은 되돌림이 이미 끝났다
function detectReversal(candles, { lookback = 20, volMult = 5, atrPeriod = 14 } = {}) {
  assertPositiveInt(lookback, 'lookback');
  assertPositiveInt(atrPeriod, 'atrPeriod');
  if (!Array.isArray(candles)) {
    throw new TypeError('candles는 배열이어야 합니다');
  }
  if (candles.length < Math.max(lookback, atrPeriod) + 1) return { ...NO_BREAKOUT };

  const i = candles.length - 1;
  const window = candles.slice(i - lookback, i);
  const level = Math.min(...window.map((c) => c.low));
  const avgVol = window.reduce((s, c) => s + c.volume, 0) / window.length;
  const last = candles[i];

  const a = atr(candles, atrPeriod)[i] ?? 0;
  const volumeRatio = avgVol > 0 ? last.volume / avgVol : 0;

  const brokeDown = last.low < level && last.close < level;

  return {
    // 하위 로직(scoreCandidate·엔진)이 신호 종류를 몰라도 되도록 같은 키를 쓴다.
    isBreakout: brokeDown && volumeRatio >= volMult,
    level,
    volumeRatio,
    atr: a,
    // 깊게 이탈할수록 커지도록 부호를 뒤집는다 — 점수 계산이 양수를 전제한다.
    breakoutAtrRatio: a > 0 ? (level - last.close) / a : 0,
    closePrice: last.close,
    direction: 'reversal',
  };
}

// 후보 자격 판정. 신호가 좋아도 비용이 익절폭을 먹으면 후보가 아니다.
function scoreCandidate({
  symbol,
  breakout,
  spreadBps,
  feeBpsRoundTrip = 8, // 빗썸 최저 수수료 4bps × 왕복
  takeProfitBps,
  stopLossBps,
  tradeValue24h = 0,
  minTradeValue24h = 1e8, // 24시간 거래대금 1억원
  // 산술적 가능성(<100%)과 실무적 달성 가능성은 다르다. 첫 실전 스캔에서
  // 스프레드 125bps 종목이 손익분기 78%로 "통과"했는데, 78%는 달성 불가능한
  // 승률이다. 현실적인 상한을 따로 둔다.
  maxBreakevenWinRate = 0.6,
  maxSpreadBps = 30,
} = {}) {
  const costBps = feeBpsRoundTrip + (spreadBps || 0);
  const be = breakevenWinRate({ tpBps: takeProfitBps, slBps: stopLossBps, costBps });

  let reason = null;
  if (!breakout || !breakout.isBreakout) {
    reason = '돌파 조건 미충족';
  } else if (spreadBps > maxSpreadBps) {
    reason = `스프레드 ${spreadBps.toFixed(0)}bps > 상한 ${maxSpreadBps}bps — 진입·청산만으로 익절폭을 먹습니다`;
  } else if (be > maxBreakevenWinRate) {
    reason =
      `손익분기 승률 ${(be * 100).toFixed(0)}% > 상한 ${(maxBreakevenWinRate * 100).toFixed(0)}% — ` +
      `익절폭(${takeProfitBps}bps)이 왕복 비용(${costBps.toFixed(0)}bps)에 비해 좁습니다`;
  } else if (tradeValue24h < minTradeValue24h) {
    reason = `24시간 거래대금 ${(tradeValue24h / 1e8).toFixed(2)}억원 < 기준 ${(minTradeValue24h / 1e8).toFixed(0)}억원`;
  }

  // 점수: 돌파 강도 × 거래량 강도 ÷ 비용. 비용이 분모에 있는 것이 핵심이다.
  const score =
    reason === null
      ? ((breakout.breakoutAtrRatio + 0.5) * Math.log10(breakout.volumeRatio + 1) * 100) / costBps
      : 0;

  return {
    symbol,
    executable: reason === null,
    reason,
    score,
    costBps,
    breakevenWinRate: be,
    spreadBps,
    tradeValue24h,
    breakout,
  };
}

function rankCandidates(list, limit = Infinity) {
  if (!Array.isArray(list)) {
    throw new TypeError('list는 배열이어야 합니다');
  }
  return list
    .filter((x) => x.executable)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

module.exports = { detectBreakout, detectReversal, scoreCandidate, rankCandidates, dropUnclosedCandle };
