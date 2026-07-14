'use strict';

// BIP39 니모닉 → BIP84 (네이티브 세그윗) 주소 파생.
// 학습 트랙 전용: 테스트넷이 기본값이며, 실자산 키를 이 코드로 다루지 않는다.

const bip39 = require('bip39');
const { BIP32Factory } = require('bip32');
const ecc = require('tiny-secp256k1');
const bitcoin = require('bitcoinjs-lib');

const bip32 = BIP32Factory(ecc);

const NETWORKS = {
  mainnet: { network: bitcoin.networks.bitcoin, coinType: 0 },
  testnet: { network: bitcoin.networks.testnet, coinType: 1 },
};

function generateMnemonic() {
  return bip39.generateMnemonic(256); // 24단어
}

function deriveAddress(mnemonic, { network = 'testnet', account = 0, change = 0, index = 0 } = {}) {
  if (!bip39.validateMnemonic(mnemonic)) {
    throw new Error('유효하지 않은 니모닉입니다');
  }
  const net = NETWORKS[network];
  if (!net) {
    throw new Error(`지원하지 않는 네트워크: ${network}`);
  }
  const path = `m/84'/${net.coinType}'/${account}'/${change}/${index}`;
  const seed = bip39.mnemonicToSeedSync(mnemonic);
  const child = bip32.fromSeed(seed, net.network).derivePath(path);
  const { address } = bitcoin.payments.p2wpkh({
    pubkey: Buffer.from(child.publicKey),
    network: net.network,
  });
  return { address, path };
}

module.exports = { generateMnemonic, deriveAddress };
