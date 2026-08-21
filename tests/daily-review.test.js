const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  gradeTradeOutcome,
  summarizeDay,
  proposeCalibration,
  MIN_TRADES_FOR_CALIBRATION,
} = require('../src/daily-review');

// 일일 복기 — 유목민식 매매의 "재료 분별이 맞았는가"를 사후에 검증한다.
//
// **핵심 착상: 청산으로 이야기가 끝나지 않는다.**
// 손절로 나왔는데 그 뒤 반등했다면 손절이 좁았던 것이고, 익절로 나왔는데 그 뒤 더 갔다면
// 익절이 빨랐던 것이다. 청산 시점의 손익만 보면 이 둘을 구별할 수 없다 —
// 그래서 청산 후에도 가격을 계속 추적한 기록(postExit)이 판정의 재료가 된다.
//
// **가장 위험한 실패는 하루치 표본으로 파라미터를 바꾸는 것이다.**
// 이 프로젝트는 68~114일 표본의 우위가 455일에서 사라진 이력이 있다. 하루는 거래가
// 0~3건이다. 그걸로 익절폭을 조정하면 다음 날 반대로 흔들린다.

const trade = (o) => ({
  at: 1000, symbol: 'X', grade: 'S', entryPrice: 100,
  exitPrice: 105, returnBps: 492, pnlKrw: 100,
  outcome: 'take_profit', holdSec: 120,
  takeProfitBps: 500, stopLossBps: 200,
  ...o,
});

// ---- 한 거래의 사후 평가 ----

test('gradeTradeOutcome: 익절 후 더 크게 갔으면 익절이 좁았다고 본다', () => {
  const r = gradeTradeOutcome({
    trade: trade({ outcome: 'take_profit', exitPrice: 105 }),
    postExit: { highest: 130, lowest: 104 },
  });
  assert.equal(r.verdict, 'tp_too_tight');
  assert.ok(r.missedBps > 0, '놓친 상승폭을 수치로 남긴다');
});

test('gradeTradeOutcome: 익절 후 거의 안 갔으면 좋은 청산이다', () => {
  const r = gradeTradeOutcome({
    trade: trade({ outcome: 'take_profit', exitPrice: 105 }),
    postExit: { highest: 105.5, lowest: 98 },
  });
  assert.equal(r.verdict, 'good_exit');
});

test('gradeTradeOutcome: 손절 후 진입가를 회복했으면 손절이 좁았다고 본다', () => {
  const r = gradeTradeOutcome({
    trade: trade({ outcome: 'stop_loss', exitPrice: 98, returnBps: -208 }),
    postExit: { highest: 103, lowest: 97 },
  });
  assert.equal(r.verdict, 'sl_too_tight');
});

test('gradeTradeOutcome: 손절 후 계속 빠졌으면 손절이 옳았다', () => {
  const r = gradeTradeOutcome({
    trade: trade({ outcome: 'stop_loss', exitPrice: 98, returnBps: -208 }),
    postExit: { highest: 98.5, lowest: 88 },
  });
  assert.equal(r.verdict, 'sl_correct');
  assert.ok(r.detail.includes('88') || /추가/.test(r.detail), '얼마나 더 빠졌는지 남긴다');
});

test('gradeTradeOutcome: 시간초과 후 익절선에 닿았으면 보유가 짧았다', () => {
  const r = gradeTradeOutcome({
    trade: trade({ outcome: 'timeout', exitPrice: 102, returnBps: 192 }),
    postExit: { highest: 106, lowest: 101 },
  });
  assert.equal(r.verdict, 'hold_too_short');
});

test('gradeTradeOutcome: 시간초과 후 익절선에 못 닿았으면 좋은 청산이다', () => {
  const r = gradeTradeOutcome({
    trade: trade({ outcome: 'timeout', exitPrice: 102 }),
    postExit: { highest: 103, lowest: 99 },
  });
  assert.equal(r.verdict, 'good_exit');
});

test('gradeTradeOutcome: 사후 데이터가 없으면 판정하지 않는다', () => {
  // 없는 데이터로 추측하면 복기문이 근거 없는 조언을 하게 된다.
  const r = gradeTradeOutcome({ trade: trade(), postExit: null });
  assert.equal(r.verdict, 'unknown');
  assert.equal(r.missedBps, null);
});

test('gradeTradeOutcome: 사후 최고가가 유효하지 않으면 판정하지 않는다', () => {
  assert.equal(gradeTradeOutcome({ trade: trade(), postExit: { highest: 0 } }).verdict, 'unknown');
  assert.equal(gradeTradeOutcome({ trade: trade(), postExit: { highest: null } }).verdict, 'unknown');
});

test('gradeTradeOutcome: 진입가가 없으면 판정하지 않는다', () => {
  const r = gradeTradeOutcome({ trade: trade({ entryPrice: null }), postExit: { highest: 130 } });
  assert.equal(r.verdict, 'unknown');
});

// ---- 하루치 집계 ----

test('summarizeDay: 거래 실적을 집계한다', () => {
  const s = summarizeDay({
    date: '2026-08-22',
    trades: [
      trade({ returnBps: 492, pnlKrw: 100, outcome: 'take_profit' }),
      trade({ returnBps: -208, pnlKrw: -40, outcome: 'stop_loss' }),
    ],
    events: [],
    postExits: {},
  });
  assert.equal(s.tradeCount, 2);
  assert.equal(s.wins, 1);
  assert.equal(s.losses, 1);
  assert.ok(Math.abs(s.netBps - 284) < 1e-9);
  assert.ok(Math.abs(s.netKrw - 60) < 1e-9);
});

test('summarizeDay: 청산 사유별로 센다', () => {
  const s = summarizeDay({
    date: '2026-08-22',
    trades: [
      trade({ outcome: 'take_profit' }), trade({ outcome: 'take_profit' }),
      trade({ outcome: 'stop_loss' }), trade({ outcome: 'timeout' }),
    ],
    events: [], postExits: {},
  });
  assert.equal(s.byOutcome.take_profit, 2);
  assert.equal(s.byOutcome.stop_loss, 1);
  assert.equal(s.byOutcome.timeout, 1);
});

test('summarizeDay: 등급별로 나눠 집계한다', () => {
  // 등급별 정확도가 재료 분별이 맞았는지의 핵심 지표다.
  const s = summarizeDay({
    date: '2026-08-22',
    trades: [
      trade({ grade: 'S', returnBps: 400 }),
      trade({ grade: 'A', returnBps: -200 }),
      trade({ grade: 'A', returnBps: 100 }),
    ],
    events: [], postExits: {},
  });
  assert.equal(s.byGrade.S.count, 1);
  assert.equal(s.byGrade.A.count, 2);
  assert.ok(Math.abs(s.byGrade.A.netBps - -100) < 1e-9);
});

test('summarizeDay: 사후 판정을 집계한다', () => {
  const s = summarizeDay({
    date: '2026-08-22',
    trades: [trade({ symbol: 'X', at: 1000, outcome: 'stop_loss', exitPrice: 98 })],
    events: [],
    postExits: { 'X@1000': { highest: 108, lowest: 97 } },
  });
  assert.equal(s.verdicts.sl_too_tight, 1);
});

test('summarizeDay: 포착했으나 매매하지 않은 재료를 사유별로 센다', () => {
  // 왜 안 샀는지가 왜 샀는지만큼 중요하다 — 기준이 지나치게 좁으면 여기 쌓인다.
  const s = summarizeDay({
    date: '2026-08-22',
    trades: [],
    events: [
      { grade: 'S', traded: false, reason: '거래 가능한 티커를 찾지 못함' },
      { grade: 'S', traded: false, reason: '거래 가능한 티커를 찾지 못함' },
      { grade: 'B', traded: false, reason: 'B급은 하한(A급) 미만' },
      { grade: null, traded: false, reason: '매매 대상 아님' },
    ],
    postExits: {},
  });
  assert.equal(s.materials.graded, 3, '등급이 매겨진 것만 센다');
  assert.equal(s.materials.skipped['거래 가능한 티커를 찾지 못함'], 2);
});

test('summarizeDay: 거래가 없어도 복기는 성립한다', () => {
  // 거래가 없는 날도 기록해야 "왜 없었는가"를 되짚을 수 있다.
  const s = summarizeDay({ date: '2026-08-22', trades: [], events: [], postExits: {} });
  assert.equal(s.tradeCount, 0);
  assert.equal(s.netBps, 0);
  assert.ok(s.sampleWarning, '표본이 없다는 사실을 명시한다');
});

test('summarizeDay: 표본이 적으면 경고를 붙인다', () => {
  const s = summarizeDay({
    date: '2026-08-22',
    trades: [trade(), trade()],
    events: [], postExits: {},
  });
  assert.ok(s.sampleWarning, '2건으로 결론을 내면 안 된다는 것을 복기문이 알아야 한다');
});

// ---- 보정 제안 ----
// 하루치로 파라미터를 바꾸지 않는다. 이 프로젝트가 반복해서 당한 실수다.

test('proposeCalibration: 누적 표본이 부족하면 아무것도 제안하지 않는다', () => {
  const days = [
    summarizeDay({ date: '2026-08-21', trades: [trade()], events: [], postExits: {} }),
    summarizeDay({ date: '2026-08-22', trades: [trade()], events: [], postExits: {} }),
  ];
  const r = proposeCalibration(days);
  assert.equal(r.action, 'hold');
  assert.equal(r.suggestions.length, 0);
  assert.match(r.reason, /표본/);
});

test('MIN_TRADES_FOR_CALIBRATION은 하루 거래량보다 훨씬 크다', () => {
  // 하루 0~3건인데 문턱이 5건이면 이틀치로 파라미터를 바꾸게 된다.
  assert.ok(MIN_TRADES_FOR_CALIBRATION >= 20, `현재 ${MIN_TRADES_FOR_CALIBRATION}`);
});

test('proposeCalibration: 익절이 반복해서 좁았으면 익절 확대를 제안한다', () => {
  const days = [];
  for (let d = 0; d < 10; d += 1) {
    days.push(summarizeDay({
      date: `2026-08-${10 + d}`,
      trades: Array.from({ length: 3 }, (_, i) => trade({ symbol: `S${d}${i}`, at: d * 100 + i, outcome: 'take_profit' })),
      events: [],
      postExits: Object.fromEntries(
        Array.from({ length: 3 }, (_, i) => [`S${d}${i}@${d * 100 + i}`, { highest: 140, lowest: 100 }])
      ),
    }));
  }
  const r = proposeCalibration(days);
  assert.equal(r.action, 'suggest');
  const tp = r.suggestions.find((s) => s.param === 'takeProfitBps');
  assert.ok(tp, '익절 확대 제안이 있어야 한다');
  assert.ok(tp.evidence, '근거 수치를 함께 남긴다');
});

test('proposeCalibration: 제안에는 항상 근거와 표본 크기가 붙는다', () => {
  const days = [];
  for (let d = 0; d < 10; d += 1) {
    days.push(summarizeDay({
      date: `2026-08-${10 + d}`,
      trades: Array.from({ length: 3 }, (_, i) => trade({ symbol: `T${d}${i}`, at: d * 100 + i, outcome: 'stop_loss', exitPrice: 98 })),
      events: [],
      postExits: Object.fromEntries(
        Array.from({ length: 3 }, (_, i) => [`T${d}${i}@${d * 100 + i}`, { highest: 112, lowest: 97 }])
      ),
    }));
  }
  const r = proposeCalibration(days);
  for (const s of r.suggestions) {
    assert.ok(s.rationale && s.rationale.length > 5, '근거 없는 제안은 검증할 수 없다');
    assert.ok(typeof s.sampleSize === 'number' && s.sampleSize > 0);
  }
});

test('proposeCalibration: 판정 불가(unknown)는 근거로 세지 않는다', () => {
  // 사후 데이터가 없는 거래를 근거에 넣으면 없는 증거로 파라미터를 바꾸게 된다.
  const days = [];
  for (let d = 0; d < 10; d += 1) {
    days.push(summarizeDay({
      date: `2026-08-${10 + d}`,
      trades: Array.from({ length: 3 }, (_, i) => trade({ symbol: `U${d}${i}`, at: d * 100 + i })),
      events: [], postExits: {},   // 사후 데이터 전무
    }));
  }
  const r = proposeCalibration(days);
  assert.equal(r.action, 'hold');
  assert.match(r.reason, /판정|사후|근거/);
});

test('proposeCalibration: 빈 입력을 안전하게 처리한다', () => {
  const r = proposeCalibration([]);
  assert.equal(r.action, 'hold');
  assert.equal(r.suggestions.length, 0);
});
