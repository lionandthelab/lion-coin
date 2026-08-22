const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  SNAPSHOT_VERSION,
  buildSnapshot,
  restoreSnapshot,
  resolveStartupMode,
} = require('../src/state-store');
const fsm = require('../src/event-engine');

// **재시작이 상태를 지우면 실거래 자동 재개는 위험해진다.**
//
// 데몬이 매번 createEventState()로 시작하면, 거래소에 포지션이 남은 채 새 재료로
// 또 진입한다. 크래시 루프가 돌면 감시받지 않는 포지션이 쌓인다. 그래서 자동
// 재개보다 상태 복원이 먼저다.
//
// 복원의 원칙은 하나다: **모르면 복원하지 않는다.** 손상된 스냅샷을 억지로
// 되살리면 어긋난 상태로 청산을 지시해 없는 수량을 팔거나 남은 수량을 놓친다.
// 못 읽으면 깨끗이 시작하되 **그 사실을 반드시 알린다.**

const T0 = 1_787_000_000_000;

const PLAN = { takeProfitBps: 300, stopLossBps: 150, maxHoldSec: 600, costBps: 8 };
const holding = () => {
  const armed = fsm.onMaterialDetected(fsm.createEventState(), {
    event: { id: 'upbit:1', title: '커브(CRV) KRW 마켓 디지털 자산 추가' },
    material: { grade: 'S', direction: 'bullish', tickers: ['CRV'] },
    plan: PLAN, now: T0,
  }).state;
  return fsm.onFillConfirmed(armed, { price: 1000, quantity: 19.48, now: T0 + 500 }).state;
};

const live = (o = {}) => ({
  state: holding(), mode: 'live', seenIds: new Set(['upbit:1']),
  postExits: new Map(), trades: [], events: [], marketContextAt: T0, ...o,
});

// ---- 저장 ----

test('buildSnapshot: Set과 Map을 JSON으로 왕복할 수 있는 모양으로 바꾼다', () => {
  const snap = buildSnapshot(live({
    seenIds: new Set(['a', 'b']),
    postExits: new Map([['CRV@1', { symbol: 'CRV', until: T0, highest: null, lowest: null }]]),
  }));
  const round = JSON.parse(JSON.stringify(snap));
  assert.deepEqual(round.seenIds, ['a', 'b']);
  assert.equal(round.postExits.length, 1);
  assert.equal(snap.version, SNAPSHOT_VERSION);
});

test('buildSnapshot: 저장 시각을 남긴다', () => {
  const snap = buildSnapshot(live(), { now: T0 + 999 });
  assert.equal(snap.savedAt, T0 + 999);
});

test('buildSnapshot: seenIds에 상한을 둬 파일이 무한히 자라지 않는다', () => {
  const many = new Set(Array.from({ length: 20000 }, (_, i) => `id${i}`));
  const snap = buildSnapshot(live({ seenIds: many }), { maxSeen: 5000 });
  assert.equal(snap.seenIds.length, 5000);
  // 최근 것을 남긴다 — 오래된 id는 나이 필터가 어차피 거른다.
  assert.equal(snap.seenIds[snap.seenIds.length - 1], 'id19999');
});

// ---- 복원 ----

test('restoreSnapshot: 저장한 것을 그대로 되살린다', () => {
  const snap = JSON.parse(JSON.stringify(buildSnapshot(live())));
  const r = restoreSnapshot(snap, { now: T0 + 1000 });
  assert.equal(r.ok, true);
  assert.equal(r.state.status, 'HOLDING');
  assert.equal(r.state.entryPrice, 1000);
  assert.equal(r.state.quantity, 19.48);
  assert.ok(r.seenIds instanceof Set);
  assert.equal(r.seenIds.has('upbit:1'), true);
  assert.ok(r.postExits instanceof Map);
  assert.equal(r.mode, 'live');
});

test('restoreSnapshot: 없는 스냅샷은 조용히 깨끗한 시작이다', () => {
  for (const v of [null, undefined]) {
    const r = restoreSnapshot(v);
    assert.equal(r.ok, false);
    assert.equal(r.state, null);
    assert.equal(r.warning, null, '없는 것은 손상된 것과 다르다');
  }
});

test('restoreSnapshot: 손상된 스냅샷은 복원하지 않고 알린다', () => {
  // 억지로 되살리면 어긋난 상태로 청산을 지시해 없는 수량을 팔게 된다.
  for (const bad of ['nope', 42, [], {}, { version: SNAPSHOT_VERSION }]) {
    const r = restoreSnapshot(bad);
    assert.equal(r.ok, false, JSON.stringify(bad));
    assert.equal(typeof r.warning, 'string', JSON.stringify(bad));
  }
});

test('restoreSnapshot: 형식 판이 다르면 복원하지 않는다', () => {
  // 필드 모양이 바뀌었는데 옛 스냅샷을 밀어 넣으면 조용히 어긋난 상태가 된다.
  const snap = JSON.parse(JSON.stringify(buildSnapshot(live())));
  const r = restoreSnapshot({ ...snap, version: SNAPSHOT_VERSION + 1 });
  assert.equal(r.ok, false);
  assert.match(r.warning, /형식|판|version/i);
});

test('restoreSnapshot: 포지션 없는 스냅샷도 정상 복원한다', () => {
  const r = restoreSnapshot(JSON.parse(JSON.stringify(buildSnapshot(live({
    state: fsm.createEventState(), mode: 'watching',
  })))), { now: T0 });
  assert.equal(r.ok, true);
  assert.equal(r.state.status, 'IDLE');
  assert.equal(r.position, null);
});

test('restoreSnapshot: 포지션이 있으면 그 사실을 알린다', () => {
  const r = restoreSnapshot(JSON.parse(JSON.stringify(buildSnapshot(live()))), { now: T0 + 60_000 });
  assert.ok(r.position, '복원된 포지션을 호출자가 알아야 알림을 낼 수 있다');
  assert.equal(r.position.symbol, 'CRV');
  assert.equal(r.position.quantity, 19.48);
  assert.match(r.notice, /CRV/);
});

test('restoreSnapshot: 상태 모양이 상태기계와 맞지 않으면 거부한다', () => {
  const snap = JSON.parse(JSON.stringify(buildSnapshot(live())));
  // HOLDING인데 진입가가 없다 — 이 상태로는 청산선을 그을 수 없다.
  const broken = { ...snap, state: { ...snap.state, entryPrice: null } };
  const r = restoreSnapshot(broken);
  assert.equal(r.ok, false);
  assert.match(r.warning, /진입가|포지션|상태/);
});

test('restoreSnapshot: 너무 오래된 스냅샷은 포지션을 되살리지 않는다', () => {
  // 사흘 전 기록으로 청산을 지시하면 그동안 무슨 일이 있었는지 모르는 채 판다.
  const snap = JSON.parse(JSON.stringify(buildSnapshot(live(), { now: T0 })));
  const r = restoreSnapshot(snap, { now: T0 + 3 * 24 * 3600_000 });
  assert.equal(r.ok, false);
  assert.match(r.warning, /오래|경과|시간/);
});

test('restoreSnapshot: 복원한 상태는 그대로 다음 틱을 받을 수 있다', () => {
  // 되살렸다고 말만 하고 상태기계가 안 받으면 아무것도 복원하지 않은 것과 같다.
  const r = restoreSnapshot(JSON.parse(JSON.stringify(buildSnapshot(live()))), { now: T0 + 1000 });
  const tick = fsm.onPriceTick(r.state, { price: 900, now: T0 + 2000 });
  assert.equal(tick.action.type, 'exit');
  assert.equal(tick.action.reason, 'stop_loss');
  assert.equal(tick.action.quantity, 19.48);
});

// ---- 모드 복원 ----

test('resolveStartupMode: 저장된 모드가 없으면 멈춘 상태로 시작한다', () => {
  assert.equal(resolveStartupMode({ saved: null, liveApproved: true, hasKeys: true }).mode, 'stopped');
});

test('resolveStartupMode: 감시 모드는 그대로 되살린다', () => {
  const r = resolveStartupMode({ saved: 'watching', liveApproved: false, hasKeys: false });
  assert.equal(r.mode, 'watching');
});

test('resolveStartupMode: 실거래는 승인과 키가 그대로 있으면 되살린다', () => {
  // 재시작이 사람이 이미 켠 승인을 꺼버리지 않게 한다.
  const r = resolveStartupMode({ saved: 'live', liveApproved: true, hasKeys: true });
  assert.equal(r.mode, 'live');
  assert.match(r.notice, /실거래/);
});

test('resolveStartupMode: 승인이 내려갔으면 실거래로 돌아가지 않는다', () => {
  // .env에서 BITHUMB_LIVE를 내린 것은 명시적인 의사표시다. 저장된 값이 그걸 이긴다면
  // 그 스위치는 아무 의미가 없다.
  const r = resolveStartupMode({ saved: 'live', liveApproved: false, hasKeys: true });
  assert.equal(r.mode, 'watching', '멈추지는 않되 실거래로는 가지 않는다');
  assert.match(r.warning, /승인|BITHUMB_LIVE/);
});

test('resolveStartupMode: 키가 없으면 실거래로 돌아가지 않는다', () => {
  const r = resolveStartupMode({ saved: 'live', liveApproved: true, hasKeys: false });
  assert.equal(r.mode, 'watching');
  assert.match(r.warning, /키/);
});

test('resolveStartupMode: 모르는 값은 멈춘 상태로 떨어뜨린다', () => {
  for (const bad of ['LIVE', 'trading', 42, {}, '']) {
    assert.equal(resolveStartupMode({ saved: bad, liveApproved: true, hasKeys: true }).mode, 'stopped', String(bad));
  }
});
