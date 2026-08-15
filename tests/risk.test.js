const { test } = require('node:test');
const assert = require('node:assert/strict');

const { applyRiskGuards } = require('../src/risk');

const HOUR = 3600000;
const DAY = 86400000;

function series(closes, startTime = 0, step = HOUR) {
  return closes.map((close, i) => ({
    openTime: startTime + i * step,
    open: close,
    high: close,
    low: close,
    close,
    volume: 1,
    closeTime: startTime + i * step + step - 1,
  }));
}

const flatAtr = (n, v = 1) => new Array(n).fill(v);

// ---- 트레일링 손절 ----
// 손절은 종가 기준으로만 판정한다. 봉 중간의 저가로 체결됐다고 가정하면
// 실제로는 못 잡았을 손절을 잡은 것처럼 백테스트가 좋아진다(체결 낙관 편향).

test('applyRiskGuards: 손절선에 닿지 않으면 원본 신호를 그대로 돌려준다', () => {
  const candles = series([100, 102, 101, 103]);
  const out = applyRiskGuards(candles, [1, 1, 1, 1], {
    atrSeries: flatAtr(4),
    atrStopMult: 2,
  });
  assert.deepEqual(out, [1, 1, 1, 1]);
});

test('applyRiskGuards: 종가가 고점 - mult×ATR 아래로 내려가면 청산으로 바꾼다', () => {
  // 고점 102, ATR 1, mult 2 → 손절선 100. c3 종가 99가 이를 뚫는다.
  const candles = series([100, 102, 101, 99]);
  const out = applyRiskGuards(candles, [1, 1, 1, 1], {
    atrSeries: flatAtr(4),
    atrStopMult: 2,
  });
  assert.deepEqual(out, [1, 1, 1, 0]);
});

test('applyRiskGuards: 손절 후에는 원본 신호가 계속 1이어도 재진입하지 않는다', () => {
  const candles = series([100, 102, 99, 101, 103]);
  const out = applyRiskGuards(candles, [1, 1, 1, 1, 1], {
    atrSeries: flatAtr(5),
    atrStopMult: 2,
  });
  assert.deepEqual(out, [1, 1, 0, 0, 0]);
});

test('applyRiskGuards: 원본 신호가 한 번 0으로 꺼진 뒤에야 재진입을 허용한다', () => {
  const candles = series([100, 102, 99, 101, 103]);
  const out = applyRiskGuards(candles, [1, 1, 1, 0, 1], {
    atrSeries: flatAtr(5),
    atrStopMult: 2,
  });
  assert.deepEqual(out, [1, 1, 0, 0, 1]);
});

test('applyRiskGuards: ATR 워밍업(null) 구간에서는 손절을 적용하지 않는다', () => {
  const candles = series([100, 50, 40]);
  const out = applyRiskGuards(candles, [1, 1, 1], {
    atrSeries: [null, null, null],
    atrStopMult: 2,
    dailyLossLimitPct: null, // 손절만 따로 보기 위해 한도는 끈다
  });
  assert.deepEqual(out, [1, 1, 1]);
});

test('applyRiskGuards: atrStopMult가 null이면 손절 자체를 끈다', () => {
  const candles = series([100, 50, 40]);
  const out = applyRiskGuards(candles, [1, 1, 1], {
    atrSeries: flatAtr(3),
    atrStopMult: null,
    dailyLossLimitPct: null,
  });
  assert.deepEqual(out, [1, 1, 1]);
});

// ---- 일일 손실 한도 ----

test('applyRiskGuards: 미실현 손실이 한도를 넘으면 즉시 청산하고 그날은 재진입 금지', () => {
  // 진입가 100 → 종가 94는 -6%, 한도 5% 초과
  const candles = series([100, 94, 94, 94]);
  const out = applyRiskGuards(candles, [1, 1, 1, 1], {
    atrSeries: flatAtr(4),
    atrStopMult: null,
    dailyLossLimitPct: 5,
  });
  assert.deepEqual(out, [1, 0, 0, 0]);
});

test('applyRiskGuards: 실현 손실이 누적돼 한도를 넘어도 그날은 재진입 금지', () => {
  const candles = series([100, 94, 94, 94]);
  const out = applyRiskGuards(candles, [1, 0, 1, 1], {
    atrSeries: flatAtr(4),
    atrStopMult: null,
    dailyLossLimitPct: 5,
  });
  assert.deepEqual(out, [1, 0, 0, 0]);
});

test('applyRiskGuards: 한도는 UTC 날짜가 바뀌면 초기화된다', () => {
  const day0 = series([100, 94, 94], 0);
  const day1 = series([94, 95], DAY);
  const out = applyRiskGuards([...day0, ...day1], [1, 1, 1, 1, 1], {
    atrSeries: flatAtr(5),
    atrStopMult: null,
    dailyLossLimitPct: 5,
  });
  assert.deepEqual(out, [1, 0, 0, 1, 1]);
});

test('applyRiskGuards: 한도 안의 손실은 건드리지 않는다', () => {
  const candles = series([100, 98, 99]);
  const out = applyRiskGuards(candles, [1, 1, 1], {
    atrSeries: flatAtr(3),
    atrStopMult: null,
    dailyLossLimitPct: 5,
  });
  assert.deepEqual(out, [1, 1, 1]);
});

test('applyRiskGuards: dailyLossLimitPct가 null이면 한도를 끈다', () => {
  const candles = series([100, 50, 50]);
  const out = applyRiskGuards(candles, [1, 1, 1], {
    atrSeries: flatAtr(3),
    atrStopMult: null,
    dailyLossLimitPct: null,
  });
  assert.deepEqual(out, [1, 1, 1]);
});

// ---- 입력 검증 ----

test('applyRiskGuards: 신호·ATR 길이가 캔들과 다르면 TypeError', () => {
  const candles = series([100, 101]);
  assert.throws(() => applyRiskGuards(candles, [1], { atrSeries: flatAtr(2) }), TypeError);
  assert.throws(() => applyRiskGuards(candles, [1, 1], { atrSeries: flatAtr(3) }), TypeError);
});

test('applyRiskGuards: 음수 배수·한도는 RangeError', () => {
  const candles = series([100, 101]);
  const atrSeries = flatAtr(2);
  assert.throws(
    () => applyRiskGuards(candles, [1, 1], { atrSeries, atrStopMult: -1 }),
    RangeError
  );
  assert.throws(
    () => applyRiskGuards(candles, [1, 1], { atrSeries, dailyLossLimitPct: -5 }),
    RangeError
  );
});
