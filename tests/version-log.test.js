const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  createVersionLog,
  recordDeploy,
  attachTrade,
  versionStats,
  shouldRollback,
  MIN_TRADES_FOR_ROLLBACK,
} = require('../src/version-log');

// 버전별 실적 추적과 롤백 판정.
//
// **왜 필요한가:** 복기가 코드 개선을 만들고 그게 배포되면, 그 뒤의 거래가 좋아졌는지
// 나빠졌는지 알아야 한다. 버전 태깅 없이는 "요즘 성적이 나쁘다"까지만 알고
// **무엇을 되돌려야 하는지**는 모른다.
//
// **롤백 판정에도 같은 표본 규율이 적용된다.** 이 프로젝트는 짧은 표본의 우위를 믿었다가
// 두 번 정정한 이력이 있다. 배포 직후 3건 졌다고 되돌리면 잡음을 쫓는 것이고,
// 그 되돌림 자체가 또 다른 변경이라 원인 추적이 더 어려워진다.

const dep = (v, o = {}) => ({ version: v, commit: `c${v}`, at: 1000, summary: `버전 ${v}`, ...o });
const trd = (bps, o = {}) => ({ at: 2000, symbol: 'X', returnBps: bps, pnlKrw: bps / 10, ...o });

test('createVersionLog: 빈 로그를 만든다', () => {
  const l = createVersionLog();
  assert.deepEqual(l.deploys, []);
  assert.equal(l.current, null);
});

// ---- 배포 기록 ----

test('recordDeploy: 배포를 기록하고 현재 버전을 갱신한다', () => {
  let l = createVersionLog();
  l = recordDeploy(l, dep('v1'));
  assert.equal(l.current, 'v1');
  assert.equal(l.deploys.length, 1);
  l = recordDeploy(l, dep('v2'));
  assert.equal(l.current, 'v2');
});

test('recordDeploy: 원본을 변경하지 않는다', () => {
  const l = createVersionLog();
  const next = recordDeploy(l, dep('v1'));
  assert.equal(l.deploys.length, 0, '상태를 제자리에서 바꾸면 이력 추적이 무의미해진다');
  assert.notEqual(l, next);
});

test('recordDeploy: 커밋 해시가 없으면 거부한다', () => {
  // 커밋 없이는 되돌릴 대상을 특정할 수 없다.
  assert.throws(() => recordDeploy(createVersionLog(), { version: 'v1' }), /커밋/);
});

test('recordDeploy: 같은 버전을 두 번 기록하지 않는다', () => {
  let l = recordDeploy(createVersionLog(), dep('v1'));
  assert.throws(() => recordDeploy(l, dep('v1')), /이미/);
});

// ---- 거래를 버전에 붙이기 ----

test('attachTrade: 현재 버전에 거래를 붙인다', () => {
  let l = recordDeploy(createVersionLog(), dep('v1'));
  l = attachTrade(l, trd(100));
  assert.equal(versionStats(l, 'v1').trades, 1);
});

test('attachTrade: 배포 기록이 없으면 거래를 버린다', () => {
  // 어느 버전 것인지 모르는 거래를 아무 버전에 붙이면 롤백 판단이 오염된다.
  const l = attachTrade(createVersionLog(), trd(100));
  assert.equal(l.orphanTrades.length, 1);
});

test('attachTrade: 배포 이후 거래는 새 버전으로 간다', () => {
  let l = recordDeploy(createVersionLog(), dep('v1'));
  l = attachTrade(l, trd(100));
  l = recordDeploy(l, dep('v2'));
  l = attachTrade(l, trd(-50));
  assert.equal(versionStats(l, 'v1').trades, 1);
  assert.equal(versionStats(l, 'v2').trades, 1);
});

// ---- 버전별 실적 ----

test('versionStats: 거래·승률·순손익을 낸다', () => {
  let l = recordDeploy(createVersionLog(), dep('v1'));
  l = attachTrade(l, trd(200));
  l = attachTrade(l, trd(-100));
  l = attachTrade(l, trd(50));
  const s = versionStats(l, 'v1');
  assert.equal(s.trades, 3);
  assert.equal(s.wins, 2);
  assert.ok(Math.abs(s.netBps - 150) < 1e-9);
  assert.ok(Math.abs(s.avgBps - 50) < 1e-9);
});

test('versionStats: 거래가 없으면 지표를 0으로 위장하지 않는다', () => {
  const l = recordDeploy(createVersionLog(), dep('v1'));
  const s = versionStats(l, 'v1');
  assert.equal(s.trades, 0);
  assert.equal(s.avgBps, null);
});

test('versionStats: 모르는 버전은 null', () => {
  assert.equal(versionStats(createVersionLog(), 'nope'), null);
});

// ---- 롤백 판정 ----

test('MIN_TRADES_FOR_ROLLBACK는 하루 거래량보다 훨씬 크다', () => {
  assert.ok(MIN_TRADES_FOR_ROLLBACK >= 20, `현재 ${MIN_TRADES_FOR_ROLLBACK}`);
});

test('shouldRollback: 표본이 적으면 되돌리지 않는다', () => {
  let l = recordDeploy(createVersionLog(), dep('v1'));
  for (let i = 0; i < 40; i += 1) l = attachTrade(l, trd(100));
  l = recordDeploy(l, dep('v2'));
  for (let i = 0; i < 3; i += 1) l = attachTrade(l, trd(-500));  // 크게 지고 있지만 3건뿐
  const r = shouldRollback(l);
  assert.equal(r.rollback, false);
  assert.match(r.reason, /표본/);
});

test('shouldRollback: 이전 버전보다 유의하게 나쁘면 되돌리기를 권고한다', () => {
  let l = recordDeploy(createVersionLog(), dep('v1'));
  for (let i = 0; i < 40; i += 1) l = attachTrade(l, trd(120));
  l = recordDeploy(l, dep('v2'));
  for (let i = 0; i < 40; i += 1) l = attachTrade(l, trd(-180));
  const r = shouldRollback(l);
  assert.equal(r.rollback, true);
  assert.equal(r.target, 'v1', '되돌릴 대상을 명시한다');
  assert.ok(r.evidence, '근거 수치를 남긴다');
});

test('shouldRollback: 비슷하거나 나아졌으면 되돌리지 않는다', () => {
  let l = recordDeploy(createVersionLog(), dep('v1'));
  for (let i = 0; i < 40; i += 1) l = attachTrade(l, trd(100));
  l = recordDeploy(l, dep('v2'));
  for (let i = 0; i < 40; i += 1) l = attachTrade(l, trd(140));
  assert.equal(shouldRollback(l).rollback, false);
});

test('shouldRollback: 이전 버전 표본도 충분해야 비교한다', () => {
  // 비교 대상이 부실하면 "나빠졌다"는 판단 자체가 근거 없다.
  let l = recordDeploy(createVersionLog(), dep('v1'));
  for (let i = 0; i < 3; i += 1) l = attachTrade(l, trd(500));
  l = recordDeploy(l, dep('v2'));
  for (let i = 0; i < 40; i += 1) l = attachTrade(l, trd(-100));
  const r = shouldRollback(l);
  assert.equal(r.rollback, false);
  assert.match(r.reason, /이전|비교/);
});

test('shouldRollback: 배포가 하나뿐이면 되돌릴 곳이 없다', () => {
  let l = recordDeploy(createVersionLog(), dep('v1'));
  for (let i = 0; i < 40; i += 1) l = attachTrade(l, trd(-200));
  const r = shouldRollback(l);
  assert.equal(r.rollback, false);
  assert.match(r.reason, /이전 버전/);
});

test('shouldRollback: 빈 로그를 안전하게 처리한다', () => {
  const r = shouldRollback(createVersionLog());
  assert.equal(r.rollback, false);
});

test('shouldRollback: 권고에는 되돌릴 커밋이 포함된다', () => {
  let l = recordDeploy(createVersionLog(), dep('v1', { commit: 'abc1234' }));
  for (let i = 0; i < 40; i += 1) l = attachTrade(l, trd(120));
  l = recordDeploy(l, dep('v2', { commit: 'def5678' }));
  for (let i = 0; i < 40; i += 1) l = attachTrade(l, trd(-200));
  const r = shouldRollback(l);
  assert.equal(r.targetCommit, 'abc1234', '되돌릴 커밋 없이는 권고가 실행 불가능하다');
});
