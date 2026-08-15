'use strict';

// 바이낸스 선물 포지셔닝 데이터 — 미결제약정·롱숏비율·테이커 물량비율.
//
// 왜 급한가: 이 엔드포인트들은 **최근 30일치만** 준다. 그 이전 startTime은
// 거부된다(에러 -1130). 캔들처럼 나중에 소급해 받을 수 없으므로, 지금부터
// 매 회차 받아 쌓지 않으면 과거는 영영 만들 수 없다.
//
// 왜 중요한가: 이건 "다른 참여자들이 어디에 얼마나 몰려 있는가"를 거래소가
// 직접 집계해 공개하는 데이터다. 봇 역이용 계열에서 가격 파생 신호로는
// 얻을 수 없는 정보이고, docs/hft-research.md의 다음 단계 1번이다.

const DEFAULT_BASE_URL = 'https://fapi.binance.com';
const DEFAULT_MAX_LEN = 20000; // 5분 간격 × 20000 ≈ 69일치

function toNumber(value, field, i, { allowZero = false } = {}) {
  const n = Number(value);
  if (
    value === '' ||
    value === null ||
    value === undefined ||
    typeof value === 'boolean' ||
    !Number.isFinite(n) ||
    (allowZero ? n < 0 : n <= 0)
  ) {
    throw new TypeError(`포지셔닝[${i}]의 ${field}가 유효한 수가 아닙니다: ${value}`);
  }
  return n;
}

function toTimestamp(value, i) {
  if (!Number.isInteger(value)) {
    throw new TypeError(`포지셔닝[${i}]의 timestamp가 정수 밀리초가 아닙니다: ${value}`);
  }
  return value;
}

function assertRows(rows) {
  if (!Array.isArray(rows)) {
    throw new TypeError('포지셔닝 응답은 배열이어야 합니다');
  }
}

function parseOpenInterest(rows) {
  assertRows(rows);
  return rows.map((r, i) => ({
    t: toTimestamp(r?.timestamp, i),
    openInterest: toNumber(r?.sumOpenInterest, 'sumOpenInterest', i),
    openInterestValue: toNumber(r?.sumOpenInterestValue, 'sumOpenInterestValue', i),
  }));
}

// topLongShortPositionRatio · globalLongShortAccountRatio 공통 형식.
function parseRatioSeries(rows) {
  assertRows(rows);
  return rows.map((r, i) => ({
    t: toTimestamp(r?.timestamp, i),
    longShortRatio: toNumber(r?.longShortRatio, 'longShortRatio', i),
    longAccount: toNumber(r?.longAccount, 'longAccount', i),
    shortAccount: toNumber(r?.shortAccount, 'shortAccount', i),
  }));
}

function parseTakerRatio(rows) {
  assertRows(rows);
  return rows.map((r, i) => ({
    t: toTimestamp(r?.timestamp, i),
    buySellRatio: toNumber(r?.buySellRatio, 'buySellRatio', i),
    // 거래가 없던 구간은 물량 0이 정상값이다.
    buyVol: toNumber(r?.buyVol, 'buyVol', i, { allowZero: true }),
    sellVol: toNumber(r?.sellVol, 'sellVol', i, { allowZero: true }),
  }));
}

// 기존 이력에 새 관측을 이어붙인다.
// 회차가 겹치면 같은 타임스탬프가 다시 들어오므로 새 값으로 덮어쓰고,
// 정렬을 강제한다 — 한 번 오염되면 영구 기록이 망가진다.
function mergeSeries(existing, incoming, maxLen = DEFAULT_MAX_LEN) {
  if (!Array.isArray(existing) || !Array.isArray(incoming)) {
    throw new TypeError('existing과 incoming은 배열이어야 합니다');
  }
  if (incoming.length === 0) return existing;

  const byTime = new Map(existing.map((x) => [x.t, x]));
  for (const item of incoming) byTime.set(item.t, item);

  const merged = [...byTime.values()].sort((a, b) => a.t - b.t);
  return merged.length > maxLen ? merged.slice(merged.length - maxLen) : merged;
}

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`바이낸스 선물 응답 오류: HTTP ${res.status}`);
  }
  return res.json();
}

// 최근 구간만 받는다. startTime을 30일 이전으로 주면 거부되므로 아예 넘기지 않는다.
async function fetchPositioning({ symbol, period = '5m', limit = 500, baseUrl = DEFAULT_BASE_URL } = {}) {
  const q = `symbol=${String(symbol).toUpperCase()}&period=${period}&limit=${limit}`;
  const root = baseUrl.replace(/\/+$/, '');

  const [oi, topPos, globalAcc, taker] = await Promise.all([
    fetchJson(`${root}/futures/data/openInterestHist?${q}`),
    fetchJson(`${root}/futures/data/topLongShortPositionRatio?${q}`),
    fetchJson(`${root}/futures/data/globalLongShortAccountRatio?${q}`),
    fetchJson(`${root}/futures/data/takerlongshortRatio?${q}`),
  ]);

  return {
    openInterest: parseOpenInterest(oi),
    topPositionRatio: parseRatioSeries(topPos),
    globalAccountRatio: parseRatioSeries(globalAcc),
    takerRatio: parseTakerRatio(taker),
  };
}

const METRICS = ['openInterest', 'topPositionRatio', 'globalAccountRatio', 'takerRatio'];

module.exports = {
  DEFAULT_BASE_URL,
  DEFAULT_MAX_LEN,
  METRICS,
  parseOpenInterest,
  parseRatioSeries,
  parseTakerRatio,
  mergeSeries,
  fetchPositioning,
};
