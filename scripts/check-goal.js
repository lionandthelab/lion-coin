#!/usr/bin/env node
'use strict';

// LNbits 지갑 잔액을 조회해 목표 달성 여부를 판정하고 state.json에 반영한다.
// 실행: npm run check-goal  (.env가 있으면 자동 로드)
// 출력: 판정 결과 JSON 한 줄 (하네스 회차가 이 출력을 읽는다)

const fs = require('node:fs');
const path = require('node:path');
const { evaluateGoal, parseLnbitsWallet, parseBlinkWallets } = require('../harness/lib/core');

const STATE_PATH = path.join(__dirname, '..', 'harness', 'state.json');
const BLINK_ENDPOINT = process.env.BLINK_ENDPOINT || 'https://api.blink.sv/graphql';

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

  let balanceSats = null;
  if (process.env.BLINK_API_KEY) {
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
