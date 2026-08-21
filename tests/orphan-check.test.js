const { test } = require('node:test');
const assert = require('node:assert/strict');

const { checkStrandedPosition } = require('../src/orphan-check');

// **재시작이 포지션을 지운다.**
//
// 데몬은 매번 fsm.createEventState()로 시작한다. 거래소에는 포지션이 그대로
// 있는데 상태 기계는 IDLE이라, 익절·손절·시간초과 어느 것도 돌지 않고 화면에도
// 보이지 않는다. 배포 게이트가 POSITION_OPEN으로 *의도된* 교체는 막지만
// 크래시·재부팅·전원 차단은 막지 못한다.
//
// 상태를 자동 복원하지는 않는다. 디스크의 마지막 값이 거래소의 현재 사실과
// 일치한다는 보장이 없고, 어긋난 상태로 청산을 지시하면 없는 수량을 팔거나
// 남은 수량을 놓친다. 사람이 확인할 수 있게 **드러내는 것**까지가 이 함수 몫이다.

const pos = (o = {}) => ({
  symbol: 'CRV', grade: 'S', entryPrice: 1000, quantity: 19.48,
  notional: 19480, entryAt: 1787000000000, maxHoldSec: 600, ...o,
});

test('checkStrandedPosition: 저장된 포지션이 없으면 조용하다', () => {
  for (const v of [null, undefined]) {
    const r = checkStrandedPosition(v);
    assert.equal(r.stranded, false);
    assert.equal(r.message, null);
  }
});

test('checkStrandedPosition: 남아 있는 포지션을 찾아낸다', () => {
  const r = checkStrandedPosition(pos());
  assert.equal(r.stranded, true);
  assert.match(r.message, /CRV/);
  assert.match(r.message, /19\.48/, '사람이 손으로 청산하려면 수량이 필요하다');
  assert.match(r.message, /1,000/, '진입가도 있어야 손익을 가늠한다');
});

test('checkStrandedPosition: 자동으로 복원한다고 말하지 않는다', () => {
  // 디스크의 마지막 값이 거래소의 현재 사실이라는 보장이 없다. 어긋난 상태로
  // 청산을 지시하면 없는 수량을 팔거나 남은 수량을 놓친다.
  const r = checkStrandedPosition(pos());
  assert.match(r.message, /직접|수동|확인/, r.message);
  assert.equal(r.resume, undefined, '복원 경로를 제공하지 않는다');
});

test('checkStrandedPosition: 모의 포지션은 경고하지 않는다', () => {
  // 감시 모드의 가상 포지션은 거래소에 없다. 그것까지 깨우면 알림이 무뎌진다.
  assert.equal(checkStrandedPosition(pos({ simulated: true })).stranded, false);
});

test('checkStrandedPosition: 수량이 없으면 포지션으로 보지 않는다', () => {
  for (const q of [0, null, undefined, NaN]) {
    assert.equal(checkStrandedPosition(pos({ quantity: q })).stranded, false, String(q));
  }
});

test('checkStrandedPosition: 언제 것인지 함께 적는다', () => {
  // 방금 죽어서 다시 뜬 것과 사흘 전 기록이 남은 것은 다른 상황이다.
  const r = checkStrandedPosition(pos({ entryAt: 1787000000000 }), { now: 1787000000000 + 3 * 3600_000 });
  assert.match(r.message, /3시간/, r.message);
});

test('checkStrandedPosition: 손상된 입력에도 던지지 않는다', () => {
  // 기동 경로에서 던지면 데몬이 아예 뜨지 않는다 — 포지션이 남은 바로 그때.
  for (const bad of ['nope', 42, [], { quantity: 'x' }, { quantity: 1 }]) {
    const r = checkStrandedPosition(bad);
    assert.equal(typeof r.stranded, 'boolean', JSON.stringify(bad));
  }
});
