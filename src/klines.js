'use strict';

// 바이낸스 현물 klines(OHLCV) 수집·정규화. 인증이 필요 없는 공개 엔드포인트다.
// balance.js·fees.js와 같은 방침: 파싱·URL 조립은 순수 함수로 TDD하고, fetch는 얇은 래퍼로 둔다.

const DEFAULT_BASE_URL = 'https://api.binance.com';
const MAX_LIMIT = 1000; // 바이낸스 /api/v3/klines 1회 응답 상한

// 바이낸스는 가격·거래량을 문자열로 보낸다. 숫자로 바꾸되, 해석 실패는 0으로 뭉개지 않는다.
function toPrice(value, field, index) {
  const n = Number(value);
  if (typeof value === 'boolean' || value === null || value === '' || !Number.isFinite(n) || n <= 0) {
    throw new TypeError(`캔들[${index}]의 ${field}가 양의 유한수가 아닙니다: ${value}`);
  }
  return n;
}

function toVolume(value, index) {
  const n = Number(value);
  if (typeof value === 'boolean' || value === null || value === '' || !Number.isFinite(n) || n < 0) {
    throw new TypeError(`캔들[${index}]의 volume이 0 이상의 유한수가 아닙니다: ${value}`);
  }
  return n;
}

function toTimestamp(value, field, index) {
  if (!Number.isInteger(value)) {
    throw new TypeError(`캔들[${index}]의 ${field}가 정수 밀리초가 아닙니다: ${value}`);
  }
  return value;
}

// 응답 행 배열 → { openTime, open, high, low, close, volume, closeTime } 배열.
// 손상된 캔들은 백테스트 성과를 조용히 왜곡하므로 여기서 전부 막는다.
function parseKlines(rows) {
  if (!Array.isArray(rows)) {
    throw new TypeError('klines 응답은 배열이어야 합니다');
  }

  const candles = [];
  let prevOpenTime = null;

  rows.forEach((raw, i) => {
    if (!Array.isArray(raw) || raw.length < 7) {
      throw new TypeError(`캔들[${i}]은 최소 7개 필드를 가진 배열이어야 합니다`);
    }

    const openTime = toTimestamp(raw[0], 'openTime', i);
    const open = toPrice(raw[1], 'open', i);
    const high = toPrice(raw[2], 'high', i);
    const low = toPrice(raw[3], 'low', i);
    const close = toPrice(raw[4], 'close', i);
    const volume = toVolume(raw[5], i);
    const closeTime = toTimestamp(raw[6], 'closeTime', i);

    if (high < low) {
      throw new TypeError(`캔들[${i}]의 high(${high})가 low(${low})보다 작습니다`);
    }
    if (open < low || open > high || close < low || close > high) {
      throw new TypeError(
        `캔들[${i}]의 open(${open})·close(${close})가 [${low}, ${high}] 범위를 벗어납니다`
      );
    }
    if (prevOpenTime !== null && openTime <= prevOpenTime) {
      throw new TypeError(
        `캔들[${i}]의 openTime(${openTime})이 직전 캔들(${prevOpenTime})보다 뒤가 아닙니다 — 역순이거나 중복된 봉입니다`
      );
    }
    prevOpenTime = openTime;

    candles.push({ openTime, open, high, low, close, volume, closeTime });
  });

  return candles;
}

function requireSymbolPart(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${field}는 비어 있지 않은 문자열이어야 합니다`);
  }
  return value.trim();
}

function buildKlinesUrl({
  symbol,
  interval,
  limit = MAX_LIMIT,
  startTime,
  endTime,
  baseUrl = DEFAULT_BASE_URL,
} = {}) {
  const sym = requireSymbolPart(symbol, 'symbol').toUpperCase();
  const iv = requireSymbolPart(interval, 'interval');

  // 상한을 조용히 깎으면 받은 개수를 착각한 채 백테스트 구간이 어긋난다.
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw new RangeError(`limit은 1~${MAX_LIMIT} 사이 정수여야 합니다: ${limit}`);
  }

  const params = [`symbol=${sym}`, `interval=${iv}`, `limit=${limit}`];
  if (startTime !== undefined) {
    params.push(`startTime=${toTimestamp(startTime, 'startTime', 0)}`);
  }
  if (endTime !== undefined) {
    params.push(`endTime=${toTimestamp(endTime, 'endTime', 0)}`);
  }

  return `${baseUrl.replace(/\/+$/, '')}/api/v3/klines?${params.join('&')}`;
}

const MINUTE = 60 * 1000;
const INTERVAL_MS = {
  '1m': MINUTE,
  '3m': 3 * MINUTE,
  '5m': 5 * MINUTE,
  '15m': 15 * MINUTE,
  '30m': 30 * MINUTE,
  '1h': 60 * MINUTE,
  '2h': 120 * MINUTE,
  '4h': 240 * MINUTE,
  '6h': 360 * MINUTE,
  '8h': 480 * MINUTE,
  '12h': 720 * MINUTE,
  '1d': 1440 * MINUTE,
  '3d': 3 * 1440 * MINUTE,
  '1w': 7 * 1440 * MINUTE,
};

// 페이지네이션은 "직전 페이지 마지막 봉 + 1간격"에서 다음 페이지를 시작한다.
// 이 간격을 추측하면 봉이 빠지거나 겹치므로, 아는 값만 돌려주고 나머지는 거부한다.
function intervalToMs(interval) {
  const ms = typeof interval === 'string' ? INTERVAL_MS[interval] : undefined;
  if (ms === undefined) {
    throw new TypeError(
      `알 수 없는 interval입니다: ${interval} (지원: ${Object.keys(INTERVAL_MS).join(', ')})`
    );
  }
  return ms;
}

async function fetchKlines(options) {
  const res = await fetch(buildKlinesUrl(options));
  if (!res.ok) {
    throw new Error(`바이낸스 응답 오류: HTTP ${res.status}`);
  }
  return parseKlines(await res.json());
}

// 1회 응답 상한(1000봉)을 넘는 구간을 여러 요청으로 이어 받는다.
// 이어붙인 결과는 parseKlines의 검사를 통과한 페이지들이지만, 페이지 경계에서
// 겹칠 수 있으므로 직전 마지막 openTime 이하인 봉은 버린다.
async function fetchKlinesRange({ symbol, interval, startTime, endTime, baseUrl, onPage } = {}) {
  const step = intervalToMs(interval);
  const all = [];
  let cursor = startTime;

  while (cursor <= endTime) {
    const page = await fetchKlines({ symbol, interval, startTime: cursor, endTime, baseUrl });
    if (page.length === 0) break;

    const last = all.length > 0 ? all[all.length - 1].openTime : -Infinity;
    for (const c of page) {
      if (c.openTime > last) all.push(c);
    }

    if (onPage) onPage(all.length, page[page.length - 1].openTime);

    const next = page[page.length - 1].openTime + step;
    if (next <= cursor) break; // 진전이 없으면 무한 루프를 끊는다
    cursor = next;
  }

  return all;
}

module.exports = {
  DEFAULT_BASE_URL,
  MAX_LIMIT,
  INTERVAL_MS,
  parseKlines,
  buildKlinesUrl,
  intervalToMs,
  fetchKlines,
  fetchKlinesRange,
};
