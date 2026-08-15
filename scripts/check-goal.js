#!/usr/bin/env node
'use strict';

// LNbits 지갑 잔액을 조회해 목표 달성 여부를 판정하고 state.json에 반영한다.
// 실행: npm run check-goal  (.env가 있으면 자동 로드)
// 출력: 판정 결과 JSON 한 줄 (하네스 회차가 이 출력을 읽는다)

const fs = require('node:fs');
const path = require('node:path');
const {
  evaluateGoal,
  parseLnbitsWallet,
  parseBlinkWallets,
  parseCoinosWallet,
} = require('../harness/lib/core');

const STATE_PATH = path.join(__dirname, '..', 'harness', 'state.json');
const BLINK_ENDPOINT = process.env.BLINK_ENDPOINT || 'https://api.blink.sv/graphql';
const COINOS_ENDPOINT = process.env.COINOS_ENDPOINT || 'https://coinos.io/api';

async function fetchBlinkBalanceSats(apiKey) {
  const res = await fetch(BLINK_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-KEY': apiKey },
    body: JSON.stringify({
      query: 'query Me { me { defaultAccount { wallets { id walletCurrency balance } } } }',
    }),
  });
  if (!res.ok) {
    throw new Error(`Blink 응답 오류: HTTP ${res.status}`);
  }
  return parseBlinkWallets(await res.json());
}

// Coinos는 사용자명+비밀번호만으로 가입되고 KYC가 없어, Blink가 한국 번호 온보딩을
// 막은 뒤 대안으로 채택했다. 토큰은 JWT이며 **계정 전체 권한**이라 Blink의 Read 스코프
// 키보다 위험하다 — 커스터디얼 잔고를 소액으로 유지하는 원칙(docs/SECURITY.md)이 더 중요해진다.
async function fetchCoinosBalanceSats(token) {
  const res = await fetch(`${COINOS_ENDPOINT.replace(/\/+$/, '')}/me`, {
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  });
  if (!res.ok) {
    throw new Error(`Coinos 응답 오류: HTTP ${res.status}`);
  }
  return parseCoinosWallet(await res.json());
}

async function fetchLnbitsBalanceSats(url, key) {
  const res = await fetch(`${url.replace(/\/+$/, '')}/api/v1/wallet`, {
    headers: { 'X-Api-Key': key },
  });
  if (!res.ok) {
    throw new Error(`LNbits 응답 오류: HTTP ${res.status}`);
  }
  return parseLnbitsWallet(await res.json());
}

async function main() {
  const state = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));

  // 공급자는 .env에 들어 있는 것으로 자동 판별한다. Coinos를 먼저 보는 이유는
  // 2026-08-16에 Blink에서 갈아탔기 때문이며, 옛 BLINK_API_KEY가 남아 있어도
  // 새 설정이 우선하도록 하기 위함이다.
  let balanceSats = null;
  if (process.env.COINOS_TOKEN) {
    balanceSats = await fetchCoinosBalanceSats(process.env.COINOS_TOKEN);
  } else if (process.env.BLINK_API_KEY) {
    balanceSats = await fetchBlinkBalanceSats(process.env.BLINK_API_KEY);
  } else if (process.env.LNBITS_URL && process.env.LNBITS_READ_KEY) {
    balanceSats = await fetchLnbitsBalanceSats(process.env.LNBITS_URL, process.env.LNBITS_READ_KEY);
  }

  const result = evaluateGoal(state.goal, balanceSats);

  if (result.configured) {
    state.goal.last_checked_at = new Date().toISOString();
    state.goal.last_balance_sats = balanceSats;
    if (result.achieved && !state.goal.achieved) {
      state.goal.achieved = true;
      state.goal.achieved_at = state.goal.last_checked_at;
    }
    fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + '\n');
  }

  console.log(JSON.stringify({ ...result, balanceSats, targetSats: state.goal.target_sats }));
}

main().catch((err) => {
  console.error(err.message);
  process.exit(2);
});
