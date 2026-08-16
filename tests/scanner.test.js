const { test } = require('node:test');
const assert = require('node:assert/strict');

const { detectBreakout, scoreCandidate, rankCandidates } = require('../src/scanner');

const MIN = 60000;

// [고가, 저가, 종가, 거래량] → 시가는 직전 종가로 잇는다
function bars(rows) {
  return rows.map(([high, low, close, volume], i) => ({
    openTime: i * MIN,
    open: i === 0 ? close : rows[i - 1][2],
    high,
    low,
    close,
    volume,
    closeTime: i * MIN + MIN - 1,
  }));
}

const flat = (n, close = 100, vol = 10) =>
  Array.from({ length: n }, () => [close + 1, close - 1, close, vol]);

// ---- detectBreakout ----
// 돌파는 두 조건을 **모두** 요구한다. 거래량 없는 돌파는 얇은 호가가 밀린 것이고,
// 돌파 없는 거래량은 그냥 관심이다. 하나만 보면 가짜 신호가 쏟아진다.

test('detectBreakout: 직전 고가를 넘고 거래량이 급증하면 돌파', () => {
  const c = bars([...flat(30), [110, 100, 109, 100]]);
  const r = detectBreakout(c, { lookback: 20, volMult: 3 });
  assert.equal(r.isBreakout, true);
  assert.equal(r.level, 101, '직전 20봉 최고가');
  assert.ok(r.volumeRatio >= 3);
});

test('detectBreakout: 거래량이 평범하면 돌파로 보지 않는다', () => {
  const c = bars([...flat(30), [110, 100, 109, 11]]);
  assert.equal(detectBreakout(c, { lookback: 20, volMult: 3 }).isBreakout, false);
});

test('detectBreakout: 고가를 못 넘으면 거래량이 터져도 돌파가 아니다', () => {
  const c = bars([...flat(30), [100.5, 99, 100, 500]]);
  assert.equal(detectBreakout(c, { lookback: 20, volMult: 3 }).isBreakout, false);
});

test('detectBreakout: 종가가 돌파선 아래로 되밀리면 돌파가 아니다 (가짜 돌파)', () => {
  // 고가는 110까지 갔으나 종가가 직전 고가(101) 아래로 복귀
  const c = bars([...flat(30), [110, 99, 100, 500]]);
  assert.equal(detectBreakout(c, { lookback: 20, volMult: 3 }).isBreakout, false);
});

test('detectBreakout: 돌파 폭을 ATR 대비로 함께 낸다', () => {
  const c = bars([...flat(30), [110, 100, 109, 100]]);
  const r = detectBreakout(c, { lookback: 20, volMult: 3 });
  assert.ok(r.atr > 0);
  assert.ok(r.breakoutAtrRatio > 0, '돌파 폭 / ATR');
});

test('detectBreakout: 봉이 모자라면 돌파가 아니다 (신규 상장 방어)', () => {
  assert.equal(detectBreakout(bars(flat(5)), { lookback: 20, volMult: 3 }).isBreakout, false);
});

test('detectBreakout: 룩백이 양의 정수가 아니면 RangeError', () => {
  assert.throws(() => detectBreakout(bars(flat(30)), { lookback: 0 }), RangeError);
});

// ---- scoreCandidate ----
// 스프레드가 넓으면 아무리 좋은 돌파여도 후보가 될 수 없다 — 비용이 익절폭을 먹는다.

test('scoreCandidate: 손익분기 승률이 1을 넘으면 실행 불가', () => {
  const r = scoreCandidate({
    symbol: 'XYZ',
    breakout: { isBreakout: true, breakoutAtrRatio: 2, volumeRatio: 5 },
    spreadBps: 60,
    feeBpsRoundTrip: 8,
    takeProfitBps: 30,
    stopLossBps: 50,
    tradeValue24h: 1e9,
    maxSpreadBps: 999, // 스프레드 관문을 열어 승률 조건만 격리한다
  });
  assert.equal(r.executable, false);
  assert.match(r.reason, /승률/);
});

test('scoreCandidate: 거래대금이 최소 기준 미만이면 실행 불가', () => {
  const r = scoreCandidate({
    symbol: 'XYZ',
    breakout: { isBreakout: true, breakoutAtrRatio: 2, volumeRatio: 5 },
    spreadBps: 5,
    feeBpsRoundTrip: 8,
    takeProfitBps: 200,
    stopLossBps: 100,
    tradeValue24h: 1e6,
    minTradeValue24h: 1e8,
  });
  assert.equal(r.executable, false);
  assert.match(r.reason, /거래대금/);
});

test('scoreCandidate: 돌파가 아니면 실행 불가', () => {
  const r = scoreCandidate({
    symbol: 'XYZ',
    breakout: { isBreakout: false },
    spreadBps: 5, feeBpsRoundTrip: 8, takeProfitBps: 200, stopLossBps: 100, tradeValue24h: 1e9,
  });
  assert.equal(r.executable, false);
});

test('scoreCandidate: 조건을 모두 만족하면 실행 가능하고 점수를 낸다', () => {
  const r = scoreCandidate({
    symbol: 'XYZ',
    breakout: { isBreakout: true, breakoutAtrRatio: 2, volumeRatio: 5 },
    spreadBps: 4,
    feeBpsRoundTrip: 8,
    takeProfitBps: 200,
    stopLossBps: 100,
    tradeValue24h: 1e10,
  });
  assert.equal(r.executable, true);
  assert.ok(r.score > 0);
  assert.ok(r.breakevenWinRate < 1);
});

test('scoreCandidate: 스프레드가 넓을수록 점수가 낮다', () => {
  const base = {
    symbol: 'XYZ',
    breakout: { isBreakout: true, breakoutAtrRatio: 2, volumeRatio: 5 },
    feeBpsRoundTrip: 8, takeProfitBps: 200, stopLossBps: 100, tradeValue24h: 1e10,
  };
  const tight = scoreCandidate({ ...base, spreadBps: 4 });
  const wide = scoreCandidate({ ...base, spreadBps: 30 });
  assert.ok(tight.score > wide.score);
});

// ---- rankCandidates ----

test('rankCandidates: 실행 가능한 것만 점수 내림차순으로 돌려준다', () => {
  const list = [
    { symbol: 'A', executable: true, score: 1 },
    { symbol: 'B', executable: false, score: 99 },
    { symbol: 'C', executable: true, score: 5 },
  ];
  assert.deepEqual(rankCandidates(list).map((x) => x.symbol), ['C', 'A']);
});

test('rankCandidates: limit으로 상위만 자른다', () => {
  const list = [
    { symbol: 'A', executable: true, score: 1 },
    { symbol: 'C', executable: true, score: 5 },
  ];
  assert.deepEqual(rankCandidates(list, 1).map((x) => x.symbol), ['C']);
});

test('rankCandidates: 배열이 아니면 TypeError', () => {
  assert.throws(() => rankCandidates(null), TypeError);
});

// 실제 스캔에서 드러난 구멍: 스프레드 125bps 종목이 손익분기 78%로 "통과"했다.
// 100% 미만이면 통과시키는 것은 산술적 가능성만 본 것이고, 실무적으로 78%는
// 달성 불가능하다. 현실적인 상한을 따로 둔다.

test('scoreCandidate: 손익분기 승률이 실무 상한을 넘으면 실행 불가', () => {
  const base = {
    symbol: 'XYZ',
    breakout: { isBreakout: true, breakoutAtrRatio: 2, volumeRatio: 5 },
    spreadBps: 126, feeBpsRoundTrip: 8,
    takeProfitBps: 200, stopLossBps: 100, tradeValue24h: 1e10,
    maxSpreadBps: 999, // 스프레드 관문을 열어 승률 조건만 격리한다
  };
  // 손익분기 (100+134)/300 = 78%
  assert.equal(scoreCandidate(base).executable, false, '기본 상한(60%)에 걸려야 함');
  assert.match(scoreCandidate(base).reason, /승률/);
  // 상한을 풀면 통과한다 — 기본값이 막고 있다는 뜻
  assert.equal(scoreCandidate({ ...base, maxBreakevenWinRate: 0.99 }).executable, true);
});

test('scoreCandidate: 스프레드 상한을 넘으면 실행 불가', () => {
  const r = scoreCandidate({
    symbol: 'XYZ',
    breakout: { isBreakout: true, breakoutAtrRatio: 2, volumeRatio: 5 },
    spreadBps: 60, feeBpsRoundTrip: 8,
    takeProfitBps: 1000, stopLossBps: 100, tradeValue24h: 1e10,
    maxSpreadBps: 30,
  });
  assert.equal(r.executable, false);
  assert.match(r.reason, /스프레드/);
});

test('scoreCandidate: 스프레드가 상한 이내면 통과한다', () => {
  const r = scoreCandidate({
    symbol: 'XYZ',
    breakout: { isBreakout: true, breakoutAtrRatio: 2, volumeRatio: 5 },
    spreadBps: 10, feeBpsRoundTrip: 8,
    takeProfitBps: 300, stopLossBps: 100, tradeValue24h: 1e10,
    maxSpreadBps: 30,
  });
  assert.equal(r.executable, true);
});
