'use strict';

// 빗썸 인증 서명 — 순수 함수. 네트워크 호출은 bithumb-trade.js 책임.
//
// 빗썸은 두 세대의 API가 공존한다:
//   1.0 — Api-Key / Api-Sign / Api-Nonce 헤더, HMAC-SHA512
//   2.0 — Authorization: Bearer <JWT>, HS256 (업비트와 같은 방식)
// 어느 쪽 키인지는 발급 시점에 따라 다르므로 둘 다 만들어 두고 실제 응답으로 가린다.
//
// 서명이 틀리면 "권한 없음"만 돌아와 원인을 알기 어렵다. 그래서 서명 자체를
// 네트워크 없이 재현 가능한 순수 함수로 떼어 뒀다 — 실패했을 때 서명 문제인지
// 키 문제인지 갈라볼 수 있어야 한다.
//
// ⚠ 시크릿은 어떤 반환값에도 실리지 않는다. 헤더에는 서명 결과만 들어간다.

const crypto = require('node:crypto');

function encodeQuery(params = {}) {
  return Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
}

function base64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// ── 빗썸 1.0 ────────────────────────────────────────────────────────────────

// endpoint \0 params \0 nonce 를 HMAC-SHA512로 서명한 뒤, **hex 문자열을 다시
// base64로 감싼다**. 이 이중 인코딩이 빗썸 1.0의 특이점이고 가장 자주 틀리는 부분이다.
function signV1({ endpoint, params, nonce, secret }) {
  const hex = crypto
    .createHmac('sha512', secret)
    .update(`${endpoint}\0${params}\0${nonce}`)
    .digest('hex');
  return Buffer.from(hex).toString('base64');
}

function buildV1Headers({ endpoint, params, nonce, apiKey, secret }) {
  return {
    'Api-Key': apiKey,
    'Api-Sign': signV1({ endpoint, params, nonce, secret }),
    'Api-Nonce': String(nonce),
    'Content-Type': 'application/x-www-form-urlencoded',
  };
}

// ── 빗썸 2.0 (JWT) ──────────────────────────────────────────────────────────

function signJwtHS256(payload, secret) {
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = base64url(JSON.stringify(payload));
  const sig = base64url(crypto.createHmac('sha256', secret).update(`${header}.${body}`).digest());
  return `${header}.${body}.${sig}`;
}

function queryHash(query) {
  return crypto.createHash('sha512').update(query).digest('hex');
}

function buildV2Headers({ apiKey, secret, query = '', nonce = crypto.randomUUID(), timestamp = Date.now() }) {
  const payload = { access_key: apiKey, nonce, timestamp };
  // 파라미터가 있는 요청은 그 해시를 페이로드에 넣어야 서명이 통과한다.
  if (query) {
    payload.query_hash = queryHash(query);
    payload.query_hash_alg = 'SHA512';
  }
  return {
    Authorization: `Bearer ${signJwtHS256(payload, secret)}`,
    'Content-Type': 'application/json',
  };
}

module.exports = {
  encodeQuery,
  base64url,
  signV1,
  buildV1Headers,
  signJwtHS256,
  queryHash,
  buildV2Headers,
};
