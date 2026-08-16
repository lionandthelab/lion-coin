const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  toMarket,
  buildEntryOrder,
  buildExitOrder,
  parseAccounts,
  roundVolume,
} = require('../src/bithumb-trade');

// 주문 페이로드는 틀려도 거래소가 "잘못된 요청"만 돌려주고, 무엇이 틀렸는지는
// 말해주지 않는다. 그래서 페이로드 조립을 순수 함수로 떼어 고정한다.
//
// 그리고 **매수와 매도의 파라미터가 다르다** — 시장가 매수는 금액(price),
// 시장가 매도는 수량(volume)을 넣는다. 이걸 헷갈리면 의도와 다른 주문이 나간다.

test('toMarket: 심볼을 KRW 마켓 코드로 바꾼다', () => {
  assert.equal(toMarket('BTC'), 'KRW-BTC');
  assert.equal(toMarket('btc'), 'KRW-BTC');
});

test('toMarket: 비어 있으면 TypeError', () => {
  assert.throws(() => toMarket(''), TypeError);
});

// ---- 진입 주문 ----

test('buildEntryOrder: 지정가 매수는 가격과 수량을 모두 넣는다', () => {
  const o = buildEntryOrder({ symbol: 'BTC', price: 89000000, volume: 0.0001, ordType: 'limit' });
  assert.deepEqual(o, {
    market: 'KRW-BTC', side: 'bid', ord_type: 'limit',
    price: '89000000', volume: '0.0001',
  });
});

test('buildEntryOrder: 시장가 매수는 금액(price)만 넣고 수량은 넣지 않는다', () => {
  const o = buildEntryOrder({ symbol: 'BTC', krwAmount: 20000, ordType: 'price' });
  assert.equal(o.ord_type, 'price');
  assert.equal(o.price, '20000');
  assert.equal(o.volume, undefined, '시장가 매수에 수량을 넣으면 거부된다');
});

test('buildEntryOrder: 시장가 매수에 금액이 없으면 RangeError', () => {
  assert.throws(() => buildEntryOrder({ symbol: 'BTC', ordType: 'price' }), RangeError);
});

test('buildEntryOrder: 지정가에 가격이나 수량이 빠지면 RangeError', () => {
  assert.throws(() => buildEntryOrder({ symbol: 'BTC', price: 100, ordType: 'limit' }), RangeError);
  assert.throws(() => buildEntryOrder({ symbol: 'BTC', volume: 1, ordType: 'limit' }), RangeError);
});

test('buildEntryOrder: 알 수 없는 주문 유형은 RangeError', () => {
  assert.throws(() => buildEntryOrder({ symbol: 'BTC', price: 1, volume: 1, ordType: 'stop' }), RangeError);
});

// ---- 청산 주문 ----

test('buildExitOrder: 지정가 매도는 가격과 수량을 넣는다', () => {
  const o = buildExitOrder({ symbol: 'BTC', price: 90000000, volume: 0.0001, ordType: 'limit' });
  assert.equal(o.side, 'ask');
  assert.equal(o.ord_type, 'limit');
  assert.equal(o.price, '90000000');
  assert.equal(o.volume, '0.0001');
});

test('buildExitOrder: 시장가 매도는 수량만 넣고 가격은 넣지 않는다', () => {
  const o = buildExitOrder({ symbol: 'BTC', volume: 0.0001, ordType: 'market' });
  assert.equal(o.ord_type, 'market');
  assert.equal(o.volume, '0.0001');
  assert.equal(o.price, undefined, '시장가 매도에 가격을 넣으면 거부된다');
});

test('buildExitOrder: 수량이 없으면 RangeError', () => {
  assert.throws(() => buildExitOrder({ symbol: 'BTC', ordType: 'market' }), RangeError);
});

// ---- 수량 반올림 ----
// 부동소수 그대로 보내면 거래소가 정밀도 오류를 낸다.

test('roundVolume: 소수 8자리로 자른다', () => {
  assert.equal(roundVolume(0.123456789), '0.12345678');
});

test('roundVolume: 지수 표기가 되지 않는다', () => {
  assert.ok(!roundVolume(0.00000012).includes('e'), roundVolume(0.00000012));
});

test('roundVolume: 0 이하는 RangeError', () => {
  assert.throws(() => roundVolume(0), RangeError);
  assert.throws(() => roundVolume(-1), RangeError);
});

// ---- 잔고 ----

test('parseAccounts: 통화별 보유·잠김을 합쳐 돌려준다', () => {
  const r = parseAccounts([
    { currency: 'KRW', balance: '39189.62', locked: '0' },
    { currency: 'BTC', balance: '0.001', locked: '0.0005' },
  ]);
  assert.equal(r.krw, 39189.62);
  assert.equal(r.holdings.BTC, 0.0015);
});

test('parseAccounts: 원화가 없으면 0으로 본다 (없는 것과 오류는 다르다)', () => {
  assert.equal(parseAccounts([{ currency: 'BTC', balance: '1', locked: '0' }]).krw, 0);
});

test('parseAccounts: 배열이 아니면 TypeError', () => {
  assert.throws(() => parseAccounts({ error: 'x' }), TypeError);
});
