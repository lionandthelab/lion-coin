const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const {
  encodeQuery,
  signV1,
  buildV1Headers,
  base64url,
  signJwtHS256,
  buildV2Headers,
  queryHash,
} = require('../src/bithumb-auth');

// 인증 서명은 틀려도 "권한 없음"만 돌아와 원인을 알기 어렵다. 그래서 서명 자체를
// 순수 함수로 떼어 알려진 입력에 대해 고정한다 — 네트워크 없이 재현할 수 있어야
// 실패했을 때 서명 문제인지 키 문제인지 갈라볼 수 있다.

// ---- 공통 ----

test('encodeQuery: 키 순서를 유지하며 폼 인코딩한다', () => {
  assert.equal(encodeQuery({ endpoint: '/info/balance', currency: 'ALL' }), 'endpoint=%2Finfo%2Fbalance&currency=ALL');
});

test('encodeQuery: 값이 undefined인 키는 생략한다', () => {
  assert.equal(encodeQuery({ a: '1', b: undefined, c: '3' }), 'a=1&c=3');
});

test('base64url: +/= 를 URL 안전 문자로 바꾼다', () => {
  const out = base64url(Buffer.from([251, 255, 190]));
  assert.ok(!/[+/=]/.test(out), out);
});

// ---- 빗썸 1.0 (HMAC-SHA512) ----

test('signV1: endpoint\\0params\\0nonce 를 HMAC-SHA512로 서명하고 hex를 base64로 감싼다', () => {
  const secret = 'testsecret';
  const endpoint = '/info/balance';
  const params = 'endpoint=%2Finfo%2Fbalance&currency=ALL';
  const nonce = '1700000000000';

  const expectedHex = crypto
    .createHmac('sha512', secret)
    .update(`${endpoint}\0${params}\0${nonce}`)
    .digest('hex');
  const expected = Buffer.from(expectedHex).toString('base64');

  assert.equal(signV1({ endpoint, params, nonce, secret }), expected);
});

test('signV1: nonce가 다르면 서명도 다르다 (재전송 방지)', () => {
  const base = { endpoint: '/info/balance', params: 'a=1', secret: 's' };
  assert.notEqual(signV1({ ...base, nonce: '1' }), signV1({ ...base, nonce: '2' }));
});

test('buildV1Headers: 필수 헤더를 모두 채운다', () => {
  const h = buildV1Headers({
    endpoint: '/info/balance', params: 'currency=ALL', nonce: '123',
    apiKey: 'KEY', secret: 'SECRET',
  });
  assert.equal(h['Api-Key'], 'KEY');
  assert.equal(h['Api-Nonce'], '123');
  assert.ok(h['Api-Sign']);
  assert.match(h['Content-Type'], /x-www-form-urlencoded/);
});

test('buildV1Headers: 시크릿이 헤더에 그대로 실리지 않는다', () => {
  const h = buildV1Headers({
    endpoint: '/info/balance', params: '', nonce: '1', apiKey: 'KEY', secret: 'SUPERSECRET',
  });
  assert.ok(!JSON.stringify(h).includes('SUPERSECRET'));
});

// ---- 빗썸 2.0 (JWT HS256) ----

test('signJwtHS256: 세 구획 JWT를 만든다', () => {
  const jwt = signJwtHS256({ access_key: 'k', nonce: 'n', timestamp: 1 }, 'secret');
  assert.equal(jwt.split('.').length, 3);
});

test('signJwtHS256: 페이로드를 복원할 수 있다', () => {
  const payload = { access_key: 'k', nonce: 'n', timestamp: 1700000000000 };
  const jwt = signJwtHS256(payload, 'secret');
  const decoded = JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString('utf8'));
  assert.deepEqual(decoded, payload);
});

test('signJwtHS256: 시크릿이 다르면 서명이 다르다', () => {
  const p = { access_key: 'k', nonce: 'n', timestamp: 1 };
  assert.notEqual(signJwtHS256(p, 'a'), signJwtHS256(p, 'b'));
});

test('queryHash: 쿼리 문자열을 SHA512 hex로 만든다', () => {
  const q = 'market=KRW-BTC&side=bid';
  assert.equal(queryHash(q), crypto.createHash('sha512').update(q).digest('hex'));
});

test('buildV2Headers: Bearer 토큰을 만든다', () => {
  const h = buildV2Headers({ apiKey: 'KEY', secret: 'SECRET', query: 'a=1' });
  assert.match(h.Authorization, /^Bearer /);
  assert.ok(!JSON.stringify(h).includes('SECRET'));
});

test('buildV2Headers: 쿼리가 있으면 해시를 페이로드에 넣는다', () => {
  const h = buildV2Headers({ apiKey: 'KEY', secret: 'SECRET', query: 'a=1' });
  const payload = JSON.parse(
    Buffer.from(h.Authorization.slice(7).split('.')[1], 'base64url').toString('utf8')
  );
  assert.equal(payload.query_hash, queryHash('a=1'));
  assert.equal(payload.query_hash_alg, 'SHA512');
});

test('buildV2Headers: 쿼리가 없으면 해시 필드를 넣지 않는다', () => {
  const h = buildV2Headers({ apiKey: 'KEY', secret: 'SECRET' });
  const payload = JSON.parse(
    Buffer.from(h.Authorization.slice(7).split('.')[1], 'base64url').toString('utf8')
  );
  assert.equal(payload.query_hash, undefined);
});
