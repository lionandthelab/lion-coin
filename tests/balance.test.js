const { test } = require('node:test');
const assert = require('node:assert/strict');

const { parseUtxos, sumSats } = require('../src/balance');

// ---- parseUtxos ----

test('parseUtxos: Esplora UTXO 배열을 정규화한다 (txid, vout, value, confirmed)', () => {
  const json = [
    { txid: 'a'.repeat(64), vout: 0, value: 100000, status: { confirmed: true } },
    { txid: 'b'.repeat(64), vout: 1, value: 546, status: { confirmed: false } },
  ];
  const r = parseUtxos(json);
  assert.deepEqual(r, [
    { txid: 'a'.repeat(64), vout: 0, value: 100000, confirmed: true },
    { txid: 'b'.repeat(64), vout: 1, value: 546, confirmed: false },
  ]);
});

test('parseUtxos: 빈 배열이면 빈 배열을 돌려준다 (UTXO 없음)', () => {
  assert.deepEqual(parseUtxos([]), []);
});

test('parseUtxos: status 필드가 없어도 confirmed=false로 처리한다', () => {
  const r = parseUtxos([{ txid: 'c'.repeat(64), vout: 0, value: 1000 }]);
  assert.equal(r[0].confirmed, false);
});

test('parseUtxos: 배열이 아니면 TypeError', () => {
  assert.throws(() => parseUtxos({}), TypeError);
  assert.throws(() => parseUtxos(null), TypeError);
  assert.throws(() => parseUtxos('nope'), TypeError);
});

test('parseUtxos: value가 숫자가 아닌 항목이 있으면 TypeError', () => {
  assert.throws(() => parseUtxos([{ txid: 'a'.repeat(64), vout: 0, value: 'x' }]), TypeError);
  assert.throws(() => parseUtxos([{ txid: 'a'.repeat(64), vout: 0 }]), TypeError);
});

test('parseUtxos: txid/vout이 없는 항목이 있으면 TypeError', () => {
  assert.throws(() => parseUtxos([{ vout: 0, value: 1000 }]), TypeError);
  assert.throws(() => parseUtxos([{ txid: 'a'.repeat(64), value: 1000 }]), TypeError);
});

// ---- sumSats ----

test('sumSats: UTXO 값들의 합을 sats로 돌려준다', () => {
  const utxos = parseUtxos([
    { txid: 'a'.repeat(64), vout: 0, value: 100000 },
    { txid: 'b'.repeat(64), vout: 0, value: 546 },
  ]);
  assert.equal(sumSats(utxos), 100546);
});

test('sumSats: 빈 배열은 0', () => {
  assert.equal(sumSats([]), 0);
});
