'use strict';

// 빗썸 2.0 주문 API — 페이로드 조립은 순수 함수, 전송은 얇은 래퍼.
//
// ⚠ 이 모듈의 함수를 부르면 **실제 주문이 나간다.** 호출부(대시보드)는
//   mode === 'live'일 때만 부르며, live 전환에는 환경변수 승인과 화면 확인이
//   둘 다 필요하다.
//
// 매수와 매도의 파라미터가 다르다는 점이 가장 자주 틀리는 부분이다:
//   시장가 **매수**는 금액(price)을 넣고 수량을 넣지 않는다
//   시장가 **매도**는 수량(volume)을 넣고 가격을 넣지 않는다
// 헷갈리면 거래소는 "잘못된 요청"만 돌려주고 무엇이 틀렸는지 말하지 않는다.

const { buildV2Headers, encodeQuery } = require('./bithumb-auth');

const BASE = 'https://api.bithumb.com';

function toMarket(symbol) {
  if (typeof symbol !== 'string' || symbol.trim() === '') {
    throw new TypeError('symbol은 비어 있지 않은 문자열이어야 합니다');
  }
  return `KRW-${symbol.trim().toUpperCase()}`;
}

function assertPositive(v, name) {
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) {
    throw new RangeError(`${name}은(는) 양수여야 합니다: ${v}`);
  }
}

// 부동소수를 그대로 보내면 거래소가 정밀도 오류를 낸다. 지수 표기도 거부된다.
// **반올림이 아니라 버림**이다 — 올리면 보유 수량을 넘는 주문이 나가 거부되거나,
// 매도에서 잔량이 모자라 실패한다.
function roundVolume(v) {
  assertPositive(v, 'volume');
  const truncated = Math.floor(v * 1e8) / 1e8;
  if (!(truncated > 0)) {
    throw new RangeError(`수량이 최소 단위(1e-8)보다 작습니다: ${v}`);
  }
  return truncated.toFixed(8).replace(/0+$/, '').replace(/\.$/, '');
}

function buildEntryOrder({ symbol, price, volume, krwAmount, ordType = 'limit' }) {
  const market = toMarket(symbol);

  if (ordType === 'limit') {
    assertPositive(price, 'price');
    assertPositive(volume, 'volume');
    return { market, side: 'bid', ord_type: 'limit', price: String(price), volume: roundVolume(volume) };
  }
  if (ordType === 'price') {
    // 시장가 매수 — 금액만 넣는다. 수량을 함께 넣으면 거부된다.
    assertPositive(krwAmount, 'krwAmount');
    return { market, side: 'bid', ord_type: 'price', price: String(krwAmount) };
  }
  throw new RangeError(`진입 주문 유형은 limit 또는 price여야 합니다: ${ordType}`);
}

function buildExitOrder({ symbol, price, volume, ordType = 'limit' }) {
  const market = toMarket(symbol);

  if (ordType === 'limit') {
    assertPositive(price, 'price');
    assertPositive(volume, 'volume');
    return { market, side: 'ask', ord_type: 'limit', price: String(price), volume: roundVolume(volume) };
  }
  if (ordType === 'market') {
    // 시장가 매도 — 수량만 넣는다. 가격을 함께 넣으면 거부된다.
    assertPositive(volume, 'volume');
    return { market, side: 'ask', ord_type: 'market', volume: roundVolume(volume) };
  }
  throw new RangeError(`청산 주문 유형은 limit 또는 market이어야 합니다: ${ordType}`);
}

function parseAccounts(rows) {
  if (!Array.isArray(rows)) {
    throw new TypeError('계좌 응답은 배열이어야 합니다');
  }
  let krw = 0;
  const holdings = {};
  for (const a of rows) {
    const total = Number(a.balance || 0) + Number(a.locked || 0);
    if (a.currency === 'KRW') krw = total;
    else if (total > 0) holdings[a.currency] = total;
  }
  return { krw, holdings };
}

// ── 네트워크 (실제 계좌에 영향) ──────────────────────────────────────────────

function creds() {
  const apiKey = process.env.BITHUMB_API_KEY;
  const secret = process.env.BITHUMB_SECRET_KEY;
  if (!apiKey || !secret) {
    throw new Error('BITHUMB_API_KEY / BITHUMB_SECRET_KEY가 설정되지 않았습니다');
  }
  return { apiKey, secret };
}

async function request(method, path, params = null) {
  const { apiKey, secret } = creds();
  const query = params ? encodeQuery(params) : '';
  const headers = buildV2Headers({ apiKey, secret, query });

  const url = method === 'GET' && query ? `${BASE}${path}?${query}` : `${BASE}${path}`;
  const res = await fetch(url, {
    method,
    headers,
    body: method === 'GET' ? undefined : JSON.stringify(params || {}),
  });

  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`빗썸 응답을 해석할 수 없습니다 (HTTP ${res.status})`);
  }
  if (!res.ok) {
    // 오류 본문에 키가 실릴 일은 없지만, 메시지만 꺼내 쓴다.
    const msg = json?.error?.message || json?.message || `HTTP ${res.status}`;
    throw new Error(`빗썸 주문 오류: ${msg}`);
  }
  return json;
}

const getAccounts = () => request('GET', '/v1/accounts').then(parseAccounts);

// ⚠ 아래 두 함수는 실제 주문을 낸다.
const placeOrder = (payload) => request('POST', '/v1/orders', payload);
const cancelOrder = (uuid) => request('DELETE', '/v1/order', { uuid });
const getOrder = (uuid) => request('GET', '/v1/order', { uuid });

module.exports = {
  BASE,
  toMarket,
  roundVolume,
  buildEntryOrder,
  buildExitOrder,
  parseAccounts,
  getAccounts,
  placeOrder,
  cancelOrder,
  getOrder,
};
