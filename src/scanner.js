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
} = {}) {
  const costBps = feeBpsRoundTrip + (spreadBps || 0);
  const be = breakevenWinRate({ tpBps: takeProfitBps, slBps: stopLossBps, costBps });

  let reason = null;
  if (!breakout || !breakout.isBreakout) {
    reason = '돌파 조건 미충족';
  } else if (be > 1) {
    reason =
      `손익분기 승률 ${(be * 100).toFixed(0)}% — 익절폭(${takeProfitBps}bps)이 ` +
      `왕복 비용(${costBps.toFixed(0)}bps)을 감당하지 못합니다`;
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

module.exports = { detectBreakout, scoreCandidate, rankCandidates };
