const { test } = require('node:test');
const assert = require('node:assert/strict');

const { parseFeeEstimates, feeForTarget } = require('../src/fees');

// ---- parseFeeEstimates ----

test('parseFeeEstimates: Esplora fee-estimates 응답을 target 오름차순 배열로 정규화한다', () => {
  const json = { '6': 65.24, '1': 87.882, '144': 1.027 };
  const r = parseFeeEstimates(json);
  assert.deepEqual(r, [
    { target: 1, satPerVb: 87.882 },
    { target: 6, satPerVb: 65.24 },
    { target: 144, satPerVb: 1.027 },
  ]);
});

test('parseFeeEstimates: 객체가 아니면 TypeError', () => {
  assert.throws(() => parseFeeEstimates([]), TypeError);
  assert.throws(() => parseFeeEstimates(null), TypeError);
  assert.throws(() => parseFeeEstimates('nope'), TypeError);
});

test('parseFeeEstimates: 빈 객체면 TypeError (사용 가능한 추정치 없음)', () => {
  assert.throws(() => parseFeeEstimates({}), TypeError);
});

test('parseFeeEstimates: target 키가 양의 정수가 아니면 TypeError', () => {
  assert.throws(() => parseFeeEstimates({ '0': 10 }), TypeError);
  assert.throws(() => parseFeeEstimates({ '-1': 10 }), TypeError);
  assert.throws(() => parseFeeEstimates({ abc: 10 }), TypeError);
});

test('parseFeeEstimates: 값이 양의 유한수가 아니면 TypeError', () => {
  assert.throws(() => parseFeeEstimates({ '1': 0 }), TypeError);
  assert.throws(() => parseFeeEstimates({ '1': -5 }), TypeError);
  assert.throws(() => parseFeeEstimates({ '1': NaN }), TypeError);
  assert.throws(() => parseFeeEstimates({ '1': 'x' }), TypeError);
});

// ---- feeForTarget ----

test('feeForTarget: 정확히 일치하는 target이 있으면 그 값을 돌려준다', () => {
  const estimates = parseFeeEstimates({ '1': 90, '6': 65, '144': 1 });
  assert.equal(feeForTarget(estimates, 6), 65);
});

test('feeForTarget: 정확히 일치하지 않으면 요청 target 이하에서 가장 큰 target을 쓴다 (확인 목표 보장)', () => {
  const estimates = parseFeeEstimates({ '1': 90, '5': 70, '10': 40 });
  // target=8 요청 시, 8 이하 중 가장 큰 5의 요율을 사용해야 8블록 내 확인이 보장됨
  assert.equal(feeForTarget(estimates, 8), 70);
});

test('feeForTarget: 가장 작은 target보다도 작은 target을 요청하면 가장 공격적인(가장 작은 target) 요율로 대체한다', () => {
  const estimates = parseFeeEstimates({ '2': 90, '6': 65 });
  assert.equal(feeForTarget(estimates, 1), 90);
});

test('feeForTarget: targetBlocks가 양의 정수가 아니면 TypeError', () => {
  const estimates = parseFeeEstimates({ '1': 90 });
  assert.throws(() => feeForTarget(estimates, 0), TypeError);
  assert.throws(() => feeForTarget(estimates, -3), TypeError);
  assert.throws(() => feeForTarget(estimates, 1.5), TypeError);
  assert.throws(() => feeForTarget(estimates, 'x'), TypeError);
});

test('feeForTarget: estimates가 빈 배열이면 TypeError', () => {
  assert.throws(() => feeForTarget([], 1), TypeError);
});
