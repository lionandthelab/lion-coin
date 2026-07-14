const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  pickNextTask,
  evaluateGoal,
  parseLnbitsWallet,
  logFileName,
} = require('../harness/lib/core');

// ---- pickNextTask ----

function makeState(tasks) {
  return { tasks };
}

test('pickNextTask: 의존성이 충족된 첫 pending 작업을 고른다', () => {
  const state = makeState([
    { id: 'A1', status: 'done', requires_human: false, depends_on: [] },
    { id: 'A2', status: 'pending', requires_human: false, depends_on: ['A1'] },
    { id: 'A3', status: 'pending', requires_human: false, depends_on: [] },
  ]);
  assert.equal(pickNextTask(state).task.id, 'A2');
});

test('pickNextTask: in_progress 작업이 있으면 최우선으로 이어서 한다', () => {
  const state = makeState([
    { id: 'A1', status: 'pending', requires_human: false, depends_on: [] },
    { id: 'A2', status: 'in_progress', requires_human: false, depends_on: [] },
  ]);
  assert.equal(pickNextTask(state).task.id, 'A2');
});

test('pickNextTask: 의존성이 미완료인 작업은 건너뛴다', () => {
  const state = makeState([
    { id: 'A5', status: 'pending', requires_human: false, depends_on: ['A3'] },
    { id: 'A3', status: 'pending', requires_human: true, depends_on: [] },
    { id: 'C1', status: 'pending', requires_human: false, depends_on: [] },
  ]);
  assert.equal(pickNextTask(state).task.id, 'C1');
});

test('pickNextTask: 사람 전용(requires_human) 작업은 에이전트 작업으로 선택하지 않는다', () => {
  const state = makeState([
    { id: 'B1', status: 'pending', requires_human: true, depends_on: [] },
    { id: 'C1', status: 'pending', requires_human: false, depends_on: [] },
  ]);
  assert.equal(pickNextTask(state).task.id, 'C1');
});

test('pickNextTask: 남은 것이 사람 작업뿐이면 task=null, humanActions에 나열', () => {
  const state = makeState([
    { id: 'A1', status: 'done', requires_human: false, depends_on: [] },
    { id: 'B1', status: 'pending', requires_human: true, depends_on: [] },
    { id: 'B2', status: 'pending', requires_human: true, depends_on: ['B1'] },
  ]);
  const { task, humanActions } = pickNextTask(state);
  assert.equal(task, null);
  // B2는 B1 미완료라 아직 실행 불가 — 지금 가능한 사람 작업은 B1뿐
  assert.deepEqual(humanActions.map((t) => t.id), ['B1']);
});

test('pickNextTask: 모든 작업 완료 시 task=null, humanActions=[]', () => {
  const state = makeState([
    { id: 'A1', status: 'done', requires_human: false, depends_on: [] },
    { id: 'B1', status: 'done', requires_human: true, depends_on: [] },
  ]);
  const { task, humanActions } = pickNextTask(state);
  assert.equal(task, null);
  assert.deepEqual(humanActions, []);
});

// ---- evaluateGoal ----

const baseGoal = { target_sats: 600, baseline_sats: 0 };

test('evaluateGoal: 잔액 미조회(null)면 configured=false, achieved=false', () => {
  const r = evaluateGoal(baseGoal, null);
  assert.equal(r.configured, false);
  assert.equal(r.achieved, false);
});

test('evaluateGoal: 목표 미달이면 achieved=false, 남은 sats 계산', () => {
  const r = evaluateGoal(baseGoal, 250);
  assert.equal(r.configured, true);
  assert.equal(r.achieved, false);
  assert.equal(r.receivedSats, 250);
  assert.equal(r.remainingSats, 350);
});

test('evaluateGoal: 목표 정확히 도달 시 achieved=true', () => {
  const r = evaluateGoal(baseGoal, 600);
  assert.equal(r.achieved, true);
  assert.equal(r.remainingSats, 0);
});

test('evaluateGoal: baseline(자가 테스트 입금분)은 수령액에서 제외', () => {
  const goal = { target_sats: 600, baseline_sats: 100 };
  const r = evaluateGoal(goal, 650);
  assert.equal(r.receivedSats, 550);
  assert.equal(r.achieved, false);
});

test('evaluateGoal: 잔액이 baseline보다 작아도 수령액은 음수가 되지 않는다', () => {
  const goal = { target_sats: 600, baseline_sats: 100 };
  const r = evaluateGoal(goal, 40);
  assert.equal(r.receivedSats, 0);
});

// ---- parseLnbitsWallet ----

test('parseLnbitsWallet: LNbits 잔액은 msat 단위이므로 sat으로 내림 변환', () => {
  assert.equal(parseLnbitsWallet({ balance: 123456 }), 123);
  assert.equal(parseLnbitsWallet({ balance: 0 }), 0);
});

test('parseLnbitsWallet: balance가 없거나 숫자가 아니면 TypeError', () => {
  assert.throws(() => parseLnbitsWallet({}), TypeError);
  assert.throws(() => parseLnbitsWallet({ balance: 'abc' }), TypeError);
  assert.throws(() => parseLnbitsWallet(null), TypeError);
});

// ---- logFileName ----

test('logFileName: Asia/Seoul 기준 날짜로 파일명을 만든다 (UTC 자정 경계 포함)', () => {
  // UTC 16:00 = KST 익일 01:00
  assert.equal(logFileName(new Date('2026-07-14T16:00:00Z')), '2026-07-15.md');
  assert.equal(logFileName(new Date('2026-07-14T02:00:00Z')), '2026-07-14.md');
});
