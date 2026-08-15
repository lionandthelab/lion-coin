const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  parseOpenInterest,
  parseRatioSeries,
  parseTakerRatio,
  mergeSeries,
} = require('../src/positioning');

// 바이낸스는 이 데이터를 최근 30일치만 준다. 그 이전 startTime은 거부된다(-1130).
// 즉 지금부터 매 회차 받아 쌓지 않으면 나중에도 과거를 만들 수 없다.
// 이어붙이기에서 중복·역행이 생기면 그대로 영구 오염되므로 병합 규칙을 먼저 못박는다.

// ---- parseOpenInterest ----

test('parseOpenInterest: 문자열 수치를 숫자로 정규화한다', () => {
  const rows = [
    { symbol: 'BTCUSDT', sumOpenInterest: '111891.37', sumOpenInterestValue: '7044163083.95', timestamp: 1000 },
  ];
  assert.deepEqual(parseOpenInterest(rows), [
    { t: 1000, openInterest: 111891.37, openInterestValue: 7044163083.95 },
  ]);
});

test('parseOpenInterest: 배열이 아니면 TypeError', () => {
  assert.throws(() => parseOpenInterest(null), TypeError);
  assert.throws(() => parseOpenInterest({}), TypeError);
});

test('parseOpenInterest: 수치가 해석되지 않으면 TypeError', () => {
  assert.throws(
    () => parseOpenInterest([{ sumOpenInterest: 'x', sumOpenInterestValue: '1', timestamp: 1 }]),
    TypeError
  );
});

// ---- parseRatioSeries ----

test('parseRatioSeries: 롱/숏 계좌 비율을 정규화한다', () => {
  const rows = [
    { symbol: 'BTCUSDT', longAccount: '0.5963', longShortRatio: '1.4768', shortAccount: '0.4037', timestamp: 2000 },
  ];
  assert.deepEqual(parseRatioSeries(rows), [
    { t: 2000, longShortRatio: 1.4768, longAccount: 0.5963, shortAccount: 0.4037 },
  ]);
});

test('parseRatioSeries: 비율이 0 이하면 TypeError (비율은 양수)', () => {
  assert.throws(
    () => parseRatioSeries([{ longAccount: '0.5', longShortRatio: '0', shortAccount: '0.5', timestamp: 1 }]),
    TypeError
  );
});

// ---- parseTakerRatio ----

test('parseTakerRatio: 테이커 매수/매도 물량 비율을 정규화한다', () => {
  const rows = [{ buySellRatio: '0.1464', sellVol: '82.897', buyVol: '12.137', timestamp: 3000 }];
  assert.deepEqual(parseTakerRatio(rows), [
    { t: 3000, buySellRatio: 0.1464, buyVol: 12.137, sellVol: 82.897 },
  ]);
});

test('parseTakerRatio: 물량 0은 정상값이다 (거래가 없던 구간)', () => {
  const out = parseTakerRatio([{ buySellRatio: '1', sellVol: '0', buyVol: '0', timestamp: 1 }]);
  assert.equal(out[0].buyVol, 0);
});

// ---- mergeSeries ----

test('mergeSeries: 새 관측만 덧붙이고 시간순을 유지한다', () => {
  const out = mergeSeries([{ t: 1 }, { t: 2 }], [{ t: 3 }, { t: 4 }]);
  assert.deepEqual(out.map((x) => x.t), [1, 2, 3, 4]);
});

test('mergeSeries: 같은 타임스탬프는 새 값으로 덮어쓴다 (재수집 대비)', () => {
  const out = mergeSeries([{ t: 1, v: 'old' }, { t: 2, v: 'old' }], [{ t: 2, v: 'new' }]);
  assert.equal(out.length, 2);
  assert.equal(out.find((x) => x.t === 2).v, 'new');
});

test('mergeSeries: 순서가 뒤섞여 들어와도 시간순으로 정렬한다', () => {
  const out = mergeSeries([{ t: 5 }], [{ t: 2 }, { t: 9 }, { t: 1 }]);
  assert.deepEqual(out.map((x) => x.t), [1, 2, 5, 9]);
});

test('mergeSeries: maxLen을 넘으면 오래된 것부터 버린다', () => {
  const out = mergeSeries([{ t: 1 }, { t: 2 }, { t: 3 }], [{ t: 4 }], 3);
  assert.deepEqual(out.map((x) => x.t), [2, 3, 4]);
});

test('mergeSeries: 빈 기존 이력에도 붙는다', () => {
  assert.deepEqual(mergeSeries([], [{ t: 1 }]).map((x) => x.t), [1]);
});

test('mergeSeries: 들어온 값이 없으면 기존을 그대로 돌려준다', () => {
  const existing = [{ t: 1 }];
  assert.deepEqual(mergeSeries(existing, []), existing);
});

test('mergeSeries: 배열이 아니면 TypeError', () => {
  assert.throws(() => mergeSeries(null, []), TypeError);
  assert.throws(() => mergeSeries([], null), TypeError);
});
