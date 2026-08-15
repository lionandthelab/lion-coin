'use strict';

// 바이낸스 무기한 선물 펀딩비 수집·정렬.
//
// 왜 펀딩비인가: 지금까지 검증한 지표(EMA·RSI·돌파)는 전부 가격에서 파생된 신호라
// 서로 상관이 높고, 같은 정보를 다르게 자른 것에 가깝다. 펀딩비는 가격이 아니라
// **포지셔닝**을 담은 별개의 데이터다 — 롱이 몰리면 양수, 숏이 몰리면 음수가 된다.
// 가설이 다르므로 검증도 처음부터 다시 한다 (docs/walkforward-report.md 다음 시도 4번).
//
// 주의: 펀딩비는 선물 시장의 데이터지만, 이 프로젝트는 현물 롱 온리만 다룬다.
// 즉 펀딩을 수취하는 캐리 전략이 아니라, 펀딩을 **심리 지표로 읽는** 방식이다.

const DEFAULT_BASE_URL = 'https://fapi.binance.com';
const FUNDING_INTERVAL_MS = 8 * 60 * 60 * 1000;
const MAX_LIMIT = 1000;

function parseFundingRates(rows) {
  if (!Array.isArray(rows)) {
    throw new TypeError('펀딩비 응답은 배열이어야 합니다');
  }

  const out = [];
  let prevTime = null;

  rows.forEach((raw, i) => {
    if (!raw || typeof raw !== 'object') {
      throw new TypeError(`펀딩[${i}]이 객체가 아닙니다`);
    }
    const { fundingTime } = raw;
    if (!Number.isInteger(fundingTime)) {
      throw new TypeError(`펀딩[${i}]의 fundingTime이 정수 밀리초가 아닙니다: ${fundingTime}`);
    }
    // 요율은 0과 음수가 모두 정상값이라 falsy 검사로 거를 수 없다.
    const value = raw.fundingRate;
    const rate = Number(value);
    if (value === '' || value === null || typeof value === 'boolean' || !Number.isFinite(rate)) {
      throw new TypeError(`펀딩[${i}]의 fundingRate가 유한수가 아닙니다: ${value}`);
    }
    if (prevTime !== null && fundingTime <= prevTime) {
      throw new TypeError(
        `펀딩[${i}]의 fundingTime(${fundingTime})이 직전(${prevTime})보다 뒤가 아닙니다`
      );
    }
    prevTime = fundingTime;
    out.push({ fundingTime, fundingRate: rate });
  });

  return out;
}

// 8시간마다 정산되는 펀딩을 캔들 인덱스에 맞춰 편다.
// 각 봉에는 **그 봉이 닫히기 전까지 정산된** 가장 최근 값만 넣는다. 봉 도중이나
// 이후에 정산될 값을 미리 넣으면 그 순간 백테스트가 미래를 보게 된다.
function alignFundingToCandles(candles, fundingRates) {
  return alignFundingDetail(candles, fundingRates).map((d) => d.funding);
}

// 이어 쓴 값(funding)과 "이 봉에서 정산이 일어났는가"(settled)를 함께 돌려준다.
// 백테스트가 펀딩 비용을 물릴 때 이어 쓴 값에 매 봉 과금하면 8배를 물린다.
function alignFundingDetail(candles, fundingRates) {
  if (!Array.isArray(candles) || !Array.isArray(fundingRates)) {
    throw new TypeError('candles와 fundingRates는 배열이어야 합니다');
  }

  const out = new Array(candles.length);
  let cursor = 0;
  let current = null;

  for (let i = 0; i < candles.length; i += 1) {
    const { closeTime } = candles[i];
    let settled = false;
    while (cursor < fundingRates.length && fundingRates[cursor].fundingTime <= closeTime) {
      current = fundingRates[cursor].fundingRate;
      cursor += 1;
      settled = true;
    }
    out[i] = { funding: current, settled };
  }

  return out;
}

// 전략 시그니처를 (candles, params)로 유지하기 위해 펀딩을 캔들에 얹는다.
// 원본 배열은 건드리지 않는다 — 같은 캔들을 수백 개 파라미터 조합이 공유한다.
function attachFunding(candles, fundingRates) {
  const detail = alignFundingDetail(candles, fundingRates);
  return candles.map((c, i) => ({
    ...c,
    funding: detail[i].funding,
    fundingSettled: detail[i].settled,
  }));
}

async function fetchFundingRates({ symbol, startTime, endTime, baseUrl = DEFAULT_BASE_URL } = {}) {
  const params = [`symbol=${String(symbol).toUpperCase()}`, `limit=${MAX_LIMIT}`];
  if (startTime !== undefined) params.push(`startTime=${startTime}`);
  if (endTime !== undefined) params.push(`endTime=${endTime}`);

  const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/fapi/v1/fundingRate?${params.join('&')}`);
  if (!res.ok) {
    throw new Error(`바이낸스 선물 응답 오류: HTTP ${res.status}`);
  }
  return parseFundingRates(await res.json());
}

// 1회 1000건 상한을 넘는 구간을 이어 받는다. klines의 fetchKlinesRange와 같은 방식.
async function fetchFundingRange({ symbol, startTime, endTime, baseUrl, onPage } = {}) {
  const all = [];
  let cursor = startTime;

  while (cursor <= endTime) {
    const page = await fetchFundingRates({ symbol, startTime: cursor, endTime, baseUrl });
    if (page.length === 0) break;

    const last = all.length > 0 ? all[all.length - 1].fundingTime : -Infinity;
    for (const f of page) {
      if (f.fundingTime > last) all.push(f);
    }
    if (onPage) onPage(all.length);

    const next = page[page.length - 1].fundingTime + 1;
    if (next <= cursor) break;
    cursor = next;
  }

  return all;
}

module.exports = {
  DEFAULT_BASE_URL,
  FUNDING_INTERVAL_MS,
  parseFundingRates,
  alignFundingToCandles,
  alignFundingDetail,
  attachFunding,
  fetchFundingRates,
  fetchFundingRange,
};
