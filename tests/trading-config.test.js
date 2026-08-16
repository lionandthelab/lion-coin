const { test } = require('node:test');
const assert = require('node:assert/strict');

const { FIELDS, validateConfigPatch } = require('../src/trading-config');

const base = {
  interval: '5m', maxSymbols: 60, minTradeValue24h: 1e8, lookback: 20, volMult: 3,
  takeProfitBps: 200, stopLossBps: 100, feeBps: 4, capitalKrw: 39000, riskPct: 1,
  scanIntervalSec: 60, maxSpreadBps: 30, maxBreakevenWinRate: 0.6,
  maxConcurrentPositions: 1, minNotionalKrw: 5000,
  note: '문서용', rationale: { a: 'b' },
};

// 이 설정은 실제 주문 금액과 손절 폭을 정한다. 화면에서 아무 값이나 넣을 수 있으면
// 잘못된 주문이 그대로 거래소로 나간다 — 검증을 서버에서 한 번 더 하는 이유다.

test('validateConfigPatch: 유효한 변경은 병합해 돌려준다', () => {
  const r = validateConfigPatch({ takeProfitBps: 300 }, base);
  assert.equal(r.ok, true);
  assert.equal(r.config.takeProfitBps, 300);
  assert.equal(r.config.stopLossBps, 100, '건드리지 않은 값은 유지');
});

test('validateConfigPatch: 문서 필드는 변경 대상이 아니다', () => {
  const r = validateConfigPatch({ note: '해킹', rationale: {} }, base);
  assert.equal(r.ok, false);
  assert.match(r.errors.join(' '), /note/);
});

test('validateConfigPatch: 모르는 키는 거부한다', () => {
  const r = validateConfigPatch({ 이상한키: 1 }, base);
  assert.equal(r.ok, false);
  assert.match(r.errors.join(' '), /이상한키/);
});

test('validateConfigPatch: 빈 변경도 유효하다 (아무것도 안 바뀜)', () => {
  const r = validateConfigPatch({}, base);
  assert.equal(r.ok, true);
  assert.deepEqual(r.config, base);
});

// ---- 개별 범위 ----

test('validateConfigPatch: 자본이 0 이하면 거부', () => {
  assert.equal(validateConfigPatch({ capitalKrw: 0 }, base).ok, false);
  assert.equal(validateConfigPatch({ capitalKrw: -100 }, base).ok, false);
});

test('validateConfigPatch: 위험 비중이 100%를 넘으면 거부', () => {
  assert.equal(validateConfigPatch({ riskPct: 101 }, base).ok, false);
  assert.equal(validateConfigPatch({ riskPct: 100 }, base).ok, true);
});

test('validateConfigPatch: 익절·손절 폭이 0 이하면 거부', () => {
  assert.equal(validateConfigPatch({ takeProfitBps: 0 }, base).ok, false);
  assert.equal(validateConfigPatch({ stopLossBps: -1 }, base).ok, false);
});

test('validateConfigPatch: 지원하지 않는 캔들 간격은 거부', () => {
  assert.equal(validateConfigPatch({ interval: '2m' }, base).ok, false);
  assert.equal(validateConfigPatch({ interval: '1h' }, base).ok, true);
});

test('validateConfigPatch: 스캔 주기가 너무 짧으면 거부 (거래소 호출 제한)', () => {
  assert.equal(validateConfigPatch({ scanIntervalSec: 1 }, base).ok, false);
  assert.equal(validateConfigPatch({ scanIntervalSec: 30 }, base).ok, true);
});

test('validateConfigPatch: 손익분기 상한은 0~1 사이여야 한다', () => {
  assert.equal(validateConfigPatch({ maxBreakevenWinRate: 1.5 }, base).ok, false);
  assert.equal(validateConfigPatch({ maxBreakevenWinRate: 0 }, base).ok, false);
  assert.equal(validateConfigPatch({ maxBreakevenWinRate: 0.8 }, base).ok, true);
});

test('validateConfigPatch: 정수 필드에 소수를 넣으면 거부', () => {
  assert.equal(validateConfigPatch({ lookback: 20.5 }, base).ok, false);
  assert.equal(validateConfigPatch({ maxConcurrentPositions: 1.5 }, base).ok, false);
});

test('validateConfigPatch: 숫자가 아닌 값은 거부', () => {
  assert.equal(validateConfigPatch({ capitalKrw: '39000' }, base).ok, false);
  assert.equal(validateConfigPatch({ riskPct: null }, base).ok, false);
});

// ---- 조합 검증 ----
// 개별 값이 다 유효해도 조합이 무의미할 수 있다.

test('validateConfigPatch: 설정만으로 손익분기 승률이 1을 넘으면 거부', () => {
  // 익절 20bps, 손절 100bps, 수수료 4bps×2 + 스프레드 상한 30 → 손익분기 > 1
  const r = validateConfigPatch({ takeProfitBps: 20, stopLossBps: 100 }, base);
  assert.equal(r.ok, false);
  assert.match(r.errors.join(' '), /손익분기/);
});

test('validateConfigPatch: 최악의 스프레드에서도 상한을 지키면 통과', () => {
  const r = validateConfigPatch({ takeProfitBps: 500, stopLossBps: 100 }, base);
  assert.equal(r.ok, true);
});

test('validateConfigPatch: 여러 오류를 한꺼번에 돌려준다', () => {
  const r = validateConfigPatch({ capitalKrw: -1, riskPct: 200, interval: 'x' }, base);
  assert.equal(r.ok, false);
  assert.ok(r.errors.length >= 3, `오류 ${r.errors.length}건`);
});

test('FIELDS: 화면이 쓸 메타(단위·범위)를 노출한다', () => {
  assert.ok(FIELDS.capitalKrw.label);
  assert.equal(typeof FIELDS.riskPct.min, 'number');
  assert.ok(FIELDS.interval.options.includes('5m'));
});
