const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  renderFallback, buildReviewRequest, writeReview, listReviews, readReview,
  summarizeDay, proposeCalibration, MODEL,
} = require('../src/review-writer');

// 복기문 생성. **폴백이 먼저인 것이 이 모듈의 요점이다.**
// API 키가 없거나 호출이 실패하는 날에도 복기는 남아야 한다. 복기가 "가끔 비는 기록"이
// 되면 누적 표본이 끊겨 보정 판단 자체가 불가능해진다.

const tmpdir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'rv-'));

const trade = (o) => ({
  at: 1000, symbol: 'X', grade: 'S', entryPrice: 100, exitPrice: 105,
  returnBps: 492, pnlKrw: 100, outcome: 'take_profit', holdSec: 120,
  takeProfitBps: 500, stopLossBps: 200, ...o,
});
const dayOf = (o = {}) => summarizeDay({ date: '2026-08-22', trades: [], events: [], postExits: {}, ...o });

test('MODEL은 최신 모델을 가리킨다', () => {
  assert.equal(MODEL, 'claude-opus-5');
});

// ---- 폴백 렌더링 ----

test('renderFallback: 매매가 없는 날에도 복기문이 나온다', () => {
  const s = dayOf();
  const doc = renderFallback({ summary: s, calibration: proposeCalibration([s]) });
  assert.match(doc, /2026-08-22 복기/);
  assert.match(doc, /매매 없음/);
});

test('renderFallback: 실적과 등급별 표를 담는다', () => {
  const s = dayOf({ trades: [trade({ grade: 'S' }), trade({ grade: 'A', returnBps: -208, pnlKrw: -40 })] });
  const doc = renderFallback({ summary: s, calibration: proposeCalibration([s]) });
  assert.match(doc, /거래 2건/);
  assert.match(doc, /\| S \|/);
  assert.match(doc, /\| A \|/);
});

test('renderFallback: 되짚을 거래에 판정 근거가 함께 나온다', () => {
  const s = dayOf({
    trades: [trade({ symbol: 'ZZ', at: 5, outcome: 'stop_loss', exitPrice: 98, returnBps: -208 })],
    postExits: { 'ZZ@5': { highest: 112, lowest: 97 } },
  });
  const doc = renderFallback({ summary: s, calibration: proposeCalibration([s]) });
  assert.match(doc, /손절이 좁았음/);
  assert.match(doc, /진입가를 회복/, '왜 그렇게 판정했는지가 문서에 남아야 한다');
});

test('renderFallback: 매매하지 않은 사유를 남긴다', () => {
  // 왜 안 샀는지가 왜 샀는지만큼 중요하다.
  const s = dayOf({
    events: [
      { grade: 'S', traded: false, reason: '거래 가능한 티커를 찾지 못함' },
      { grade: 'S', traded: false, reason: '거래 가능한 티커를 찾지 못함' },
    ],
  });
  const doc = renderFallback({ summary: s, calibration: proposeCalibration([s]) });
  assert.match(doc, /매매하지 않은 사유/);
  assert.match(doc, /2건 · 거래 가능한 티커를 찾지 못함/);
});

test('renderFallback: 표본 경고를 반드시 싣는다', () => {
  const s = dayOf({ trades: [trade()] });
  const doc = renderFallback({ summary: s, calibration: proposeCalibration([s]) });
  assert.match(doc, /표본/);
});

test('renderFallback: 보정 제안에 자동 적용되지 않는다는 문구가 붙는다', () => {
  const days = [];
  for (let d = 0; d < 12; d += 1) {
    days.push(summarizeDay({
      date: `2026-08-${10 + d}`,
      trades: Array.from({ length: 3 }, (_, i) => trade({ symbol: `S${d}${i}`, at: d * 100 + i })),
      events: [],
      postExits: Object.fromEntries(
        Array.from({ length: 3 }, (_, i) => [`S${d}${i}@${d * 100 + i}`, { highest: 140, lowest: 100 }])),
    }));
  }
  const cal = proposeCalibration(days);
  assert.equal(cal.action, 'suggest');
  const doc = renderFallback({ summary: days[days.length - 1], calibration: cal });
  assert.match(doc, /자동 적용되지 않습니다/, '사람이 확인한다는 것이 문서에 있어야 한다');
});

// ---- 에이전트 요청 ----

test('buildReviewRequest: 집계 수치를 담고 표본 이력을 경고한다', () => {
  const s = dayOf({ trades: [trade()] });
  const r = buildReviewRequest({ summary: s, calibration: proposeCalibration([s]) });
  assert.equal(r.model, 'claude-opus-5');
  assert.match(r.system, /455일/, '짧은 표본에서 확신한 이력을 프롬프트가 알아야 한다');
  assert.match(r.system, /표본/);
  assert.match(JSON.stringify(r.messages), /2026-08-22/);
});

test('buildReviewRequest: 최근 며칠 추이를 함께 넘긴다', () => {
  const s = dayOf({ trades: [trade()] });
  const prev = summarizeDay({ date: '2026-08-21', trades: [trade()], events: [], postExits: {} });
  const r = buildReviewRequest({ summary: s, calibration: proposeCalibration([s]), recentDays: [prev] });
  assert.match(JSON.stringify(r.messages), /2026-08-21/);
});

test('buildReviewRequest: 비밀이 요청에 실리지 않는다', () => {
  const s = dayOf({ trades: [trade()] });
  const j = JSON.stringify(buildReviewRequest({ summary: s, calibration: proposeCalibration([s]) }));
  assert.equal(j.includes('api_key'), false);
  assert.equal(j.includes('sk-'), false);
  assert.equal(j.includes('bot'), false);
});

// ---- 파일로 쌓기 ----

test('writeReview: 날짜별 파일로 저장하고 다시 읽을 수 있다', () => {
  const dir = tmpdir();
  const s = dayOf({ trades: [trade()] });
  const file = writeReview({ date: '2026-08-22', summary: s, calibration: proposeCalibration([s]), dir });
  assert.ok(fs.existsSync(file));
  assert.match(readReview('2026-08-22', dir), /2026-08-22 복기/);
});

test('writeReview: 서술이 없으면 그 사실을 문서에 남긴다', () => {
  // 나중에 읽는 사람이 "분석이 왜 없지"를 의심하지 않아야 한다.
  const dir = tmpdir();
  const s = dayOf();
  writeReview({ date: '2026-08-22', summary: s, calibration: proposeCalibration([s]), dir });
  assert.match(readReview('2026-08-22', dir), /서술형 분석 없음/);
});

test('writeReview: 서술이 있으면 폴백 아래에 얹는다', () => {
  const dir = tmpdir();
  const s = dayOf();
  writeReview({
    date: '2026-08-22', summary: s, calibration: proposeCalibration([s]),
    narrative: '재료가 없었던 날입니다.', dir,
  });
  const doc = readReview('2026-08-22', dir);
  assert.match(doc, /원인 분석과 보정 제안/);
  assert.match(doc, /재료가 없었던 날입니다/);
  assert.ok(doc.indexOf('# 2026-08-22 복기') < doc.indexOf('재료가 없었던 날입니다'), '수치가 먼저 온다');
});

test('listReviews: 최신순으로 날짜를 돌려준다', () => {
  const dir = tmpdir();
  for (const d of ['2026-08-20', '2026-08-22', '2026-08-21']) {
    const s = dayOf({ trades: [] });
    writeReview({ date: d, summary: { ...s, date: d }, calibration: proposeCalibration([]), dir });
  }
  assert.deepEqual(listReviews(dir), ['2026-08-22', '2026-08-21', '2026-08-20']);
});

test('listReviews: 폴더가 없어도 안전하다', () => {
  assert.deepEqual(listReviews(path.join(os.tmpdir(), 'nope-' + Date.now())), []);
});

test('listReviews: 날짜 형식이 아닌 파일은 무시한다', () => {
  const dir = tmpdir();
  fs.writeFileSync(path.join(dir, 'README.md'), 'x');
  fs.writeFileSync(path.join(dir, '.DS_Store'), 'x');
  const s = dayOf();
  writeReview({ date: '2026-08-22', summary: s, calibration: proposeCalibration([]), dir });
  assert.deepEqual(listReviews(dir), ['2026-08-22']);
});

test('readReview: 없는 날짜는 null', () => {
  assert.equal(readReview('1999-01-01', tmpdir()), null);
});
