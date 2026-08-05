#!/usr/bin/env node
'use strict';

// .env의 BLINK_API_KEY 형식을 네트워크 호출 없이 즉시 점검한다.
// check-goal의 401 응답을 기다리지 않고, 흔한 복붙 실수(다른 서비스 키, 공백)를 바로 잡아낸다.
// 실행: npm run verify-blink-key

const { validateBlinkKeyFormat } = require('../harness/lib/core');

const result = validateBlinkKeyFormat(process.env.BLINK_API_KEY);

if (result.valid) {
  console.log('✅ BLINK_API_KEY 형식이 올바릅니다 (blink_ 접두사). npm run check-goal로 실제 인증을 확인하세요.');
  process.exit(0);
}

console.error(`❌ BLINK_API_KEY 형식 오류: ${result.reason}`);
process.exit(1);
