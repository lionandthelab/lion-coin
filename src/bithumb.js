'use strict';

// 빗썸 공개 API 어댑터 — 파싱은 순수 함수, fetch는 얇은 래퍼.
//
// ⚠ 캔들 필드 순서가 바이낸스와 다르다.
//   빗썸:   [시각, 시가, 종가, 고가, 저가, 거래량]
//   바이낸스: [시각, 시가, 고가, 저가, 종가, ...]
//   2·3·4번이 통째로 뒤바뀐다. 바이낸스 파서를 재사용하면 종가와 고가가 뒤섞인 채
//   조용히 돌아가고, 그 위에서 계산된 모든 성과가 무의미해진다.

const BASE_URL = 'https://api.bithumb.com';

// 빗썸이 지원하는 캔들 간격. 없는 값을 추측해 넣으면 404가 아니라 빈 데이터가 오기도 한다.
const INTERVALS = ['1m', '3m', '5m', '10m', '30m', '1h', '6h', '12h', '24h'];

function toPositive(value, field, i) {
  const n = Number(value);
  if (value === '' || value === null || value === undefined || !Number.isFinite(n) || n <= 0) {
    throw new TypeError(`캔들[${i}]의 ${field}가 양의 유한수가 아닙니다: ${value}`);
  }
  return n;
}

function parseBithumbCandles(rows) {
  if (!Array.isArray(rows)) {
    throw new TypeError('빗썸 캔들 응답은 배열이어야 합니다');
  }

  const out = [];
  let prev = null;

  rows.forEach((raw, i) => {
    if (!Array.isArray(raw) || raw.length < 6) {
      throw new TypeError(`캔들[${i}]은 6개 필드를 가진 배열이어야 합니다`);
    }

    const openTime = Number(raw[0]);
    if (!Number.isInteger(openTime)) {
      throw new TypeError(`캔들[${i}]의 시각이 정수 밀리초가 아닙니다: ${raw[0]}`);
    }

    // 빗썸 순서: 시가(1) · 종가(2) · 고가(3) · 저가(4)
    const open = toPositive(raw[1], 'open', i);
    const close = toPositive(raw[2], 'close', i);
    const high = toPositive(raw[3], 'high', i);
    const low = toPositive(raw[4], 'low', i);

    const volume = Number(raw[5]);
    if (!Number.isFinite(volume) || volume < 0) {
      throw new TypeError(`캔들[${i}]의 거래량이 0 이상의 유한수가 아닙니다: ${raw[5]}`);
    }

    // 필드 순서를 잘못 읽으면 거의 항상 여기서 걸린다.
    if (high < low) {
      throw new TypeError(
        `캔들[${i}]의 고가(${high})가 저가(${low})보다 작습니다 — 필드 순서를 확인하세요 (빗썸은 시가·종가·고가·저가 순)`
      );
    }
    if (open < low || open > high || close < low || close > high) {
      throw new TypeError(
        `캔들[${i}]의 시가(${open})·종가(${close})가 [${low}, ${high}] 범위를 벗어납니다 — 필드 순서를 확인하세요`
      );
    }
    if (prev !== null && openTime <= prev) {
      throw new TypeError(`캔들[${i}]의 시각(${openTime})이 직전(${prev})보다 뒤가 아닙니다`);
    }
    prev = openTime;

    out.push({ openTime, open, close, high, low, volume });
  });

  return out;
}

function assertOk(json) {
  if (!json || typeof json !== 'object') {
    throw new TypeError('빗썸 응답이 객체가 아닙니다');
  }
  if (json.status !== '0000') {
    throw new Error(`빗썸 응답 오류: status=${json.status} ${json.message || ''}`.trim());
  }
  return json.data;
}

// 전체 KRW 마켓을 24시간 거래대금 내림차순으로 돌려준다.
// 거래대금은 유동성 대리 지표이며, 하위 종목은 스프레드가 훨씬 넓어 비용이 커진다.
function parseTickerAll(json) {
  const data = assertOk(json);
  return Object.entries(data)
    .filter(([k]) => k !== 'date')
    .map(([symbol, v]) => ({
      symbol,
      price: Number(v.closing_price),
      tradeValue24h: Number(v.acc_trade_value_24H || 0),
    }))
    .sort((a, b) => b.tradeValue24h - a.tradeValue24h);
}

function parseOrderbook(json) {
  const data = assertOk(json);
  const ask = Number(data?.asks?.[0]?.price);
  const bid = Number(data?.bids?.[0]?.price);
  const askQty = Number(data?.asks?.[0]?.quantity);
  const bidQty = Number(data?.bids?.[0]?.quantity);

  if (!Number.isFinite(ask) || !Number.isFinite(bid) || ask <= 0 || bid <= 0) {
    throw new TypeError('호가가 비어 있거나 유효하지 않습니다 (거래정지·신규상장 가능성)');
  }
  // 교차 호가는 정상 시장에서 나오지 않는다 — 데이터 이상이므로 통과시키지 않는다.
  if (ask < bid) {
    throw new TypeError(`매도호가(${ask})가 매수호가(${bid})보다 낮습니다 — 교차 호가`);
  }

  return { ask, bid, askQty, bidQty };
}

// 빗썸 왕복 비용의 절반 이상이 스프레드다. 비용 모델에서 빼면 존재하지 않는 수익이 만들어진다.
function spreadBps({ ask, bid } = {}) {
  if (!Number.isFinite(ask) || !Number.isFinite(bid) || ask <= 0 || bid <= 0) {
    throw new TypeError('spreadBps에는 양의 ask/bid가 필요합니다');
  }
  const mid = (ask + bid) / 2;
  return ((ask - bid) / mid) * 10000;
}

function buildCandleUrl({ symbol, interval = '1m', baseUrl = BASE_URL } = {}) {
  if (typeof symbol !== 'string' || symbol.trim() === '') {
    throw new TypeError('symbol은 비어 있지 않은 문자열이어야 합니다');
  }
  if (!INTERVALS.includes(interval)) {
    throw new RangeError(`빗썸이 지원하지 않는 간격입니다: ${interval} (지원: ${INTERVALS.join(', ')})`);
  }
  return `${baseUrl.replace(/\/+$/, '')}/public/candlestick/${symbol.trim().toUpperCase()}_KRW/${interval}`;
}

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`빗썸 응답 오류: HTTP ${res.status}`);
  }
  return res.json();
}

async function fetchCandles(options) {
  return parseBithumbCandles(assertOk(await fetchJson(buildCandleUrl(options))));
}

async function fetchTickerAll(baseUrl = BASE_URL) {
  return parseTickerAll(await fetchJson(`${baseUrl}/public/ticker/ALL_KRW`));
}

async function fetchOrderbook(symbol, baseUrl = BASE_URL) {
  return parseOrderbook(await fetchJson(`${baseUrl}/public/orderbook/${symbol.toUpperCase()}_KRW`));
}

module.exports = {
  BASE_URL,
  INTERVALS,
  parseBithumbCandles,
  parseTickerAll,
  parseOrderbook,
  spreadBps,
  buildCandleUrl,
  fetchCandles,
  fetchTickerAll,
  fetchOrderbook,
};
