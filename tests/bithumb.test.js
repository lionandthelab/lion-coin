const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  parseBithumbCandles,
  parseTickerAll,
  parseOrderbook,
  spreadBps,
  buildCandleUrl,
} = require('../src/bithumb');

// 빗썸 캔들은 [시각, 시가, 종가, 고가, 저가, 거래량] 순이다.
// 바이낸스는 [시각, 시가, 고가, 저가, 종가, ...] — **2·3·4번이 통째로 뒤바뀐다.**
// 바이낸스 파서를 재사용하면 종가와 고가가 뒤섞인 채 조용히 돌아가고,
// 그 위에서 계산된 모든 성과가 무의미해진다.

test('parseBithumbCandles: 빗썸 필드 순서(시가·종가·고가·저가)를 올바르게 매핑한다', () => {
  const rows = [[1786633200000, '90041000', '88440000', '90135000', '88334000', '308.59']];
  assert.deepEqual(parseBithumbCandles(rows), [
    {
      openTime: 1786633200000,
      open: 90041000,
      close: 88440000,
      high: 90135000,
      low: 88334000,
      volume: 308.59,
    },
  ]);
});

test('parseBithumbCandles: 바이낸스 순서로 온 데이터는 검증에 걸린다', () => {
  // 바이낸스 배치([t, o, h, l, c])를 그대로 넣으면 고가 자리에 저가가 와서 high<low가 된다
  const binanceOrdered = [[1000, '100', '110', '90', '105', '1']];
  assert.throws(() => parseBithumbCandles(binanceOrdered), TypeError);
});

test('parseBithumbCandles: 문자열 가격을 숫자로 바꾼다', () => {
  const r = parseBithumbCandles([[1000, '1.5', '2.5', '3.5', '0.5', '10']]);
  assert.equal(typeof r[0].open, 'number');
  assert.equal(r[0].high, 3.5);
});

test('parseBithumbCandles: 시가·종가가 [저가, 고가] 범위를 벗어나면 TypeError', () => {
  assert.throws(() => parseBithumbCandles([[1000, '999', '2', '3', '1', '1']]), TypeError);
});

test('parseBithumbCandles: 시각이 오름차순이 아니면 TypeError', () => {
  const rows = [
    [2000, '1', '1', '1', '1', '1'],
    [1000, '1', '1', '1', '1', '1'],
  ];
  assert.throws(() => parseBithumbCandles(rows), TypeError);
});

test('parseBithumbCandles: 가격이 0 이하면 TypeError (거래정지 종목 방어)', () => {
  assert.throws(() => parseBithumbCandles([[1000, '0', '1', '1', '1', '1']]), TypeError);
});

test('parseBithumbCandles: 배열이 아니면 TypeError', () => {
  assert.throws(() => parseBithumbCandles(null), TypeError);
});

// ---- 전체 티커 ----

test('parseTickerAll: 마켓 목록과 24시간 거래대금을 뽑는다', () => {
  const json = {
    status: '0000',
    data: {
      BTC: { closing_price: '89000000', acc_trade_value_24H: '500000000000' },
      DOGE: { closing_price: '150', acc_trade_value_24H: '3000000000' },
      date: '1786881780000',
    },
  };
  const out = parseTickerAll(json);
  assert.equal(out.length, 2);
  // 거래대금 내림차순
  assert.equal(out[0].symbol, 'BTC');
  assert.equal(out[0].tradeValue24h, 500000000000);
  assert.equal(out[1].symbol, 'DOGE');
});

test('parseTickerAll: date 키는 마켓이 아니므로 제외한다', () => {
  const out = parseTickerAll({ status: '0000', data: { date: '123', BTC: { closing_price: '1', acc_trade_value_24H: '1' } } });
  assert.deepEqual(out.map((x) => x.symbol), ['BTC']);
});

// 24시간 변동률은 시황 판정의 유일한 입력이다. 파서가 이 필드를 버리면
// 시황 층은 **입력 없이 돌아간다** — 그리고 호출자가 없는 값을 0으로 채우고
// 있었기 때문에, 데몬은 켜진 내내 조작된 시황으로 익절폭을 정하고 있었다.
// (2026-08-22 발견. 실제로는 상승 종목 0건 → 시장폭 0% → 영구 risk_off였다.)
test('parseTickerAll: 24시간 변동률을 소수 비율로 낸다', () => {
  const out = parseTickerAll({
    status: '0000',
    data: {
      BTC: { closing_price: '107288000', acc_trade_value_24H: '5', fluctate_rate_24H: '6.96' },
      DOGE: { closing_price: '150', acc_trade_value_24H: '1', fluctate_rate_24H: '-3.5' },
    },
  });
  const btc = out.find((x) => x.symbol === 'BTC');
  const doge = out.find((x) => x.symbol === 'DOGE');
  // 응답은 퍼센트("6.96")고 소비자는 소수 비율을 기대한다(×10000 하면 bps).
  assert.ok(Math.abs(btc.changeRate - 0.0696) < 1e-12, `실제 ${btc.changeRate}`);
  assert.ok(Math.abs(doge.changeRate - (-0.035)) < 1e-12, `실제 ${doge.changeRate}`);
});

test('parseTickerAll: 변동률이 없으면 0으로 위장하지 않는다', () => {
  // 0은 "변동 없음"이라는 확정된 관측이다. 그 값이 시장폭 계산에 들어가면
  // 하락으로 세어지고, 시황은 조용히 risk_off로 기운다.
  const out = parseTickerAll({
    status: '0000',
    data: {
      A: { closing_price: '1', acc_trade_value_24H: '9' },
      B: { closing_price: '1', acc_trade_value_24H: '8', fluctate_rate_24H: '' },
      C: { closing_price: '1', acc_trade_value_24H: '7', fluctate_rate_24H: 'nope' },
    },
  });
  for (const row of out) assert.equal(row.changeRate, null, row.symbol);
});

test('parseTickerAll: status가 0000이 아니면 Error (조용히 빈 목록을 돌려주지 않는다)', () => {
  assert.throws(() => parseTickerAll({ status: '5600', message: '오류' }), /5600/);
});

// ---- 호가 ----

test('parseOrderbook: 최우선 매수·매도 호가를 뽑는다', () => {
  const json = {
    status: '0000',
    data: { asks: [{ price: '100', quantity: '1' }], bids: [{ price: '98', quantity: '2' }] },
  };
  assert.deepEqual(parseOrderbook(json), { ask: 100, bid: 98, askQty: 1, bidQty: 2 });
});

test('parseOrderbook: 매도호가가 매수호가보다 낮으면 TypeError (교차 호가)', () => {
  const json = {
    status: '0000',
    data: { asks: [{ price: '98', quantity: '1' }], bids: [{ price: '100', quantity: '1' }] },
  };
  assert.throws(() => parseOrderbook(json), TypeError);
});

test('parseOrderbook: 호가가 비어 있으면 TypeError (거래정지·신규상장)', () => {
  assert.throws(() => parseOrderbook({ status: '0000', data: { asks: [], bids: [] } }), TypeError);
});

// ---- 스프레드 ----
// 빗썸 왕복 비용의 절반 이상이 스프레드다. 이걸 비용 모델에서 빼면
// 존재하지 않는 수익이 만들어진다.

test('spreadBps: 중간가 기준 스프레드를 bps로 낸다', () => {
  // (102-98)/100 = 4% = 400bps
  assert.equal(spreadBps({ ask: 102, bid: 98 }), 400);
});

test('spreadBps: 호가가 같으면 0', () => {
  assert.equal(spreadBps({ ask: 100, bid: 100 }), 0);
});

test('spreadBps: 값이 유효하지 않으면 TypeError', () => {
  assert.throws(() => spreadBps({ ask: 0, bid: 100 }), TypeError);
  assert.throws(() => spreadBps({}), TypeError);
});

// ---- URL ----

test('buildCandleUrl: 심볼과 간격으로 URL을 만든다', () => {
  assert.equal(
    buildCandleUrl({ symbol: 'BTC', interval: '1m' }),
    'https://api.bithumb.com/public/candlestick/BTC_KRW/1m'
  );
});

test('buildCandleUrl: 지원하지 않는 간격은 RangeError (조용히 추측하지 않는다)', () => {
  assert.throws(() => buildCandleUrl({ symbol: 'BTC', interval: '2m' }), RangeError);
});

test('buildCandleUrl: 심볼이 비어 있으면 TypeError', () => {
  assert.throws(() => buildCandleUrl({ symbol: '', interval: '1m' }), TypeError);
});
