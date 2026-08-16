const { test } = require('node:test');
const assert = require('node:assert/strict');

const { formatTo, buildV2CandleUrl, parseV2Candles } = require('../src/bithumb-v2');

// 빗썸 2.0 캔들은 구버전과 달리 **페이지네이션이 된다**(to 파라미터).
// 구버전은 간격 무관 200봉 고정이라 30분봉 4일치가 전부였다 — 한 국면뿐이라
// 어떤 검증도 성립하지 않았다. 이 어댑터가 그 제약을 없앤다.

test('formatTo: Z와 밀리초 없는 형식으로 만든다 (다른 형식은 400)', () => {
  assert.equal(formatTo(new Date('2026-08-01T00:00:00.000Z')), '2026-08-01T00:00:00');
});

test('formatTo: 밀리초 타임스탬프도 받는다', () => {
  assert.equal(formatTo(Date.parse('2026-08-01T12:34:56Z')), '2026-08-01T12:34:56');
});

test('buildV2CandleUrl: 분봉 URL을 만든다', () => {
  assert.equal(
    buildV2CandleUrl({ market: 'KRW-BTC', unit: 30, count: 200 }),
    'https://api.bithumb.com/v1/candles/minutes/30?market=KRW-BTC&count=200'
  );
});

test('buildV2CandleUrl: to를 주면 붙인다', () => {
  const u = buildV2CandleUrl({ market: 'KRW-BTC', unit: 30, count: 200, to: new Date('2026-08-01T00:00:00Z') });
  assert.match(u, /&to=2026-08-01T00:00:00$/);
});

test('buildV2CandleUrl: 일봉은 다른 경로를 쓴다', () => {
  assert.match(buildV2CandleUrl({ market: 'KRW-BTC', unit: 'days' }), /\/v1\/candles\/days\?/);
});

test('buildV2CandleUrl: count가 200을 넘으면 RangeError', () => {
  assert.throws(() => buildV2CandleUrl({ market: 'KRW-BTC', unit: 30, count: 500 }), RangeError);
});

test('buildV2CandleUrl: market이 비어 있으면 TypeError', () => {
  assert.throws(() => buildV2CandleUrl({ market: '', unit: 30 }), TypeError);
});

// ---- 파싱 ----
// 2.0은 trade_price가 종가다. opening/high/low와 이름이 달라 헷갈리기 쉽고,
// 잘못 매핑하면 구버전 때처럼 조용히 다른 값으로 계산된다.

const row = (t, o, h, l, c, v) => ({
  market: 'KRW-BTC', candle_date_time_utc: t,
  opening_price: o, high_price: h, low_price: l, trade_price: c,
  candle_acc_trade_volume: v, candle_acc_trade_price: v * c, unit: 30,
});

test('parseV2Candles: trade_price를 종가로 매핑한다', () => {
  const r = parseV2Candles([row('2026-08-01T00:00:00', 100, 110, 90, 105, 2)]);
  assert.deepEqual(r, [{
    openTime: Date.parse('2026-08-01T00:00:00Z'),
    open: 100, high: 110, low: 90, close: 105, volume: 2,
  }]);
});

test('parseV2Candles: 응답은 최신순이므로 오름차순으로 뒤집는다', () => {
  const r = parseV2Candles([
    row('2026-08-01T01:00:00', 1, 1, 1, 1, 1),
    row('2026-08-01T00:00:00', 1, 1, 1, 1, 1),
  ]);
  assert.ok(r[0].openTime < r[1].openTime, '오름차순이어야 한다');
});

test('parseV2Candles: 고가<저가면 TypeError (필드 매핑 사고 차단)', () => {
  assert.throws(() => parseV2Candles([row('2026-08-01T00:00:00', 100, 90, 110, 100, 1)]), TypeError);
});

test('parseV2Candles: 시가·종가가 범위를 벗어나면 TypeError', () => {
  assert.throws(() => parseV2Candles([row('2026-08-01T00:00:00', 999, 110, 90, 100, 1)]), TypeError);
});

test('parseV2Candles: 가격이 0 이하면 TypeError', () => {
  assert.throws(() => parseV2Candles([row('2026-08-01T00:00:00', 0, 110, 90, 100, 1)]), TypeError);
});

test('parseV2Candles: 빈 배열은 빈 배열 (페이지 끝 신호)', () => {
  assert.deepEqual(parseV2Candles([]), []);
});

test('parseV2Candles: 배열이 아니면 TypeError', () => {
  assert.throws(() => parseV2Candles({ error: { message: 'x' } }), TypeError);
});
