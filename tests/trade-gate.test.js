const { test } = require('node:test');
const assert = require('node:assert/strict');

const { GRADE_RANK, shouldTrade, describeTarget, canEnterLiveMode } = require('../src/trade-gate');
const { classifyMaterial } = require('../src/material');

// 데몬의 매매 관문. 지금까지 scripts/event-trader.js 안에 있어 테스트가 닿지 않았다.
//
// **이 관문이 조용히 버리는 재료가 무엇인지 화면에 남아야 한다.** 08-17에 주문
// 크기 계산이 최소 주문금액에 걸려 모든 신호가 조용히 사라진 적이 있다. 그때도
// 관문 자체는 정상 동작했고, 무엇이 왜 버려졌는지 기록이 없던 것이 문제였다.

const cfg = { minGrade: 'A', tradeStaleEvents: false };
const mat = (o = {}) => ({
  grade: 'S', direction: 'bullish', kind: '원화상장',
  tickers: ['NEXO'], candidateTickers: ['NEXO'], stale: false, ...o,
});

test('shouldTrade: 등급·방향·티커가 모두 갖춰지면 통과한다', () => {
  assert.equal(shouldTrade(mat(), cfg).ok, true);
});

test('shouldTrade: 악재는 현물에서 막는다', () => {
  const r = shouldTrade(mat({ direction: 'bearish' }), cfg);
  assert.equal(r.ok, false);
  assert.match(r.why, /악재|하락/);
});

test('shouldTrade: 방향을 모르면 매매하지 않는다', () => {
  assert.equal(shouldTrade(mat({ direction: 'neutral' }), cfg).ok, false);
});

test('shouldTrade: 등급 하한 미만은 막는다', () => {
  assert.equal(shouldTrade(mat({ grade: 'B' }), cfg).ok, false);
  assert.equal(shouldTrade(mat({ grade: 'A' }), cfg).ok, true);
});

test('shouldTrade: 이미 반영된 후속 공지는 기본적으로 막고, 설정으로 열 수 있다', () => {
  assert.equal(shouldTrade(mat({ stale: true }), cfg).ok, false);
  assert.equal(shouldTrade(mat({ stale: true }), { ...cfg, tradeStaleEvents: true }).ok, true);
});

// ---- 미상장과 추출 실패를 구별한다 ----

test('shouldTrade: 미상장 종목은 "티커를 못 찾음"이 아니라 미상장으로 남긴다', () => {
  // 신규 상장 공지의 종목은 정의상 아직 거래소 목록에 없다. 이걸 추출 실패와
  // 같은 문구로 적으면, 분별기가 고장 난 것인지 애초에 살 수 없는 것인지
  // 화면만 보고는 구별할 수 없다.
  const r = shouldTrade(mat({ tickers: [], candidateTickers: ['SOPH'] }), cfg);
  assert.equal(r.ok, false);
  assert.match(r.why, /SOPH/, '무슨 종목 이야기였는지는 남아야 한다');
  assert.ok(!/찾지\s*못/.test(r.why), `추출 실패와 같은 문구다: ${r.why}`);
});

test('shouldTrade: 대상 자체를 못 읽었으면 그렇게 적는다', () => {
  const r = shouldTrade(mat({ tickers: [], candidateTickers: [] }), cfg);
  assert.equal(r.ok, false);
  assert.match(r.why, /찾지\s*못/);
});

test('shouldTrade: 등급이 없으면 매매 대상이 아니다', () => {
  assert.equal(shouldTrade(mat({ grade: null }), cfg).ok, false);
});

test('shouldTrade: 필드가 없는 재료에도 던지지 않는다', () => {
  // 폴링 루프 안에서 던지면 그 주기의 남은 재료가 통째로 사라진다.
  for (const m of [undefined, null, {}, { grade: 'S' }, { tickers: null }]) {
    const r = shouldTrade(m, cfg);
    assert.equal(r.ok, false);
    assert.equal(typeof r.why, 'string');
  }
});

// ---- 실제 파이프라인 ----

test('shouldTrade: 실제 S급 신규 상장 공지가 미상장으로 분류된다', () => {
  const m = classifyMaterial({
    title: '소파이(SOPH) KRW 마켓 디지털 자산 추가',
    category: '거래', source: 'upbit', knownSymbols: ['BTC', 'ETH'],
  });
  const r = shouldTrade(m, cfg);
  assert.equal(r.ok, false);
  assert.match(r.why, /SOPH/);
});

// ---- 표시용 대상 ----

test('describeTarget: 거래 가능한 티커를 우선한다', () => {
  assert.equal(describeTarget(mat({ tickers: ['NEXO'], candidateTickers: ['WRONG'] })), 'NEXO');
});

test('describeTarget: 거래 불가면 후보를 쓴다', () => {
  assert.equal(describeTarget(mat({ tickers: [], candidateTickers: ['SOPH'] })), 'SOPH');
});

test('describeTarget: 둘 다 없으면 null — 없는 이름을 지어내지 않는다', () => {
  assert.equal(describeTarget(mat({ tickers: [], candidateTickers: [] })), null);
  assert.equal(describeTarget(null), null);
});

test('GRADE_RANK: S가 가장 높고 C가 가장 낮다', () => {
  assert.ok(GRADE_RANK.S > GRADE_RANK.A);
  assert.ok(GRADE_RANK.A > GRADE_RANK.B);
  assert.ok(GRADE_RANK.B > GRADE_RANK.C);
});

test('shouldTrade: 모르는 하한 등급은 통과시키지 않는다', () => {
  // 설정 오타로 minGrade가 'X'가 되면 전부 통과시키는 것이 가장 위험하다.
  const r = shouldTrade(mat(), { ...cfg, minGrade: 'X' });
  assert.equal(r.ok, false);
  assert.match(r.why, /하한|설정/);
});

// ---- 실거래 전환 관문 ----
//
// **화면에서만 막는 것은 관문이 아니다.** 대시보드는 키가 없으면 버튼을 비활성화
// 하지만, 서버는 그 조건을 전혀 보지 않았다. curl 한 줄이나 오래된 탭이면 그대로
// 통과한다 — 키 없이 live로 들어가면 재료를 잡을 때마다 주문이 실패하고,
// 화면에는 "실거래 중"이라고 적혀 있다.

test('canEnterLiveMode: 승인·키·확인이 모두 있어야 통과한다', () => {
  const r = canEnterLiveMode({ liveApproved: true, hasKeys: true, confirmLive: true });
  assert.equal(r.ok, true);
  assert.equal(r.reason, null);
});

test('canEnterLiveMode: .env 승인이 없으면 막는다', () => {
  const r = canEnterLiveMode({ liveApproved: false, hasKeys: true, confirmLive: true });
  assert.equal(r.ok, false);
  assert.match(r.reason, /BITHUMB_LIVE/);
});

test('canEnterLiveMode: API 키가 없으면 막는다', () => {
  // 키 없이 live로 들어가면 재료를 잡을 때마다 주문이 실패하는데
  // 화면에는 "실거래 중"이라고 적힌다 — 가장 헷갈리는 상태다.
  const r = canEnterLiveMode({ liveApproved: true, hasKeys: false, confirmLive: true });
  assert.equal(r.ok, false);
  assert.match(r.reason, /키/);
});

test('canEnterLiveMode: 명시적 확인이 없으면 막는다', () => {
  const r = canEnterLiveMode({ liveApproved: true, hasKeys: true, confirmLive: false });
  assert.equal(r.ok, false);
  assert.match(r.reason, /확인/);
});

test('canEnterLiveMode: confirmLive는 true여야 한다 — 참 같은 값은 안 된다', () => {
  // JSON 본문의 'true' 문자열이나 1이 통과하면 확인 관문이 형식적인 것이 된다.
  for (const v of ['true', 1, {}, [], 'yes']) {
    assert.equal(canEnterLiveMode({ liveApproved: true, hasKeys: true, confirmLive: v }).ok, false, String(v));
  }
});

test('canEnterLiveMode: 인자가 없어도 던지지 않고 막는다', () => {
  // 요청 처리 경로에서 던지면 500이 나가고, 화면은 그걸 "연결 끊김"과 구별하지 못한다.
  for (const bad of [undefined, null, {}, 'nope']) {
    const r = canEnterLiveMode(bad);
    assert.equal(r.ok, false, String(bad));
    assert.equal(typeof r.reason, 'string');
  }
});
