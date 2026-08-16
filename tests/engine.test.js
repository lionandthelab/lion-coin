const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createEngineState, transition, applyScan, recordError, summarize } = require('../src/engine');

// live로 가는 길에 관문을 두 개 둔 것이 이 모듈의 핵심이다. 버튼 하나가 실수로
// 눌리는 것과 서로 다른 두 관문을 통과하는 것은 사고 확률이 다르다.

test('기본 모드는 stopped다', () => {
  assert.equal(createEngineState().mode, 'stopped');
});

test('stopped → dry는 승인 없이 전환된다 (모의는 위험하지 않다)', () => {
  const r = transition(createEngineState(), 'dry');
  assert.equal(r.ok, true);
  assert.equal(r.state.mode, 'dry');
  assert.ok(r.state.startedAt);
});

test('live는 환경변수 승인 없이 거부된다', () => {
  const r = transition(createEngineState(), 'live', { confirmLive: true });
  assert.equal(r.ok, false);
  assert.match(r.reason, /BITHUMB_LIVE/);
});

test('live는 명시적 확인 없이 거부된다', () => {
  const r = transition(createEngineState(), 'live', { liveApproved: true });
  assert.equal(r.ok, false);
  assert.match(r.reason, /확인/);
});

test('live는 두 관문을 모두 통과해야 전환된다', () => {
  const r = transition(createEngineState(), 'live', { liveApproved: true, confirmLive: true });
  assert.equal(r.ok, true);
  assert.equal(r.state.mode, 'live');
});

test('stopped로 돌아가면 시작 시각이 초기화된다', () => {
  const started = transition(createEngineState(), 'dry').state;
  assert.equal(transition(started, 'stopped').state.startedAt, null);
});

test('알 수 없는 모드는 RangeError', () => {
  assert.throws(() => transition(createEngineState(), 'turbo'), RangeError);
});

test('applyScan: 후보를 교체하고 신호는 누적한다', () => {
  let s = createEngineState();
  s = applyScan(s, { candidates: [{ symbol: 'A', executable: true }], signals: [{ symbol: 'A' }] });
  s = applyScan(s, { candidates: [{ symbol: 'B', executable: false }], signals: [{ symbol: 'B' }] });
  assert.deepEqual(s.candidates.map((c) => c.symbol), ['B'], '후보는 최신 스캔으로 교체');
  assert.equal(s.signals.length, 2, '신호는 누적');
  assert.equal(s.scans, 2);
});

test('applyScan: 신호가 상한을 넘으면 오래된 것부터 버린다', () => {
  let s = createEngineState();
  for (let i = 0; i < 10; i += 1) s = applyScan(s, { candidates: [], signals: [{ i }] }, 5);
  assert.equal(s.signals.length, 5);
  assert.equal(s.signals[0].i, 5);
});

test('recordError: 오류를 누적하되 상한을 둔다', () => {
  let s = createEngineState();
  for (let i = 0; i < 8; i += 1) s = recordError(s, 'e' + i, 3);
  assert.equal(s.errors.length, 3);
  assert.equal(s.errors[2].message, 'e7');
});

test('summarize: 실행 가능·차단 후보 수를 나눠 센다', () => {
  const s = applyScan(createEngineState(), {
    candidates: [{ executable: true }, { executable: false }, { executable: false }],
  });
  const v = summarize(s);
  assert.equal(v.scanned, 3);
  assert.equal(v.executable, 1);
  assert.equal(v.blocked, 2);
});

test('summarize: 비밀 값이 새어나갈 자리가 없다 (허용된 키만 노출)', () => {
  const s = { ...createEngineState(), apiKey: 'SECRET', secret: 'SECRET' };
  const v = summarize(s);
  assert.equal(v.apiKey, undefined);
  assert.equal(v.secret, undefined);
  assert.ok(!JSON.stringify(v).includes('SECRET'));
});
