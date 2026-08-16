const { test } = require('node:test');
const assert = require('node:assert/strict');

const { simulateBracket, summarizeTrades } = require('../src/bracket-backtest');

const MIN = 60000;
function bars(rows) {
  return rows.map(([open, high, low, close, volume], i) => ({
    openTime: i * MIN, open, high, low, close, volume: volume ?? 1, closeTime: i * MIN + MIN - 1,
  }));
}

// 조건 주문 백테스트의 핵심은 **같은 봉에서 익절선과 손절선이 모두 닿았을 때**를
// 어떻게 처리하느냐다. 봉 데이터만으로는 어느 쪽이 먼저인지 알 수 없다.
// 익절이 먼저라고 가정하면 성과가 조직적으로 부풀려진다 — 손절 우선으로 잡는다.

test('simulateBracket: 익절선에 닿으면 익절로 청산한다', () => {
  const c = bars([
    [100, 100, 100, 100], // 진입 신호 봉
    [100, 100, 100, 100], // 진입 (시가 100)
    [100, 103, 99.5, 102], // 고가가 익절선(102) 도달
  ]);
  const r = simulateBracket(c, { entryIndex: 1, tpBps: 200, slBps: 100, costBps: 0 });
  assert.equal(r.outcome, 'tp');
  assert.equal(r.exitIndex, 2);
});

test('simulateBracket: 손절선에 닿으면 손절로 청산한다', () => {
  const c = bars([[100, 100, 100, 100], [100, 100, 100, 100], [100, 100.5, 98, 99]]);
  const r = simulateBracket(c, { entryIndex: 1, tpBps: 200, slBps: 100, costBps: 0 });
  assert.equal(r.outcome, 'sl');
});

test('simulateBracket: 한 봉에서 양쪽 다 닿으면 손절로 본다 (봉 데이터로는 순서를 알 수 없다)', () => {
  const c = bars([[100, 100, 100, 100], [100, 100, 100, 100], [100, 103, 98, 101]]);
  const r = simulateBracket(c, { entryIndex: 1, tpBps: 200, slBps: 100, costBps: 0 });
  assert.equal(r.outcome, 'sl', '익절 우선으로 잡으면 성과가 조직적으로 부풀려진다');
});

test('simulateBracket: 진입 봉 자체에서도 청산 판정을 한다', () => {
  // 진입은 시가에 이뤄지므로 그 봉의 고저가 이미 청산 조건을 만족할 수 있다
  const c = bars([[100, 100, 100, 100], [100, 103, 100, 102]]);
  const r = simulateBracket(c, { entryIndex: 1, tpBps: 200, slBps: 100, costBps: 0 });
  assert.equal(r.outcome, 'tp');
  assert.equal(r.exitIndex, 1);
});

test('simulateBracket: 최대 보유 봉을 넘으면 종가로 강제 청산한다', () => {
  const c = bars([
    [100, 100, 100, 100], [100, 100.5, 99.5, 100],
    [100, 100.5, 99.5, 100], [100, 100.5, 99.5, 100.3],
  ]);
  const r = simulateBracket(c, { entryIndex: 1, tpBps: 500, slBps: 500, maxHoldBars: 2, costBps: 0 });
  assert.equal(r.outcome, 'timeout');
  assert.equal(r.exitIndex, 2);
});

test('simulateBracket: 데이터가 끝나면 마지막 종가로 청산한다', () => {
  const c = bars([[100, 100, 100, 100], [100, 100.5, 99.5, 100.2]]);
  const r = simulateBracket(c, { entryIndex: 1, tpBps: 500, slBps: 500, maxHoldBars: 99, costBps: 0 });
  assert.equal(r.outcome, 'eod');
});

test('simulateBracket: 비용은 수익률에서 통째로 차감된다', () => {
  const c = bars([[100, 100, 100, 100], [100, 100, 100, 100], [100, 103, 99.5, 102]]);
  const free = simulateBracket(c, { entryIndex: 1, tpBps: 200, slBps: 100, costBps: 0 });
  const paid = simulateBracket(c, { entryIndex: 1, tpBps: 200, slBps: 100, costBps: 30 });
  assert.ok(Math.abs(free.returnBps - 200) < 1e-6);
  assert.ok(Math.abs(paid.returnBps - 170) < 1e-6, `비용 30bps 차감: ${paid.returnBps}`);
});

test('simulateBracket: 진입 인덱스가 범위를 벗어나면 null', () => {
  const c = bars([[100, 100, 100, 100]]);
  assert.equal(simulateBracket(c, { entryIndex: 5, tpBps: 200, slBps: 100 }), null);
});

// ---- 집계 ----

test('summarizeTrades: 승률·기대값·총수익을 낸다', () => {
  const s = summarizeTrades([
    { outcome: 'tp', returnBps: 170 },
    { outcome: 'sl', returnBps: -130 },
    { outcome: 'tp', returnBps: 170 },
  ]);
  assert.equal(s.count, 3);
  assert.equal(s.wins, 2);
  assert.ok(Math.abs(s.winRate - 2 / 3) < 1e-9);
  assert.ok(Math.abs(s.expectancyBps - (170 - 130 + 170) / 3) < 1e-9);
});

test('summarizeTrades: 거래가 없으면 지표는 null (0으로 위장하지 않는다)', () => {
  const s = summarizeTrades([]);
  assert.equal(s.count, 0);
  assert.equal(s.winRate, null);
  assert.equal(s.expectancyBps, null);
});

test('summarizeTrades: 청산 사유별 개수를 센다', () => {
  const s = summarizeTrades([
    { outcome: 'tp', returnBps: 1 }, { outcome: 'sl', returnBps: -1 },
    { outcome: 'timeout', returnBps: 0 }, { outcome: 'eod', returnBps: 0 },
  ]);
  assert.deepEqual(s.byOutcome, { tp: 1, sl: 1, timeout: 1, eod: 1 });
});
