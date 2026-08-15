const { test } = require('node:test');
const assert = require('node:assert/strict');

const { parseFundingRates, alignFundingToCandles, attachFunding } = require('../src/funding');

const HOUR = 3600000;

function candles(count, start = 0) {
  return Array.from({ length: count }, (_, i) => ({
    openTime: start + i * HOUR,
    open: 100,
    high: 100,
    low: 100,
    close: 100,
    volume: 1,
    closeTime: start + i * HOUR + HOUR - 1,
  }));
}

function row(fundingTime, fundingRate) {
  return { symbol: 'BTCUSDT', fundingTime, fundingRate, markPrice: '63000.0' };
}

// ---- parseFundingRates ----

test('parseFundingRates: 문자열 요율을 숫자로 정규화한다', () => {
  assert.deepEqual(parseFundingRates([row(0, '0.00008545'), row(28800000, '-0.00001')]), [
    { fundingTime: 0, fundingRate: 0.00008545 },
    { fundingTime: 28800000, fundingRate: -0.00001 },
  ]);
});

test('parseFundingRates: 음수 요율은 정상값이다 (숏이 롱에게 지불하는 구간)', () => {
  assert.equal(parseFundingRates([row(0, '-0.0005')])[0].fundingRate, -0.0005);
});

test('parseFundingRates: 빈 배열은 빈 배열, 배열이 아니면 TypeError', () => {
  assert.deepEqual(parseFundingRates([]), []);
  assert.throws(() => parseFundingRates(null), TypeError);
});

test('parseFundingRates: 요율이 숫자로 해석되지 않으면 TypeError', () => {
  assert.throws(() => parseFundingRates([row(0, 'abc')]), TypeError);
  assert.throws(() => parseFundingRates([row(0, '')]), TypeError);
});

test('parseFundingRates: fundingTime이 오름차순이 아니면 TypeError', () => {
  assert.throws(() => parseFundingRates([row(28800000, '0.0001'), row(0, '0.0001')]), TypeError);
});

// ---- alignFundingToCandles ----
// 펀딩은 8시간마다 정산되므로 캔들마다 값이 없다. 직전 정산값을 이어 쓰되,
// **해당 봉이 닫히기 전에는 알 수 없는 값을 절대 쓰지 않는다** — 여기가 룩어헤드가
// 가장 쉽게 새어드는 지점이다.

test('alignFundingToCandles: 봉이 닫히기 전에 정산된 값만 쓴다', () => {
  const c = candles(2); // c0 닫힘 3599999, c1 닫힘 7199999
  const aligned = alignFundingToCandles(c, parseFundingRates([row(3600000, '0.001')]));
  assert.deepEqual(aligned, [null, 0.001]);
});

test('alignFundingToCandles: 다음 정산 전까지는 직전 값을 이어 쓴다', () => {
  const c = candles(4);
  const aligned = alignFundingToCandles(
    c,
    parseFundingRates([row(0, '0.001'), row(7200000, '0.002')])
  );
  assert.deepEqual(aligned, [0.001, 0.001, 0.002, 0.002]);
});

test('alignFundingToCandles: 첫 정산 이전 구간은 null', () => {
  const c = candles(3);
  const aligned = alignFundingToCandles(c, parseFundingRates([row(7200000, '0.001')]));
  assert.deepEqual(aligned, [null, null, 0.001]);
});

test('alignFundingToCandles: 펀딩 기록이 없으면 전부 null', () => {
  assert.deepEqual(alignFundingToCandles(candles(3), []), [null, null, null]);
});

test('alignFundingToCandles: 캔들과 길이가 같은 배열을 돌려준다', () => {
  const c = candles(10);
  assert.equal(alignFundingToCandles(c, parseFundingRates([row(0, '0.001')])).length, 10);
});

// ---- attachFunding ----

test('attachFunding: 캔들에 funding 필드를 붙인다 (원본은 건드리지 않는다)', () => {
  const c = candles(2);
  const out = attachFunding(c, parseFundingRates([row(0, '0.001')]));
  assert.equal(out[0].funding, 0.001);
  assert.equal(out[1].funding, 0.001);
  assert.equal(out[0].close, 100, '기존 필드 보존');
  assert.equal(c[0].funding, undefined, '원본 캔들은 변경되지 않는다');
});

// ---- fundingSettled ----
// 펀딩은 8시간마다 정산되지만 캔들은 1시간마다다. 백테스트가 펀딩 비용을
// 물리려면 "이 봉에서 정산이 일어났는가"를 알아야 한다 — 이어 쓴 값에
// 매 봉 과금하면 8배를 물린다.

test('attachFunding: 정산이 일어난 봉에만 fundingSettled=true', () => {
  const c = candles(4);
  const out = attachFunding(c, parseFundingRates([row(0, '0.001'), row(7200000, '0.002')]));
  assert.deepEqual(out.map((x) => x.fundingSettled), [true, false, true, false]);
});

test('attachFunding: 첫 정산 이전 봉은 fundingSettled=false', () => {
  const out = attachFunding(candles(3), parseFundingRates([row(7200000, '0.001')]));
  assert.deepEqual(out.map((x) => x.fundingSettled), [false, false, true]);
});

test('attachFunding: 한 봉에 정산이 여러 번이면 한 번만 표시한다', () => {
  // 4시간봉 하나에 8시간 정산이 두 번 들어오는 경우는 없지만, 데이터 이상에 대비
  const wide = [{ openTime: 0, open: 1, high: 1, low: 1, close: 1, volume: 1, closeTime: 99999999 }];
  const out = attachFunding(wide, parseFundingRates([row(0, '0.001'), row(28800000, '0.002')]));
  assert.equal(out[0].fundingSettled, true);
  assert.equal(out[0].funding, 0.002, '가장 최근 정산값이 남는다');
});
