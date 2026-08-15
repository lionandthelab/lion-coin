const { test } = require('node:test');
const assert = require('node:assert/strict');

const { sma, ema, rsi, atr, closes } = require('../src/indicators');

const near = (actual, expected, msg) =>
  assert.ok(Math.abs(actual - expected) < 1e-9, `${msg ?? ''} — got ${actual}, want ${expected}`);

function candle(high, low, close) {
  return { openTime: 0, open: close, high, low, close, volume: 1, closeTime: 0 };
}

// ---- 공통 규약 ----
// 모든 지표는 입력과 길이가 같은 배열을 돌려주고, 워밍업 구간은 null로 채운다.
// 그래야 캔들 인덱스 i와 지표 인덱스 i가 항상 같은 봉을 가리킨다 (신호 정렬 사고 차단).

test('sma: 워밍업 구간은 null, 이후는 이동평균', () => {
  assert.deepEqual(sma([1, 2, 3, 4, 5], 3), [null, null, 2, 3, 4]);
});

test('sma: period가 데이터보다 길면 전부 null', () => {
  assert.deepEqual(sma([1, 2], 5), [null, null]);
});

test('sma: period 1은 원본 값 그대로', () => {
  assert.deepEqual(sma([3, 1, 4], 1), [3, 1, 4]);
});

test('ema: 첫 값은 SMA로 시드하고 이후 2/(period+1) 가중', () => {
  // period 3 → k=0.5. 시드 (1+2+3)/3=2 → (4-2)*0.5+2=3 → (5-3)*0.5+3=4
  assert.deepEqual(ema([1, 2, 3, 4, 5], 3), [null, null, 2, 3, 4]);
});

test('ema: 값이 일정하면 EMA도 같은 값', () => {
  assert.deepEqual(ema([5, 5, 5, 5], 2), [null, 5, 5, 5]);
});

test('rsi: 계속 오르면 100, 계속 내리면 0', () => {
  assert.deepEqual(rsi([1, 2, 3, 4, 5], 2), [null, null, 100, 100, 100]);
  assert.deepEqual(rsi([5, 4, 3, 2, 1], 2), [null, null, 0, 0, 0]);
});

test('rsi: Wilder 평활 — 손계산 값과 일치', () => {
  // 값 [10,11,10,11], period 2
  // 변화 +1, -1, +1 → avgGain[2]=0.5 avgLoss[2]=0.5 → RSI 50
  // avgGain[3]=(0.5+1)/2=0.75 avgLoss[3]=(0.5+0)/2=0.25 → RS 3 → RSI 75
  const r = rsi([10, 11, 10, 11], 2);
  assert.equal(r[0], null);
  assert.equal(r[1], null);
  near(r[2], 50);
  near(r[3], 75);
});

test('atr: True Range를 Wilder 평활한다 — 손계산 값과 일치', () => {
  // TR0 = 10-8 = 2
  // TR1 = max(12-9, |12-9|, |9-9|) = 3     (직전 종가 9)
  // TR2 = max(13-12, |13-11|, |12-11|) = 2 (직전 종가 11)
  // period 2 → atr[1]=(2+3)/2=2.5, atr[2]=(2.5*1+2)/2=2.25
  const a = atr([candle(10, 8, 9), candle(12, 9, 11), candle(13, 12, 12.5)], 2);
  assert.equal(a[0], null);
  near(a[1], 2.5);
  near(a[2], 2.25);
});

test('atr: 갭이 벌어지면 고저폭이 아니라 직전 종가 기준 폭을 쓴다', () => {
  // 직전 종가 9에서 갭 상승: 고저폭 1보다 |20-9|=11이 커야 한다
  const a = atr([candle(10, 8, 9), candle(20, 19, 19.5)], 1);
  near(a[1], 11);
});

// ---- 입력 검증 ----

test('지표: period가 양의 정수가 아니면 RangeError', () => {
  assert.throws(() => sma([1, 2, 3], 0), RangeError);
  assert.throws(() => ema([1, 2, 3], -1), RangeError);
  assert.throws(() => rsi([1, 2, 3], 1.5), RangeError);
  assert.throws(() => atr([candle(1, 1, 1)], 0), RangeError);
});

test('지표: 값 배열에 유한수가 아닌 항목이 있으면 TypeError', () => {
  assert.throws(() => sma([1, NaN, 3], 2), TypeError);
  assert.throws(() => ema([1, '2', 3], 2), TypeError);
  assert.throws(() => rsi(null, 2), TypeError);
});

test('closes: 캔들 배열에서 종가 시계열을 뽑는다', () => {
  assert.deepEqual(closes([candle(10, 8, 9), candle(12, 9, 11)]), [9, 11]);
});
