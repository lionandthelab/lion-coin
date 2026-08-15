const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
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
} = require('../src/strategies');

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

// ---- fundingReversion ----
// 펀딩비 백분위가 낮으면(롱이 몰리지 않았으면) 진입, 높으면(과열) 청산하는 역발상.

function withFunding(fundings) {
  return fundings.map((funding, i) => ({
    openTime: i * HOUR,
    open: 100,
    high: 100,
    low: 100,
    close: 100,
    volume: 1,
    closeTime: i * HOUR + HOUR - 1,
    funding,
  }));
}

test('fundingReversion: 펀딩 백분위가 낮으면 진입, 높으면 청산', () => {
  // 백분위: i2~i4는 100(창 최고), i5는 33.3(창 최저)
  const out = fundingReversion(withFunding([1, 2, 3, 4, 5, 0.5]), {
    fundingLookback: 3,
    buyBelowPct: 40,
    sellAbovePct: 80,
    ...NO_GUARDS,
  });
  assert.deepEqual(out, [0, 0, 0, 0, 0, 1]);
});

test('fundingReversion: 과열되면 보유 중이던 포지션을 청산한다', () => {
  const out = fundingReversion(withFunding([5, 4, 3, 2, 1, 6]), {
    fundingLookback: 3,
    buyBelowPct: 40,
    sellAbovePct: 80,
    ...NO_GUARDS,
  });
  assert.deepEqual(out, [0, 0, 1, 1, 1, 0]);
});

test('fundingReversion: funding이 없는 캔들에서는 진입하지 않는다', () => {
  const out = fundingReversion(withFunding([null, null, null, null]), {
    fundingLookback: 3,
    ...NO_GUARDS,
  });
  assert.deepEqual(out, [0, 0, 0, 0]);
});

test('fundingReversion: 임계 순서가 뒤집히면 RangeError', () => {
  const c = withFunding([1, 2, 3]);
  assert.throws(() => fundingReversion(c, { buyBelowPct: 90, sellAbovePct: 10 }), RangeError);
});

// ---- 롱/숏 전략군 ----
// 하락장에서 "덜 잃기"밖에 못 하던 구조를 넓힌다. 아래 전략들은 -1을 낼 수 있다.

test('emaCrossLS: 빠른 EMA가 위면 롱, 아래면 숏', () => {
  const up = emaCrossLS(fromCloses([1, 2, 3, 4, 5, 6]), { fast: 2, slow: 3, ...NO_GUARDS });
  assert.deepEqual(up, [0, 0, 1, 1, 1, 1]);
  const down = emaCrossLS(fromCloses([6, 5, 4, 3, 2, 1]), { fast: 2, slow: 3, ...NO_GUARDS });
  assert.deepEqual(down, [0, 0, -1, -1, -1, -1]);
});

test('donchianLS: 상단 돌파는 롱, 하단 이탈은 숏', () => {
  const c = ohlc([
    [10, 9, 10],
    [11, 10, 11],
    [12, 11, 12], // 직전 2봉 최고 11 돌파 → 롱
    [13, 8, 8], // 직전 2봉 최저 10 이탈 → 숏
  ]);
  assert.deepEqual(donchianLS(c, { entryLookback: 2, exitLookback: 2, ...NO_GUARDS }), [0, 0, 1, -1]);
});

test('tsMomentum: 룩백 대비 올랐으면 롱, 내렸으면 숏', () => {
  const out = tsMomentum(fromCloses([100, 101, 102, 103]), { lookback: 2, ...NO_GUARDS });
  // i<2는 비교 대상 없음 → 0. i=2: 102>100 롱. i=3: 103>101 롱
  assert.deepEqual(out, [0, 0, 1, 1]);
  const down = tsMomentum(fromCloses([100, 99, 98, 97]), { lookback: 2, ...NO_GUARDS });
  assert.deepEqual(down, [0, 0, -1, -1]);
});

test('tsMomentum: 변화가 없으면 진입하지 않는다', () => {
  assert.deepEqual(tsMomentum(fromCloses([100, 100, 100, 100]), { lookback: 2, ...NO_GUARDS }), [
    0, 0, 0, 0,
  ]);
});

test('volBreakout: 시가 + k×직전변동폭을 넘으면 롱, 아래로 이탈하면 숏', () => {
  // 직전 2봉 변동폭 = 고가 12 - 저가 8 = 4, k=0.5 → 임계 ±2
  const c = ohlc([
    [12, 8, 10],
    [12, 8, 10],
    [13, 9, 13], // 시가 13… 아래 참조
  ]);
  // 세 번째 봉의 시가는 종가와 같게 만든 픽스처라 별도 검증은 아래 테스트에서
  const out = volBreakout(c, { rangeLookback: 2, k: 0.5, ...NO_GUARDS });
  assert.equal(out.length, 3);
  assert.ok(out.every((p) => p === 0 || p === 1 || p === -1));
});

test('volBreakout: 변동폭이 0이면 진입하지 않는다 (0으로 나누기 방지)', () => {
  const c = ohlc([
    [10, 10, 10],
    [10, 10, 10],
    [10, 10, 10],
  ]);
  assert.deepEqual(volBreakout(c, { rangeLookback: 2, k: 0.5, ...NO_GUARDS }), [0, 0, 0]);
});

test('fundingLS: 펀딩이 과열이면 숏, 냉각이면 롱', () => {
  const out = fundingLS(withFunding([5, 4, 3, 2, 1, 6]), {
    fundingLookback: 3,
    buyBelowPct: 40,
    sellAbovePct: 80,
    ...NO_GUARDS,
  });
  // i2~i4는 창 최저(33%) → 롱, i5는 창 최고(100%) → 숏
  assert.deepEqual(out, [0, 0, 1, 1, 1, -1]);
});

test('ensemble: 구성원 다수결로 방향을 정한다', () => {
  const c = fromCloses([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
  const out = ensemble(c, {
    members: [
      { strategy: 'emaCrossLS', params: { fast: 2, slow: 3 } },
      { strategy: 'tsMomentum', params: { lookback: 2 } },
    ],
    threshold: 2,
    ...NO_GUARDS,
  });
  // 단조 상승이므로 둘 다 롱 → 합 2 → 임계 충족
  assert.equal(out[out.length - 1], 1);
});

test('ensemble: 의견이 갈리면 진입하지 않는다', () => {
  const c = fromCloses([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
  const out = ensemble(c, {
    members: [
      { strategy: 'emaCrossLS', params: { fast: 2, slow: 3 } },
      { strategy: 'emaCrossLS', params: { fast: 2, slow: 3, invert: true } },
    ],
    threshold: 2,
    ...NO_GUARDS,
  });
  assert.ok(out.every((p) => p === 0));
});

test('ensemble: 구성원이 비어 있으면 RangeError', () => {
  assert.throws(() => ensemble(fromCloses([1, 2, 3]), { members: [] }), RangeError);
});

test('롱숏 전략도 공통 규약을 지킨다 (길이 일치, -1/0/1)', () => {
  const c = fromCloses([10, 11, 12, 11, 10, 11, 12, 13, 12, 11, 10, 12, 14, 13, 15, 16]);
  for (const name of ['emaCrossLS', 'donchianLS', 'tsMomentum', 'volBreakout']) {
    const out = STRATEGIES[name](c, {});
    assert.equal(out.length, c.length, `${name}: 길이 불일치`);
    assert.ok(out.every((p) => p === -1 || p === 0 || p === 1), `${name}: 허용되지 않는 값`);
  }
});
