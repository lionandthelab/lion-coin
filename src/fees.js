'use strict';

// Esplora 호환 API(mempool.space testnet)로 수수료 추정치(sat/vB)를 조회한다.
// 학습 트랙 전용: 기본값은 테스트넷. fetch 래퍼는 얇게 두고, 파싱·선택 로직만 TDD한다.

const DEFAULT_BASE_URL = 'https://mempool.space/testnet/api';

function parseFeeEstimates(json) {
  if (json === null || typeof json !== 'object' || Array.isArray(json)) {
    throw new TypeError('fee-estimates 응답은 객체여야 합니다');
  }
  const entries = Object.entries(json).map(([key, value]) => {
    const target = Number(key);
    if (!Number.isInteger(target) || target <= 0) {
      throw new TypeError(`fee-estimates target 키가 양의 정수가 아닙니다: ${key}`);
    }
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
      throw new TypeError(`fee-estimates 값이 양의 유한수가 아닙니다: ${value}`);
    }
    return { target, satPerVb: value };
  });
  if (entries.length === 0) {
    throw new TypeError('fee-estimates 응답에 사용 가능한 추정치가 없습니다');
  }
  entries.sort((a, b) => a.target - b.target);
  return entries;
}

function feeForTarget(estimates, targetBlocks) {
  if (!Array.isArray(estimates) || estimates.length === 0) {
    throw new TypeError('estimates는 비어 있지 않은 배열이어야 합니다');
  }
  if (!Number.isInteger(targetBlocks) || targetBlocks <= 0) {
    throw new TypeError('targetBlocks는 양의 정수여야 합니다');
  }
  const atOrBefore = estimates.filter((e) => e.target <= targetBlocks);
  if (atOrBefore.length > 0) {
    return atOrBefore[atOrBefore.length - 1].satPerVb;
  }
  return estimates[0].satPerVb;
}

async function fetchFeeEstimates({ baseUrl = DEFAULT_BASE_URL } = {}) {
  const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/fee-estimates`);
  if (!res.ok) {
    throw new Error(`Esplora 응답 오류: HTTP ${res.status}`);
  }
  return parseFeeEstimates(await res.json());
}

module.exports = { DEFAULT_BASE_URL, parseFeeEstimates, feeForTarget, fetchFeeEstimates };
