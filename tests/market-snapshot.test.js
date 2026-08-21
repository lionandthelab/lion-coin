const { test } = require('node:test');
const assert = require('node:assert/strict');

const { marketInputsFromTickers, isContextUsable, MAX_CONTEXT_AGE_MS } = require('../src/market-snapshot');
const { assessMarketContext } = require('../src/event-plan');

// 시황 입력을 티커 목록에서 만든다.
//
// **모르는 값을 그럴듯한 기본값으로 채우지 않는다.** assessMarketContext는 입력이
// 없으면 regime을 null로 돌려주도록 설계돼 있는데, 호출자가 "BTC 변동 없으면 0,
// 시장폭 없으면 50"으로 채우면 그 설계가 통째로 무력화된다. 시황을 몰라도 항상
// neutral 계획이 만들어지고, 그러면 시황 가드는 영원히 발동하지 않는다.

const tk = (symbol, changeRate) => ({ symbol, changeRate });

test('marketInputsFromTickers: BTC 변동과 시장폭을 낸다', () => {
  const r = marketInputsFromTickers([
    tk('BTC', 0.02), tk('ETH', 0.01), tk('XRP', -0.01), tk('SOL', -0.02),
  ]);
  assert.ok(Math.abs(r.btcChange24hBps - 200) < 1e-9);
  assert.ok(Math.abs(r.breadthPct - 50) < 1e-9);
});

test('marketInputsFromTickers: BTC가 없으면 0으로 위장하지 않는다', () => {
  // 0은 "변동 없음"이라는 확정된 정보다. 모른다는 것과 다르다.
  const r = marketInputsFromTickers([tk('ETH', 0.01)]);
  assert.equal(r.btcChange24hBps, null);
});

test('marketInputsFromTickers: BTC 변동률이 숫자가 아니면 null이다', () => {
  for (const bad of [null, undefined, NaN, '0.02', Infinity]) {
    assert.equal(marketInputsFromTickers([tk('BTC', bad)]).btcChange24hBps, null, String(bad));
  }
});

test('marketInputsFromTickers: 목록이 비면 시장폭을 50으로 위장하지 않는다', () => {
  for (const empty of [[], null, undefined, 'nope']) {
    const r = marketInputsFromTickers(empty);
    assert.equal(r.breadthPct, null, String(empty));
    assert.equal(r.btcChange24hBps, null, String(empty));
  }
});

test('marketInputsFromTickers: 변동률을 못 읽은 종목은 시장폭 계산에서 뺀다', () => {
  // 세지 못한 종목을 분모에 넣으면 하락으로 센 것과 같아진다.
  const r = marketInputsFromTickers([tk('BTC', 0.01), tk('ETH', 0.01), tk('X', null), tk('Y', undefined)]);
  assert.ok(Math.abs(r.breadthPct - 100) < 1e-9, `실제 ${r.breadthPct}`);
});

test('marketInputsFromTickers: 읽을 수 있는 종목이 하나도 없으면 null', () => {
  assert.equal(marketInputsFromTickers([tk('X', null), tk('Y', 'nope')]).breadthPct, null);
});

test('통합: 입력이 없으면 assessMarketContext가 국면을 판정하지 않는다', () => {
  // 이 두 함수가 맞물려야 "시황을 모르면 매매하지 않는다"가 성립한다.
  const ctx = assessMarketContext(marketInputsFromTickers([]));
  assert.equal(ctx.regime, null);
  assert.equal(ctx.multiplier, null);
});

// ---- 오래된 시황 ----

test('isContextUsable: 방금 평가한 시황은 쓴다', () => {
  assert.equal(isContextUsable({ regime: 'neutral' }, { at: 1000, now: 1000 + 60_000 }), true);
});

test('isContextUsable: 너무 오래된 시황은 쓰지 않는다', () => {
  // 시황 조회가 계속 실패하면 마지막 값이 조용히 계속 쓰인다. 한 시간 전
  // 시황으로 지금 재료의 크기를 조절하는 것은 모르는 것보다 나쁘다.
  assert.equal(
    isContextUsable({ regime: 'risk_on' }, { at: 1000, now: 1000 + MAX_CONTEXT_AGE_MS + 1 }),
    false
  );
});

test('isContextUsable: 평가한 적이 없으면 쓰지 않는다', () => {
  assert.equal(isContextUsable({ regime: 'neutral' }, { at: null, now: 5000 }), false);
});

test('isContextUsable: 국면이 없는 시황은 나이와 무관하게 쓰지 않는다', () => {
  assert.equal(isContextUsable({ regime: null }, { at: 1000, now: 1000 }), false);
  assert.equal(isContextUsable(null, { at: 1000, now: 1000 }), false);
});

test('MAX_CONTEXT_AGE_MS: 폴링 주기보다 넉넉하되 한 시간보다는 짧다', () => {
  assert.ok(MAX_CONTEXT_AGE_MS >= 5 * 60_000);
  assert.ok(MAX_CONTEXT_AGE_MS <= 60 * 60_000);
});
