const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  detectBreakout,
  scoreCandidate,
  rankCandidates,
  dropUnclosedCandle,
  detectReversal,
} = require('../src/scanner');

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

// 실거래에서 발견: 거래소가 돌려주는 마지막 봉은 **진행 중**이다.
// 그 봉으로 판정하면 (1) "종가가 돌파선 위" 조건이 현재가에 불과해 매 초 뒤집히고
// (2) 거래량이 봉의 경과 비율만큼만 쌓여 있어 배수 조건이 봉 초반엔 거의 안 걸리고
// 후반엔 쉽게 걸린다. 무엇보다 백테스트는 완성된 봉을 쓰므로 둘이 다른 전략이 된다.

test('dropUnclosedCandle: 진행 중인 마지막 봉을 버린다', () => {
  const interval = 5 * 60000;
  const now = 1000 * interval + 60000; // 마지막 봉 시작 후 60초
  const c = bars(flat(30)).map((x, i) => ({ ...x, openTime: (971 + i) * interval }));
  const out = dropUnclosedCandle(c, interval, now);
  assert.equal(out.length, c.length - 1);
  assert.equal(out.at(-1).openTime, c.at(-2).openTime);
});

test('dropUnclosedCandle: 마지막 봉이 이미 닫혔으면 그대로 둔다', () => {
  const interval = 5 * 60000;
  const c = bars(flat(5)).map((x, i) => ({ ...x, openTime: (100 + i) * interval }));
  const now = c.at(-1).openTime + interval + 1000; // 봉이 끝난 뒤
  assert.equal(dropUnclosedCandle(c, interval, now).length, c.length);
});

test('dropUnclosedCandle: 봉이 하나뿐이고 진행 중이면 빈 배열', () => {
  const interval = 60000;
  const c = [{ openTime: 0, open: 1, high: 1, low: 1, close: 1, volume: 1, closeTime: 59999 }];
  assert.deepEqual(dropUnclosedCandle(c, interval, 30000), []);
});

test('dropUnclosedCandle: 빈 배열은 그대로', () => {
  assert.deepEqual(dropUnclosedCandle([], 60000, 0), []);
});

// ---- 반전 신호 (detectReversal) ----
//
// 돌파 진입은 검증에서 무작위보다 **조직적으로 나빴다** — 320개 조합 중 315개에서
// 기여가 음수였다. 이건 잡음이 아니라 방향을 가리킨다: 거래량 급증을 동반한 급락
// 직후에는 되돌림이 온다. 그 반대 신호가 보류해 둔 24종목에서 재현됐다
// (승률 48.9% vs 무작위 35.1%, t=4.30). docs/reversal-validation.md 참조.
//
// 구조는 돌파와 대칭이다 — scoreCandidate가 그대로 받도록 같은 모양을 돌려준다.

const FLAT = Array.from({ length: 20 }, () => [101, 99, 100, 10]);

test('detectReversal: 거래량 급증을 동반해 직전 N봉 저가를 깨면 신호', () => {
  const c = bars([...FLAT, [99, 97, 97.5, 60]]);
  const r = detectReversal(c, { lookback: 20, volMult: 5, atrPeriod: 14 });
  assert.equal(r.isBreakout, true);
  assert.equal(r.level, 99, '기준선은 직전 20봉의 최저 저가');
  assert.ok(r.volumeRatio >= 5);
});

test('detectReversal: 저가만 깨고 종가가 되돌아오면 신호가 아니다', () => {
  // 아래꼬리만 달고 회복한 봉은 되돌림이 이미 일어난 뒤다 — 먹을 게 남아 있지 않다
  const c = bars([...FLAT, [100, 97, 99.5, 60]]);
  assert.equal(detectReversal(c, { lookback: 20, volMult: 5 }).isBreakout, false);
});

test('detectReversal: 거래량이 안 터지면 신호가 아니다', () => {
  const c = bars([...FLAT, [99, 97, 97.5, 12]]);
  assert.equal(detectReversal(c, { lookback: 20, volMult: 5 }).isBreakout, false);
});

test('detectReversal: 이탈 깊이를 변동성으로 정규화해 돌려준다', () => {
  // 종목마다 1%의 의미가 다르다. 점수 산정이 이 값을 쓴다.
  const shallow = detectReversal(bars([...FLAT, [99, 98.5, 98.8, 60]]), { lookback: 20, volMult: 5 });
  const deep = detectReversal(bars([...FLAT, [99, 96, 96.5, 60]]), { lookback: 20, volMult: 5 });
  assert.ok(deep.breakoutAtrRatio > shallow.breakoutAtrRatio, '깊게 이탈할수록 커져야 한다');
  assert.ok(deep.breakoutAtrRatio > 0);
});

test('detectReversal: 봉이 모자라면 신호를 만들어내지 않는다', () => {
  assert.equal(detectReversal(bars(FLAT.slice(0, 5)), { lookback: 20, volMult: 5 }).isBreakout, false);
});

test('detectReversal: scoreCandidate가 그대로 받을 수 있는 모양이다', () => {
  const s = scoreCandidate({
    symbol: 'TEST',
    breakout: detectReversal(bars([...FLAT, [99, 97, 97.5, 60]]), { lookback: 20, volMult: 5 }),
    spreadBps: 10, takeProfitBps: 500, stopLossBps: 200, tradeValue24h: 1e9,
  });
  assert.equal(s.executable, true, s.reason);
  assert.ok(s.score > 0);
});
