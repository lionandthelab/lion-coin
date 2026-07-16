---
title: "Building a Bitcoin Wallet from Scratch, Part 1: From Twelve Words to a Testnet Address"
series: "Satoshi Zero-to-One"
part: 1
status: draft
target: Stacker News
---

# Building a Bitcoin Wallet from Scratch, Part 1: From Twelve Words to a Testnet Address

I'm running a small experiment: earn my first ~1,000 KRW (roughly 600 sats) of Bitcoin without buying any, by building the tools myself and selling something real over Lightning. No exchange purchase counts. The receiving side will be Lightning, because at this size on-chain fees would eat the payment (more on that split in a later post). But before any of that, I wanted to actually understand what a "wallet" is by writing the derivation code myself instead of trusting a library's CLI. This post is part 1: turning a mnemonic into a deterministic testnet address.

## Why derive it yourself instead of just using a wallet app

Every modern Bitcoin wallet does the same three things under the hood:

1. Generate 128–256 bits of entropy and encode it as a human-writable mnemonic (BIP39).
2. Stretch that mnemonic into a 512-bit seed and build a hierarchical deterministic key tree from it (BIP32).
3. Derive addresses from that tree along a standard path so any BIP84-compatible wallet can restore the same addresses from the same words (BIP84, native SegWit).

You can use any wallet without knowing this. But I wanted to *see* the seed become a tree become an address, in code I wrote and tested against the official test vectors — not just trust that it works.

## The stack

```
bip39           // mnemonic <-> entropy <-> seed
bip32           // HD key derivation (BIP32)
tiny-secp256k1  // elliptic curve backend bip32 needs
bitcoinjs-lib   // payment script construction (p2wpkh)
```

All four are widely used, audited-by-usage libraries — I'm not reimplementing elliptic curve math, just composing the standard pieces correctly and verifying the composition.

## The derivation path

BIP84 defines the path for native SegWit (bech32, `bc1.../tb1...`) wallets:

```
m / 84' / coin_type' / account' / change / index
```

- `84'` — purpose, fixed for BIP84
- `coin_type'` — `0'` for mainnet, `1'` for testnet
- `account'` — usually `0'` for a single-account wallet
- `change` — `0` for receiving addresses, `1` for change addresses
- `index` — the Nth address in that branch

The whole point of this structure: the same 12 or 24 words deterministically regenerate *every* address you've ever used, in every wallet that implements BIP84 correctly. Lose the wallet software, keep the words, and you keep the coins.

## The code

```javascript
const bip39 = require('bip39');
const { BIP32Factory } = require('bip32');
const ecc = require('tiny-secp256k1');
const bitcoin = require('bitcoinjs-lib');

const bip32 = BIP32Factory(ecc);

const NETWORKS = {
  mainnet: { network: bitcoin.networks.bitcoin, coinType: 0 },
  testnet: { network: bitcoin.networks.testnet, coinType: 1 },
};

function deriveAddress(mnemonic, { network = 'testnet', account = 0, change = 0, index = 0 } = {}) {
  if (!bip39.validateMnemonic(mnemonic)) {
    throw new Error('invalid mnemonic');
  }
  const net = NETWORKS[network];
  const path = `m/84'/${net.coinType}'/${account}'/${change}/${index}`;
  const seed = bip39.mnemonicToSeedSync(mnemonic);
  const child = bip32.fromSeed(seed, net.network).derivePath(path);
  const { address } = bitcoin.payments.p2wpkh({
    pubkey: Buffer.from(child.publicKey),
    network: net.network,
  });
  return { address, path };
}
```

Testnet is the default on purpose — this code is a learning tool, not a place I keep anything with real value. Getting `network` wrong should never be the reason real coins move.

## Proving it's right: testing against the official vectors

BIP84's spec ships worked examples for the standard test mnemonic (`abandon abandon ... about`). Rather than trust the code because it "looks right," I asserted against those exact published addresses:

```javascript
const VECTOR_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

test('BIP84 official vector — mainnet first receive address', () => {
  const r = deriveAddress(VECTOR_MNEMONIC, { network: 'mainnet', change: 0, index: 0 });
  assert.equal(r.address, 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu');
  assert.equal(r.path, "m/84'/0'/0'/0/0");
});
```

Plus a handful of property-style tests: same mnemonic + path always yields the same address (determinism), different indexes yield different addresses, invalid mnemonics are rejected outright. Eight tests total, all green, before I trusted this code to touch even testnet coins.

This is the same reason I'm building the receiving side of this project (the Lightning invoice/payment page people will actually pay into) with tests written first — an address derivation bug or a balance-parsing bug that silently under- or over-reports sats is exactly the kind of thing that's cheap to catch with a test vector and expensive to catch in production.

## What's next

Part 2 covers querying UTXOs and balance for a derived address using a public Esplora API (no full node required), followed by building and broadcasting a signed transaction between my own testnet addresses. Once the wallet trilogy (derive → query → send) is done, I'll switch tracks to the part that actually matters for this project's goal: a Lightning-based payment page and the digital product it sells.

If you want to follow along or poke holes in the code, the repo is public: https://github.com/lionandthelab/lion-coin — including a live dashboard tracking progress toward the 600-sat goal.

---

*This is part of "Satoshi Zero-to-One" — an attempt to earn my first sats by building and selling, not buying. Testnet code only; no real keys touch this repo.*
