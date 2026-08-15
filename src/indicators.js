'use strict';

// 기술 지표 — 순수 함수. 모두 입력과 길이가 같은 배열을 돌려주고 워밍업 구간은 null로 채운다.
//
// 길이를 맞추는 것이 이 모듈의 유일한 규약이다. 지표 배열을 짧게 돌려주면 호출자가
// 오프셋을 손으로 맞춰야 하고, 그 오프셋이 하나만 틀려도 백테스트는 미래를 보게 된다.
// 인덱스 i의 지표값은 언제나 캔들 i의 종가까지만 반영한다.

function assertPeriod(period) {
  if (!Number.isInteger(period) || period < 1) {
    throw new RangeError(`period는 양의 정수여야 합니다: ${period}`);
  }
}

function assertSeries(values) {
  if (!Array.isArray(values)) {
    throw new TypeError('값 시계열은 배열이어야 합니다');
  }
  values.forEach((v, i) => {
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      throw new TypeError(`시계열[${i}]이 유한수가 아닙니다: ${v}`);
    }
  });
}

function sma(values, period) {
  assertSeries(values);
  assertPeriod(period);

  const out = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i += 1) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

// 첫 값은 SMA로 시드한다(널리 쓰이는 관행). 이후 k = 2/(period+1) 가중.
function ema(values, period) {
  assertSeries(values);
  assertPeriod(period);

  const out = new Array(values.length).fill(null);
  if (values.length < period) return out;

  const k = 2 / (period + 1);
  let prev = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out[period - 1] = prev;

  for (let i = period; i < values.length; i += 1) {
    prev = (values[i] - prev) * k + prev;
    out[i] = prev;
  }
  return out;
}

// Wilder 평활 RSI. 첫 값은 인덱스 period에서 나온다(변화량이 period개 모여야 하므로).
function rsi(values, period = 14) {
  assertSeries(values);
  assertPeriod(period);

  const out = new Array(values.length).fill(null);
  if (values.length <= period) return out;

  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 1; i <= period; i += 1) {
    const delta = values[i] - values[i - 1];
    avgGain += Math.max(delta, 0);
    avgLoss += Math.max(-delta, 0);
  }
  avgGain /= period;
  avgLoss /= period;

  // 손실이 0이면 RS가 무한대가 되므로 RSI 정의상 상한인 100으로 둔다.
  const toRsi = (gain, loss) => (loss === 0 ? 100 : 100 - 100 / (1 + gain / loss));
  out[period] = toRsi(avgGain, avgLoss);

  for (let i = period + 1; i < values.length; i += 1) {
    const delta = values[i] - values[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(delta, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-delta, 0)) / period;
    out[i] = toRsi(avgGain, avgLoss);
  }
  return out;
}

// True Range: 고저폭만 보면 갭을 놓치므로 직전 종가 기준 폭도 함께 본다.
function trueRanges(candles) {
  return candles.map((c, i) => {
    const range = c.high - c.low;
    if (i === 0) return range;
    const prevClose = candles[i - 1].close;
    return Math.max(range, Math.abs(c.high - prevClose), Math.abs(c.low - prevClose));
  });
}

function atr(candles, period = 14) {
  if (!Array.isArray(candles)) {
    throw new TypeError('candles는 배열이어야 합니다');
  }
  assertPeriod(period);
  candles.forEach((c, i) => {
    if (!c || ![c.high, c.low, c.close].every((v) => typeof v === 'number' && Number.isFinite(v))) {
      throw new TypeError(`candles[${i}]에 유한수 high/low/close가 없습니다`);
    }
  });

  const out = new Array(candles.length).fill(null);
  if (candles.length < period) return out;

  const tr = trueRanges(candles);
  let prev = tr.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out[period - 1] = prev;

  for (let i = period; i < candles.length; i += 1) {
    prev = (prev * (period - 1) + tr[i]) / period;
    out[i] = prev;
  }
  return out;
}

function closes(candles) {
  return candles.map((c) => c.close);
}

module.exports = { sma, ema, rsi, atr, trueRanges, closes };
