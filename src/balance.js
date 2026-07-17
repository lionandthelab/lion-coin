'use strict';

// Esplora 호환 API(mempool.space testnet)로 주소의 UTXO·잔액을 조회한다.
// 학습 트랙 전용: 기본값은 테스트넷. fetch 래퍼는 얇게 두고, 파싱만 TDD한다.

const DEFAULT_BASE_URL = 'https://mempool.space/testnet/api';

function parseUtxos(json) {
  if (!Array.isArray(json)) {
    throw new TypeError('Esplora UTXO 응답은 배열이어야 합니다');
  }
  return json.map((u) => {
    if (!u || typeof u.txid !== 'string' || typeof u.vout !== 'number') {
      throw new TypeError('UTXO 항목에 txid/vout 필드가 없습니다');
    }
    if (typeof u.value !== 'number' || Number.isNaN(u.value)) {
      throw new TypeError('UTXO 항목에 숫자 value 필드가 없습니다');
    }
    return {
      txid: u.txid,
      vout: u.vout,
      value: u.value,
      confirmed: Boolean(u.status && u.status.confirmed),
    };
  });
}

function sumSats(utxos) {
  return utxos.reduce((total, u) => total + u.value, 0);
}

async function fetchUtxos(address, { baseUrl = DEFAULT_BASE_URL } = {}) {
  const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/address/${address}/utxo`);
  if (!res.ok) {
    throw new Error(`Esplora 응답 오류: HTTP ${res.status}`);
  }
  return parseUtxos(await res.json());
}

async function fetchBalanceSats(address, opts = {}) {
  const utxos = await fetchUtxos(address, opts);
  return sumSats(utxos);
}

module.exports = { DEFAULT_BASE_URL, parseUtxos, sumSats, fetchUtxos, fetchBalanceSats };
