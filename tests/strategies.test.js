const { test } = require('node:test');
const assert = require('node:assert/strict');

const { emaCross, rsiReversion, donchianBreakout, STRATEGIES } = require('../src/strategies');

const HOUR = 3600000;

// 종가만 움직이는 캔들 (고가=저가=종가) — 지표 로직만 분리해 보기 위한 픽스처
function fromCloses(closes) {
  return closes.map((close, i) => ({
    openTime: i * HOUR,
    open: close,
    high: close,
    low: close,
    close,
    volume: 1,
    closeTime: i * HOUR + HOUR - 1,
  }));
}

function ohlc(rows) {
  return rows.map(([high, low, close], i) => ({
    openTime: i * HOUR,
    open: close,
    high,
    low,
    close,
    volume: 1,
    closeTime: i * HOUR + HOUR - 1,
  }));
}

// 가드는 별도 모듈(risk.js)에서 검증하므로, 여기서는 신호 로직만 본다.
const NO_GUARDS = { atrStopMult: null, dailyLossLimitPct: null };

// ---- emaCross ----

test('emaCross: 빠른 EMA가 느린 EMA 위에 있으면 1, 워밍업 구간은 0', () => {
  // 종가 1..6, fast 2 / slow 3 → i=2부터 빠른 EMA가 위
  const out = emaCross(fromCloses([1, 2, 3, 4, 5, 6]), { fast: 2, slow: 3, ...NO_GUARDS });
  assert.deepEqual(out, [0, 0, 1, 1, 1, 1]);
});

test('emaCross: 하락 추세에서는 진입하지 않는다', () => {
  const out = emaCross(fromCloses([6, 5, 4, 3, 2, 1]), { fast: 2, slow: 3, ...NO_GUARDS });
  assert.deepEqual(out, [0, 0, 0, 0, 0, 0]);
});

test('emaCross: fast가 slow보다 크거나 같으면 RangeError', () => {
  const candles = fromCloses([1, 2, 3, 4]);
  assert.throws(() => emaCross(candles, { fast: 3, slow: 3 }), RangeError);
  assert.throws(() => emaCross(candles, { fast: 5, slow: 2 }), RangeError);
});

// ---- rsiReversion ----

test('rsiReversion: RSI가 buyBelow 아래면 진입, sellAbove 위면 청산', () => {
  // 종가 [10,11,10,11], period 2 → RSI [null, null, 50, 75]
  const out = rsiReversion(fromCloses([10, 11, 10, 11]), {
    rsiPeriod: 2,
    buyBelow: 60,
    sellAbove: 70,
    ...NO_GUARDS,
  });
  assert.deepEqual(out, [0, 0, 1, 0]);
});

test('rsiReversion: 두 임계 사이에서는 직전 포지션을 유지한다 (히스테리시스)', () => {
  // RSI 75는 buyBelow(60)와 sellAbove(90) 사이 → 진입 상태 유지
  const out = rsiReversion(fromCloses([10, 11, 10, 11]), {
    rsiPeriod: 2,
    buyBelow: 60,
    sellAbove: 90,
    ...NO_GUARDS,
  });
  assert.deepEqual(out, [0, 0, 1, 1]);
});

test('rsiReversion: 임계값 순서가 뒤집히면 RangeError', () => {
  const candles = fromCloses([10, 11, 10, 11]);
  assert.throws(() => rsiReversion(candles, { buyBelow: 80, sellAbove: 20 }), RangeError);
});

// ---- donchianBreakout ----

test('donchianBreakout: 직전 N봉 최고가를 넘으면 진입, 직전 M봉 최저가를 깨면 청산', () => {
  const candles = ohlc([
    [10, 9, 10],
    [11, 10, 11],
    [12, 11, 12], // 직전 2봉 최고가 11 돌파 → 진입
    [13, 9, 9], // 직전 2봉 최저가 10 이탈 → 청산
  ]);
  const out = donchianBreakout(candles, { entryLookback: 2, exitLookback: 2, ...NO_GUARDS });
  assert.deepEqual(out, [0, 0, 1, 0]);
});

test('donchianBreakout: 룩백이 모자란 구간은 0', () => {
  const candles = ohlc([
    [10, 9, 10],
    [20, 9, 20],
  ]);
  const out = donchianBreakout(candles, { entryLookback: 5, exitLookback: 5, ...NO_GUARDS });
  assert.deepEqual(out, [0, 0]);
});

test('donchianBreakout: 룩백이 양의 정수가 아니면 RangeError', () => {
  const candles = ohlc([[10, 9, 10]]);
  assert.throws(() => donchianBreakout(candles, { entryLookback: 0 }), RangeError);
  assert.throws(() => donchianBreakout(candles, { exitLookback: -2 }), RangeError);
});

// ---- 공통 규약 ----

test('모든 전략: 캔들과 길이가 같고 0/1로만 이뤄진 배열을 돌려준다', () => {
  const candles = fromCloses([10, 11, 12, 11, 10, 11, 12, 13, 12, 11, 10, 12, 14, 13, 15, 16]);
  for (const [name, fn] of Object.entries(STRATEGIES)) {
    const out = fn(candles, {});
    assert.equal(out.length, candles.length, `${name}: 길이 불일치`);
    assert.ok(
      out.every((p) => p === 0 || p === 1),
      `${name}: 0/1이 아닌 값이 섞였다`
    );
  }
});

test('모든 전략: 가드를 켜면 손절이 걸려 포지션이 더 짧아지거나 같아진다', () => {
  // 급락 구간에서 가드가 포지션을 줄이는지 확인
  const closes = [10, 11, 12, 13, 14, 15, 16, 17, 18, 12, 11, 10, 9, 8, 7, 6];
  const candles = fromCloses(closes);
  for (const [name, fn] of Object.entries(STRATEGIES)) {
    const free = fn(candles, NO_GUARDS).reduce((a, b) => a + b, 0);
    const guarded = fn(candles, { atrStopMult: 1, dailyLossLimitPct: 3 }).reduce((a, b) => a + b, 0);
    assert.ok(guarded <= free, `${name}: 가드를 켰는데 포지션이 늘었다 (${guarded} > ${free})`);
  }
});
