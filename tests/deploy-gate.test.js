const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  evaluateDeployGate,
  parseTestOutput,
  BLOCKER,
} = require('../src/deploy-gate');

// 배포 게이트 — 복기에서 나온 개선안이 실행 중인 시스템에 들어가도 되는지 판정한다.
//
// **이 게이트의 존재 이유: 실행 중인 시스템은 자동으로 바뀌지 않는다.**
// 코드 개선이 자동으로 main에 들어가고 데몬이 재시작되면, 어느 버전이 어떤 거래를
// 냈는지 알 수 없어 롤백 판단 자체가 불가능해진다. 게이트를 통과한 뒤에도
// 병합과 배포는 사람이 한다.
//
// **테스트 수 감소를 막는 것이 특히 중요하다.** 에이전트가 실패하는 테스트를 지워서
// 초록을 만드는 것은 가장 그럴듯한 실패 방식이다. 통과 여부만 보면 잡히지 않는다.

const ok = (o = {}) => ({
  tests: { passed: 800, failed: 0, total: 800 },
  baselineTests: { passed: 790, failed: 0, total: 790 },
  openPosition: false,
  mode: 'watching',
  ...o,
});

// ---- 테스트 출력 파싱 ----

test('parseTestOutput: node --test 요약을 읽는다', () => {
  const r = parseTestOutput([
    'ℹ tests 806', 'ℹ suites 0', 'ℹ pass 806', 'ℹ fail 0', 'ℹ cancelled 0',
  ].join('\n'));
  assert.deepEqual(r, { total: 806, passed: 806, failed: 0 });
});

test('parseTestOutput: 실패가 있는 출력도 읽는다', () => {
  const r = parseTestOutput('ℹ tests 100\nℹ pass 97\nℹ fail 3');
  assert.equal(r.failed, 3);
  assert.equal(r.passed, 97);
});

test('parseTestOutput: 요약이 없으면 null (0으로 위장하지 않는다)', () => {
  // 파싱 실패를 "0 실패"로 읽으면 테스트가 아예 안 돌아도 게이트가 열린다.
  assert.equal(parseTestOutput('빌드 실패로 테스트를 실행하지 못했습니다'), null);
  assert.equal(parseTestOutput(''), null);
});

// ---- 게이트 판정 ----

test('evaluateDeployGate: 모든 조건이 맞으면 통과', () => {
  const r = evaluateDeployGate(ok());
  assert.equal(r.pass, true);
  assert.deepEqual(r.blockers, []);
});

test('evaluateDeployGate: 테스트가 하나라도 실패하면 막는다', () => {
  const r = evaluateDeployGate(ok({ tests: { passed: 799, failed: 1, total: 800 } }));
  assert.equal(r.pass, false);
  assert.ok(r.blockers.some((b) => b.code === BLOCKER.TESTS_FAILED));
});

test('evaluateDeployGate: 테스트 결과를 못 읽으면 막는다', () => {
  // 실행 자체가 안 된 것과 통과한 것을 구별하지 못하면 게이트가 무의미하다.
  const r = evaluateDeployGate(ok({ tests: null }));
  assert.equal(r.pass, false);
  assert.ok(r.blockers.some((b) => b.code === BLOCKER.TESTS_UNKNOWN));
});

test('evaluateDeployGate: 테스트 수가 줄면 막는다', () => {
  // 실패하는 테스트를 지워서 초록을 만드는 것은 가장 그럴듯한 실패 방식이다.
  const r = evaluateDeployGate(ok({
    tests: { passed: 780, failed: 0, total: 780 },
    baselineTests: { passed: 800, failed: 0, total: 800 },
  }));
  assert.equal(r.pass, false);
  const b = r.blockers.find((x) => x.code === BLOCKER.TESTS_REMOVED);
  assert.ok(b);
  assert.match(b.message, /20/, '몇 개가 사라졌는지 남긴다');
});

test('evaluateDeployGate: 테스트가 늘어나는 것은 막지 않는다', () => {
  const r = evaluateDeployGate(ok({
    tests: { passed: 820, failed: 0, total: 820 },
    baselineTests: { passed: 800, failed: 0, total: 800 },
  }));
  assert.equal(r.pass, true);
});

test('evaluateDeployGate: 열린 포지션이 있으면 막는다', () => {
  // 매매 중 코드를 교체하면 그 거래가 어느 버전 것인지 알 수 없어진다.
  const r = evaluateDeployGate(ok({ openPosition: true }));
  assert.equal(r.pass, false);
  assert.ok(r.blockers.some((b) => b.code === BLOCKER.POSITION_OPEN));
});

test('evaluateDeployGate: 실거래 모드면 경고하되 막지는 않는다', () => {
  // 막아버리면 실거래 중에는 영원히 개선할 수 없다. 사람이 알고 결정하게 한다.
  const r = evaluateDeployGate(ok({ mode: 'live' }));
  assert.equal(r.pass, true);
  assert.ok(r.warnings.some((w) => /실거래/.test(w)));
});

test('evaluateDeployGate: 여러 차단 사유를 모두 돌려준다', () => {
  const r = evaluateDeployGate(ok({
    tests: { passed: 700, failed: 5, total: 705 },
    baselineTests: { passed: 800, failed: 0, total: 800 },
    openPosition: true,
  }));
  assert.ok(r.blockers.length >= 3, `받은 차단 ${r.blockers.length}건`);
});

test('evaluateDeployGate: 차단 사유마다 사람이 읽을 메시지가 붙는다', () => {
  const r = evaluateDeployGate(ok({ tests: { passed: 1, failed: 1, total: 2 } }));
  for (const b of r.blockers) {
    assert.ok(b.code && b.message && b.message.length > 5, JSON.stringify(b));
  }
});

test('evaluateDeployGate: 판정 이유를 항상 남긴다', () => {
  assert.ok(evaluateDeployGate(ok()).reason.length > 5);
  assert.ok(evaluateDeployGate(ok({ openPosition: true })).reason.length > 5);
});

test('evaluateDeployGate: 기준 테스트 수가 없으면 감소 검사를 건너뛰되 경고한다', () => {
  // 첫 배포에는 비교 대상이 없다. 그렇다고 조용히 넘어가면 안 된다.
  const r = evaluateDeployGate(ok({ baselineTests: null }));
  assert.equal(r.pass, true);
  assert.ok(r.warnings.some((w) => /기준/.test(w)));
});
