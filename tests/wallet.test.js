const { test } = require('node:test');
const assert = require('node:assert/strict');

const { generateMnemonic, deriveAddress } = require('../src/wallet');

// BIP84 스펙 공식 테스트 벡터
// https://github.com/bitcoin/bips/blob/master/bip-0084.mediawiki
const VECTOR_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

test('deriveAddress: BIP84 공식 벡터 — 메인넷 첫 수신 주소', () => {
  const r = deriveAddress(VECTOR_MNEMONIC, { network: 'mainnet', change: 0, index: 0 });
  assert.equal(r.address, 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu');
  assert.equal(r.path, "m/84'/0'/0'/0/0");
});

test('deriveAddress: BIP84 공식 벡터 — 메인넷 두 번째 수신 주소', () => {
  const r = deriveAddress(VECTOR_MNEMONIC, { network: 'mainnet', change: 0, index: 1 });
  assert.equal(r.address, 'bc1qnjg0jd8228aq7egyzacy8cys3knf9xvrerkf9g');
});

test('deriveAddress: BIP84 공식 벡터 — 메인넷 첫 잔돈(change) 주소', () => {
  const r = deriveAddress(VECTOR_MNEMONIC, { network: 'mainnet', change: 1, index: 0 });
  assert.equal(r.address, 'bc1q8c6fshw2dlwun7ekn9qwf37cu2rn755upcp6el');
});

test('deriveAddress: 테스트넷이 기본값이며 tb1 네이티브 세그윗 주소를 만든다', () => {
  const r = deriveAddress(VECTOR_MNEMONIC);
  assert.ok(r.address.startsWith('tb1q'), `tb1q로 시작해야 함: ${r.address}`);
  assert.equal(r.path, "m/84'/1'/0'/0/0");
});

test('deriveAddress: 같은 니모닉·경로는 항상 같은 주소 (결정적 파생)', () => {
  const a = deriveAddress(VECTOR_MNEMONIC, { index: 3 });
  const b = deriveAddress(VECTOR_MNEMONIC, { index: 3 });
  assert.equal(a.address, b.address);
});

test('deriveAddress: 인덱스가 다르면 주소도 다르다', () => {
  const a = deriveAddress(VECTOR_MNEMONIC, { index: 0 });
  const b = deriveAddress(VECTOR_MNEMONIC, { index: 1 });
  assert.notEqual(a.address, b.address);
});

test('deriveAddress: 유효하지 않은 니모닉은 거부한다', () => {
  assert.throws(() => deriveAddress('foo bar baz'), /니모닉/);
});

test('generateMnemonic: 24단어 니모닉을 생성하고 그대로 파생에 쓸 수 있다', () => {
  const m = generateMnemonic();
  assert.equal(m.split(' ').length, 24);
  const r = deriveAddress(m);
  assert.ok(r.address.startsWith('tb1q'));
});
