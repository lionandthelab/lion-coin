const { test } = require('node:test');
const assert = require('node:assert/strict');

const { parseKlines, buildKlinesUrl, intervalToMs, MAX_LIMIT } = require('../src/klines');

// 바이낸스 /api/v3/klines 응답 한 줄 (숫자는 모두 문자열로 온다)
function row(overrides = {}) {
  const base = {
    openTime: 1700000000000,
    open: '42000.10',
    high: '42500.00',
    low: '41800.00',
    close: '42300.55',
    volume: '123.45600000',
    closeTime: 1700003599999,
  };
  const r = { ...base, ...overrides };
  return [
    r.openTime,
    r.open,
    r.high,
    r.low,
    r.close,
    r.volume,
    r.closeTime,
    '5200000.0', // quote volume
    308, // trades
    '60.1', // taker buy base
    '2500000.0', // taker buy quote
    '0', // ignore
  ];
}

// ---- parseKlines ----

test('parseKlines: 문자열 가격을 숫자 캔들 객체로 정규화한다', () => {
  const r = parseKlines([row()]);
  assert.deepEqual(r, [
    {
      openTime: 1700000000000,
      open: 42000.1,
      high: 42500,
      low: 41800,
      close: 42300.55,
      volume: 123.456,
      closeTime: 1700003599999,
    },
  ]);
});

test('parseKlines: 빈 배열은 빈 배열 (페이지네이션 종료 신호)', () => {
  assert.deepEqual(parseKlines([]), []);
});

test('parseKlines: 배열이 아니면 TypeError', () => {
  assert.throws(() => parseKlines(null), TypeError);
  assert.throws(() => parseKlines({}), TypeError);
  assert.throws(() => parseKlines('[]'), TypeError);
});

test('parseKlines: 행이 배열이 아니거나 필드가 모자라면 TypeError', () => {
  assert.throws(() => parseKlines([{ open: 1 }]), TypeError);
  assert.throws(() => parseKlines([[1700000000000, '1', '2', '3', '1.5']]), TypeError);
});

test('parseKlines: 가격이 숫자로 해석되지 않거나 0 이하면 TypeError', () => {
  assert.throws(() => parseKlines([row({ open: 'abc' })]), TypeError);
  assert.throws(() => parseKlines([row({ close: '0' })]), TypeError);
  assert.throws(() => parseKlines([row({ low: '-1' })]), TypeError);
});

test('parseKlines: 거래량은 0을 허용하지만 음수는 TypeError', () => {
  assert.equal(parseKlines([row({ volume: '0' })])[0].volume, 0);
  assert.throws(() => parseKlines([row({ volume: '-0.5' })]), TypeError);
});

test('parseKlines: openTime/closeTime이 정수가 아니면 TypeError', () => {
  assert.throws(() => parseKlines([row({ openTime: '1700000000000.5' })]), TypeError);
  assert.throws(() => parseKlines([row({ closeTime: null })]), TypeError);
});

// 손상된 캔들은 백테스트 성과를 조용히 왜곡하므로 파싱 단계에서 잡는다.
test('parseKlines: high < low면 TypeError', () => {
  assert.throws(() => parseKlines([row({ high: '100', low: '200' })]), TypeError);
});

test('parseKlines: open/close가 [low, high] 범위를 벗어나면 TypeError', () => {
  assert.throws(() => parseKlines([row({ open: '99999' })]), TypeError);
  assert.throws(() => parseKlines([row({ close: '1' })]), TypeError);
});

test('parseKlines: openTime이 오름차순이 아니면 TypeError (페이지 이어붙이기 사고 차단)', () => {
  const a = row({ openTime: 1700003600000, closeTime: 1700007199999 });
  const b = row({ openTime: 1700000000000, closeTime: 1700003599999 });
  assert.throws(() => parseKlines([a, b]), TypeError);
});

test('parseKlines: openTime이 중복되면 TypeError (같은 봉 두 번 집계 차단)', () => {
  assert.throws(() => parseKlines([row(), row()]), TypeError);
});

// ---- buildKlinesUrl ----

test('buildKlinesUrl: 심볼을 대문자로 올리고 기본 limit을 붙인다', () => {
  const url = buildKlinesUrl({ symbol: 'btcusdt', interval: '1h' });
  assert.equal(
    url,
    `https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1h&limit=${MAX_LIMIT}`
  );
});

test('buildKlinesUrl: startTime/endTime은 주어질 때만 붙는다', () => {
  const url = buildKlinesUrl({
    symbol: 'BTCUSDT',
    interval: '15m',
    limit: 200,
    startTime: 1700000000000,
    endTime: 1700003599999,
  });
  assert.equal(
    url,
    'https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=15m&limit=200' +
      '&startTime=1700000000000&endTime=1700003599999'
  );
});

test('buildKlinesUrl: baseUrl 끝의 슬래시는 중복되지 않는다', () => {
  const url = buildKlinesUrl({ symbol: 'ETHUSDT', interval: '1d', baseUrl: 'https://example.com//' });
  assert.ok(url.startsWith('https://example.com/api/v3/klines?'));
});

test('buildKlinesUrl: symbol/interval이 비어 있으면 TypeError', () => {
  assert.throws(() => buildKlinesUrl({ interval: '1h' }), TypeError);
  assert.throws(() => buildKlinesUrl({ symbol: '', interval: '1h' }), TypeError);
  assert.throws(() => buildKlinesUrl({ symbol: 'BTCUSDT' }), TypeError);
});

// 조용히 잘라내면 "1500개 받았다"고 착각한 채 백테스트 구간이 어긋난다.
test('buildKlinesUrl: limit이 1~MAX_LIMIT 범위를 벗어나면 RangeError', () => {
  assert.throws(() => buildKlinesUrl({ symbol: 'BTCUSDT', interval: '1h', limit: 0 }), RangeError);
  assert.throws(
    () => buildKlinesUrl({ symbol: 'BTCUSDT', interval: '1h', limit: MAX_LIMIT + 1 }),
    RangeError
  );
  assert.throws(() => buildKlinesUrl({ symbol: 'BTCUSDT', interval: '1h', limit: 1.5 }), RangeError);
});

// ---- intervalToMs ----
// 페이지네이션은 "직전 페이지 마지막 봉 + 1간격"부터 다음 페이지를 요청한다.
// 이 간격이 틀리면 봉이 빠지거나 겹치고, 겹친 봉은 parseKlines의 중복 검사에 걸린다.

test('intervalToMs: 분·시간·일·주 단위를 밀리초로 변환한다', () => {
  assert.equal(intervalToMs('1m'), 60 * 1000);
  assert.equal(intervalToMs('15m'), 15 * 60 * 1000);
  assert.equal(intervalToMs('1h'), 60 * 60 * 1000);
  assert.equal(intervalToMs('4h'), 4 * 60 * 60 * 1000);
  assert.equal(intervalToMs('1d'), 24 * 60 * 60 * 1000);
  assert.equal(intervalToMs('1w'), 7 * 24 * 60 * 60 * 1000);
});

test('intervalToMs: 알 수 없는 간격은 TypeError (조용히 추측하지 않는다)', () => {
  assert.throws(() => intervalToMs('1y'), TypeError);
  assert.throws(() => intervalToMs('h'), TypeError);
  assert.throws(() => intervalToMs(''), TypeError);
  assert.throws(() => intervalToMs(60), TypeError);
});
