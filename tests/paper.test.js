const { test } = require('node:test');
const assert = require('node:assert/strict');

const { evaluateCandidates, mergeHistory, summarizeArena, BUY_AND_HOLD } = require('../src/paper');

const HOUR = 3600000;

function candles(closes) {
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

const COSTS = { feeBps: 0, slippageBps: 0, initialEquity: 1000 };

// ---- evaluateCandidates ----

test('evaluateCandidates: 매수보유 기준선은 전 구간 보유한다', () => {
  const rows = evaluateCandidates([{ id: 'bh', strategy: BUY_AND_HOLD }], candles([100, 110, 120]), COSTS);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].position, 1);
  // c1 시가 110에 진입 → c2 종가 120 → 1000 × 120/110
  assert.ok(Math.abs(rows[0].summary.totalReturnPct - ((120 / 110 - 1) * 100)) < 1e-9);
});

test('evaluateCandidates: position은 마지막 봉의 목표 포지션이다 (다음 봉 시가 체결 예정)', () => {
  const rows = evaluateCandidates(
    [{ id: 'ema', strategy: 'emaCross', params: { fast: 2, slow: 3, atrStopMult: null, dailyLossLimitPct: null } }],
    candles([1, 2, 3, 4, 5, 6]),
    COSTS
  );
  assert.equal(rows[0].position, 1);
});

test('evaluateCandidates: 후보 id를 그대로 실어 돌려준다', () => {
  const rows = evaluateCandidates(
    [
      { id: 'bh', strategy: BUY_AND_HOLD },
      { id: 'ema-12-26', strategy: 'emaCross', params: {} },
    ],
    candles([100, 101, 102, 103, 104, 105, 106, 107, 108, 109, 110, 111, 112, 113, 114, 115]),
    COSTS
  );
  assert.deepEqual(rows.map((r) => r.id), ['bh', 'ema-12-26']);
});

test('evaluateCandidates: 알 수 없는 전략 이름이면 Error (조용히 건너뛰지 않는다)', () => {
  assert.throws(
    () => evaluateCandidates([{ id: 'x', strategy: 'nope' }], candles([1, 2, 3]), COSTS),
    /nope/
  );
});

test('evaluateCandidates: 후보 id가 중복되면 Error', () => {
  assert.throws(
    () =>
      evaluateCandidates(
        [{ id: 'a', strategy: BUY_AND_HOLD }, { id: 'a', strategy: BUY_AND_HOLD }],
        candles([1, 2, 3]),
        COSTS
      ),
    /중복/
  );
});

// ---- mergeHistory ----
// 하네스가 하루 두 번 돌거나 같은 회차를 재실행해도 기록이 중복되면 안 된다.

test('mergeHistory: 새 봉이면 뒤에 붙인다', () => {
  const h = [{ candleOpenTime: 0, rows: [] }];
  const out = mergeHistory(h, { candleOpenTime: HOUR, rows: [] });
  assert.equal(out.length, 2);
  assert.equal(out[1].candleOpenTime, HOUR);
});

test('mergeHistory: 같은 봉이면 마지막 항목을 교체한다 (재실행 중복 방지)', () => {
  const h = [{ candleOpenTime: 0, rows: ['old'] }];
  const out = mergeHistory(h, { candleOpenTime: 0, rows: ['new'] });
  assert.equal(out.length, 1);
  assert.deepEqual(out[0].rows, ['new']);
});

test('mergeHistory: 과거 봉이 들어오면 무시한다 (시계 역행 방어)', () => {
  const h = [{ candleOpenTime: HOUR, rows: ['keep'] }];
  const out = mergeHistory(h, { candleOpenTime: 0, rows: ['stale'] });
  assert.deepEqual(out, h);
});

test('mergeHistory: maxLen을 넘으면 오래된 것부터 버린다', () => {
  const h = [0, 1, 2].map((i) => ({ candleOpenTime: i * HOUR, rows: [] }));
  const out = mergeHistory(h, { candleOpenTime: 3 * HOUR, rows: [] }, 3);
  assert.equal(out.length, 3);
  assert.equal(out[0].candleOpenTime, HOUR);
});

test('mergeHistory: 빈 이력에도 붙는다', () => {
  assert.equal(mergeHistory([], { candleOpenTime: 0, rows: [] }).length, 1);
});

// 워밍업: 신호는 과거 캔들까지 다 보고 내되, 자산곡선은 페이퍼 시작 시점부터 잰다.
// 이게 없으면 200-EMA 전략이 페이퍼 시작 후 200봉 동안 강제로 현금 상태가 된다.

test('evaluateCandidates: equityFromIndex 이후 구간으로만 성과를 계산한다', () => {
  const c = candles([100, 110, 120, 130]);
  const all = evaluateCandidates([{ id: 'bh', strategy: BUY_AND_HOLD }], c, COSTS);
  const tail = evaluateCandidates([{ id: 'bh', strategy: BUY_AND_HOLD }], c, COSTS, {
    equityFromIndex: 2,
  });
  // 전 구간: c1 시가 110 진입 → 종가 130. 꼬리 구간: c3 시가 130 진입 → 종가 130
  assert.ok(Math.abs(all.summary?.totalReturnPct ?? all[0].summary.totalReturnPct - ((130 / 110 - 1) * 100)) < 1);
  assert.ok(Math.abs(tail[0].summary.totalReturnPct) < 1e-9, '꼬리 구간에서는 진입 즉시라 수익 0');
});

test('evaluateCandidates: 워밍업을 잘라도 신호는 전체 이력으로 계산한다', () => {
  // 종가 1..6에서 fast2/slow3 EMA는 i=2부터 1. 꼬리(i>=4)만 넘기면 워밍업이 모자라 0이 된다.
  const c = candles([1, 2, 3, 4, 5, 6]);
  const params = { fast: 2, slow: 3, atrStopMult: null, dailyLossLimitPct: null };
  const rows = evaluateCandidates([{ id: 'e', strategy: 'emaCross', params }], c, COSTS, {
    equityFromIndex: 4,
  });
  assert.equal(rows[0].position, 1, '전체 이력으로 신호를 냈으므로 보유 상태');
});

test('evaluateCandidates: equityFromIndex가 범위를 벗어나면 RangeError', () => {
  const c = candles([1, 2, 3]);
  assert.throws(
    () => evaluateCandidates([{ id: 'bh', strategy: BUY_AND_HOLD }], c, COSTS, { equityFromIndex: 3 }),
    RangeError
  );
});

// ---- summarizeArena ----
// 단일 심볼 성과가 일반화되지 않는다는 게 워크포워드 연구의 결론이었다.
// 전방 검증도 같은 규율을 따라야 하므로, 후보를 여러 심볼에서 동시에 굴리고
// 심볼을 가로질러 집계한다.

function arenaState(seriesBySymbol) {
  return {
    symbols: Object.keys(seriesBySymbol),
    candidates: [
      { id: 'bh', strategy: BUY_AND_HOLD },
      { id: 'x', strategy: 'emaCross' },
    ],
    series: Object.fromEntries(
      Object.entries(seriesBySymbol).map(([sym, rows]) => [
        sym,
        { history: [{ candleOpenTime: 0, close: 1, rows }] },
      ])
    ),
  };
}

test('summarizeArena: 후보별로 심볼을 가로질러 평균·중앙값을 낸다', () => {
  const s = arenaState({
    BTCUSDT: [
      { id: 'bh', totalReturnPct: 10, maxDrawdownPct: 5, position: 1, tradeCount: 0 },
      { id: 'x', totalReturnPct: 4, maxDrawdownPct: 2, position: 1, tradeCount: 1 },
    ],
    ETHUSDT: [
      { id: 'bh', totalReturnPct: -2, maxDrawdownPct: 9, position: 1, tradeCount: 0 },
      { id: 'x', totalReturnPct: 8, maxDrawdownPct: 3, position: 0, tradeCount: 2 },
    ],
  });
  const out = summarizeArena(s);
  const bh = out.find((r) => r.id === 'bh');
  assert.equal(bh.symbolCount, 2);
  assert.equal(bh.meanReturnPct, 4);
  assert.equal(bh.worstReturnPct, -2);
  assert.equal(bh.positiveSymbols, 1);

  const x = out.find((r) => r.id === 'x');
  assert.equal(x.meanReturnPct, 6);
  assert.equal(x.positiveSymbols, 2);
  assert.equal(x.maxDrawdownPct, 3, '최악 낙폭을 대표값으로 쓴다');
});

test('summarizeArena: 아직 기록이 없는 심볼은 집계에서 빠진다', () => {
  const s = arenaState({
    BTCUSDT: [{ id: 'bh', totalReturnPct: 10, maxDrawdownPct: 1, position: 1, tradeCount: 0 }],
  });
  s.symbols.push('SOLUSDT');
  s.series.SOLUSDT = { history: [] };
  const out = summarizeArena(s);
  assert.equal(out.find((r) => r.id === 'bh').symbolCount, 1);
});

test('summarizeArena: 기록이 전혀 없으면 지표는 null (0으로 위장하지 않는다)', () => {
  const s = arenaState({});
  s.symbols = ['BTCUSDT'];
  s.series = { BTCUSDT: { history: [] } };
  const out = summarizeArena(s);
  assert.equal(out.find((r) => r.id === 'bh').meanReturnPct, null);
  assert.equal(out.find((r) => r.id === 'bh').symbolCount, 0);
});

test('summarizeArena: 후보 순서는 설정 순서를 따른다', () => {
  const s = arenaState({
    BTCUSDT: [
      { id: 'bh', totalReturnPct: 1, maxDrawdownPct: 1, position: 1, tradeCount: 0 },
      { id: 'x', totalReturnPct: 2, maxDrawdownPct: 1, position: 1, tradeCount: 0 },
    ],
  });
  assert.deepEqual(summarizeArena(s).map((r) => r.id), ['bh', 'x']);
});
