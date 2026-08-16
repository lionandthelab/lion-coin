'use strict';

// 빗썸 2.0 캔들 API — 업비트 호환. 파싱·URL 조립은 순수 함수, fetch는 얇은 래퍼.
//
// **왜 이 모듈이 필요한가:** 구버전 공개 API(/public/candlestick/)는 간격과 무관하게
// 200봉만 주고 페이지네이션이 없다. 30분봉이면 4일치가 전부라 어떤 검증도 성립하지
// 않는다 — 한 국면만 보고 "최적값"을 뽑게 된다.
// 2.0은 `to` 파라미터로 과거를 계속 거슬러 받을 수 있어 그 제약이 사라진다.
//
// ⚠ 필드 이름이 구버전과 다르다. 종가가 trade_price다 — opening/high/low와 달리
//   이름에 close가 없어 잘못 매핑하기 쉽고, 틀리면 조용히 다른 값으로 계산된다.

const BASE = 'https://api.bithumb.com';
const MAX_COUNT = 200;

// to는 'YYYY-MM-DDTHH:mm:ss' 여야 한다. Z나 밀리초를 붙이면 400이 돌아온다.
function formatTo(value) {
  const d = value instanceof Date ? value : new Date(value);
  return d.toISOString().slice(0, 19);
}

function buildV2CandleUrl({ market, unit = 30, count = MAX_COUNT, to = null, baseUrl = BASE } = {}) {
  if (typeof market !== 'string' || market.trim() === '') {
    throw new TypeError('market은 비어 있지 않은 문자열이어야 합니다 (예: KRW-BTC)');
  }
  if (!Number.isInteger(count) || count < 1 || count > MAX_COUNT) {
    throw new RangeError(`count는 1~${MAX_COUNT} 사이 정수여야 합니다: ${count}`);
  }

  const path =
    unit === 'days' || unit === 'weeks' || unit === 'months'
      ? `/v1/candles/${unit}`
      : `/v1/candles/minutes/${unit}`;

  let url = `${baseUrl.replace(/\/+$/, '')}${path}?market=${encodeURIComponent(market.trim())}&count=${count}`;
  if (to) url += `&to=${formatTo(to)}`;
  return url;
}

function toPositive(value, field, i) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) {
    throw new TypeError(`캔들[${i}]의 ${field}가 양의 유한수가 아닙니다: ${value}`);
  }
  return n;
}

function parseV2Candles(rows) {
  if (!Array.isArray(rows)) {
    throw new TypeError('빗썸 2.0 캔들 응답은 배열이어야 합니다');
  }

  const out = rows.map((r, i) => {
    // candle_date_time_utc에는 Z가 없다. UTC임을 명시해야 로컬 시간으로 해석되지 않는다.
    const openTime = Date.parse(`${r.candle_date_time_utc}Z`);
    if (!Number.isFinite(openTime)) {
      throw new TypeError(`캔들[${i}]의 시각을 해석할 수 없습니다: ${r.candle_date_time_utc}`);
    }

    const open = toPositive(r.opening_price, 'opening_price', i);
    const high = toPositive(r.high_price, 'high_price', i);
    const low = toPositive(r.low_price, 'low_price', i);
    const close = toPositive(r.trade_price, 'trade_price(종가)', i);

    const volume = Number(r.candle_acc_trade_volume);
    if (!Number.isFinite(volume) || volume < 0) {
      throw new TypeError(`캔들[${i}]의 거래량이 0 이상의 유한수가 아닙니다: ${r.candle_acc_trade_volume}`);
    }

    // 필드를 잘못 매핑하면 거의 항상 여기서 걸린다.
    if (high < low) {
      throw new TypeError(`캔들[${i}]의 고가(${high})가 저가(${low})보다 작습니다 — 필드 매핑을 확인하세요`);
    }
    if (open < low || open > high || close < low || close > high) {
      throw new TypeError(
        `캔들[${i}]의 시가(${open})·종가(${close})가 [${low}, ${high}] 범위를 벗어납니다 — 종가는 trade_price입니다`
      );
    }

    return { openTime, open, high, low, close, volume };
  });

  // 응답은 최신순이다. 백테스트는 오름차순을 전제하므로 뒤집는다.
  return out.sort((a, b) => a.openTime - b.openTime);
}

async function fetchV2Candles(options) {
  const res = await fetch(buildV2CandleUrl(options));
  if (!res.ok) {
    throw new Error(`빗썸 2.0 캔들 오류: HTTP ${res.status}`);
  }
  return parseV2Candles(await res.json());
}

// 원하는 개수만큼 과거로 거슬러 이어 받는다.
// 페이지 경계에서 겹칠 수 있으므로 이미 받은 시각보다 오래된 봉만 취한다.
async function fetchV2CandleHistory({ market, unit = 30, target = 2000, baseUrl = BASE, onPage } = {}) {
  const all = [];
  const seen = new Set();
  let to = null;

  while (all.length < target) {
    const page = await fetchV2Candles({ market, unit, count: MAX_COUNT, to, baseUrl });
    if (page.length === 0) break;

    let added = 0;
    for (const c of page) {
      if (seen.has(c.openTime)) continue;
      seen.add(c.openTime);
      all.push(c);
      added += 1;
    }
    if (onPage) onPage(all.length);
    // 진전이 없으면 더 과거가 없다는 뜻 — 무한 루프를 끊는다.
    if (added === 0) break;

    to = new Date(page[0].openTime); // 페이지 중 가장 오래된 봉 시각
  }

  all.sort((a, b) => a.openTime - b.openTime);
  return all;
}

module.exports = {
  BASE,
  MAX_COUNT,
  formatTo,
  buildV2CandleUrl,
  parseV2Candles,
  fetchV2Candles,
  fetchV2CandleHistory,
};
