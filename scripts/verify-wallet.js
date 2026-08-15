#!/usr/bin/env node
'use strict';

// 지갑 토큰 형식을 네트워크 왕복 없이 점검한다.
// 실행: npm run verify-wallet
//
// check-goal의 401을 기다리지 않고 즉시 형식만 확인하기 위한 도구다.
// 실제로 "다른 서비스의 키를 넣어두고 한 달을 흘려보낸" 사고가 있었다.

const {
  validateCoinosTokenFormat,
  validateBlinkKeyFormat,
} = require('../harness/lib/core');

const providers = [
  { env: 'COINOS_TOKEN', name: 'Coinos', validate: validateCoinosTokenFormat },
  { env: 'BLINK_API_KEY', name: 'Blink', validate: validateBlinkKeyFormat },
];

const present = providers.filter((p) => process.env[p.env]);

if (present.length === 0) {
  console.log('❌ 지갑 토큰이 없습니다. .env에 COINOS_TOKEN을 넣으세요 (harness/ACTION_REQUIRED.md 참고).');
  process.exit(1);
}

let ok = true;
for (const p of present) {
  const r = p.validate(process.env[p.env]);
  if (r.valid) {
    console.log(`✅ ${p.name} (${p.env}) 형식 정상 — npm run check-goal로 실제 잔액을 확인하세요.`);
  } else {
    ok = false;
    console.log(`❌ ${p.name} (${p.env}) 형식 오류: ${r.reason}`);
  }
}

// 값 자체는 절대 출력하지 않는다 (docs/SECURITY.md).
process.exit(ok ? 0 : 1);
