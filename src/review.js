'use strict';

// 10거래마다 복기해 전략을 조정하는 로직 — 순수 함수.
//
// **이 모듈의 가장 큰 위험은 잡음에 반응해 파라미터를 흔드는 것이다.**
// 10거래는 매우 작은 표본이다. 익절 500 / 손절 200 구조에서 손익분기 승률이
// 32%인데, 진짜 승률이 40%여도 10거래에서 20%가 나올 확률은 우연만으로 상당하다.
// 그런 표본을 보고 익절폭을 조정하면 다음 10거래에서 반대로 흔들리고, 결국
// 전략이 아니라 최근 잡음을 쫓는 기계가 된다.
//
// 그래서 비대칭으로 만든다:
//   - **멈추는 데는 민감하게.** 손실은 되돌릴 수 없으므로 의심스러우면 멈춘다.
//   - **바꾸는 데는 둔감하게.** 연속으로 나쁜 복기가 쌓여야 파라미터를 건드린다.
//
// 이 프로젝트에서 실제로 68~114일 표본의 우위가 455일에서 사라진 적이 있다.
// 10거래는 그보다 몇 자릿수 작은 표본이라는 점을 잊으면 안 된다.

const { breakevenWinRate } = require('./bracket');

const REVIEW_EVERY = 10;

// 파라미터를 바꾸기 전에 요구하는 연속 부진 복기 횟수.
// 2면 30거래에 걸쳐 계속 나빴다는 뜻이다.
const BAD_REVIEWS_BEFORE_ADJUST = 2;

function shouldReview(closedCount) {
  return Number.isInteger(closedCount) && closedCount > 0 && closedCount % REVIEW_EVERY === 0;
}

function reviewTrades(trades, { window = REVIEW_EVERY, takeProfitBps, stopLossBps, costBps } = {}) {
  const list = Array.isArray(trades) ? trades.slice(-window) : [];

  if (list.length === 0) {
    return {
      count: 0, wins: 0, winRate: null, expectancyBps: null, totalBps: 0,
      maxLossStreak: 0, breakevenWinRate: null, belowBreakeven: false, byOutcome: {},
    };
  }

  const byOutcome = {};
  let total = 0;
  let wins = 0;
  let streak = 0;
  let maxLossStreak = 0;
  for (const t of list) {
    byOutcome[t.outcome] = (byOutcome[t.outcome] || 0) + 1;
    total += t.returnBps;
    if (t.returnBps > 0) {
      wins += 1;
      streak = 0;
    } else {
      streak += 1;
      if (streak > maxLossStreak) maxLossStreak = streak;
    }
  }

  const winRate = wins / list.length;
  // 설정을 안 주면 손익분기를 계산할 수 없다. 임의값을 만들지 않는다.
  const be =
    takeProfitBps != null && stopLossBps != null
      ? breakevenWinRate({ tpBps: takeProfitBps, slBps: stopLossBps, costBps: costBps || 0 })
      : null;

  return {
    count: list.length,
    wins,
    winRate,
    expectancyBps: total / list.length,
    totalBps: total,
    maxLossStreak,
    breakevenWinRate: be,
    belowBreakeven: be != null ? winRate < be : false,
    byOutcome,
  };
}

// 복기 결과 → 행동. 'hold' | 'halt' | 'adjust'
function proposeAdjustment(review, {
  maxDrawdownBps = 1000,
  consecutiveBadReviews = 0,
  badReviewsBeforeAdjust = BAD_REVIEWS_BEFORE_ADJUST,
} = {}) {
  const evidence = [];

  if (!review || review.count < REVIEW_EVERY) {
    return {
      action: 'hold',
      reason: `표본 ${review ? review.count : 0}건 — ${REVIEW_EVERY}건을 채우기 전에는 판단하지 않습니다`,
      evidence,
    };
  }

  evidence.push(`최근 ${review.count}거래 기대값 ${review.expectancyBps.toFixed(1)}bps`);
  evidence.push(`승률 ${(review.winRate * 100).toFixed(0)}%`);
  if (review.breakevenWinRate != null) {
    evidence.push(`손익분기 승률 ${(review.breakevenWinRate * 100).toFixed(0)}%`);
  }
  evidence.push(`최대 연속 손실 ${review.maxLossStreak}회`);

  // 1) 멈춤 — 되돌릴 수 없는 손실이 쌓였으면 즉시. 여기서는 관대하지 않다.
  if (review.totalBps <= -Math.abs(maxDrawdownBps)) {
    return {
      action: 'halt',
      reason:
        `최근 ${review.count}거래 누적 손실 ${review.totalBps.toFixed(0)}bps가 ` +
        `한도 ${maxDrawdownBps}bps를 넘었습니다 — 매매를 멈춥니다`,
      evidence,
    };
  }

  // 2) 실적이 손익분기 위면 손댈 이유가 없다
  if (!review.belowBreakeven) {
    return { action: 'hold', reason: '승률이 손익분기 위입니다 — 설정을 유지합니다', evidence };
  }

  // 3) 부진하지만 아직 한 번뿐이면 기다린다.
  //    10거래는 파라미터를 바꿀 근거가 못 된다 — 한 번 나빴다고 움직이면 잡음을 쫓는다.
  if (consecutiveBadReviews < badReviewsBeforeAdjust) {
    return {
      action: 'hold',
      reason:
        `승률 ${(review.winRate * 100).toFixed(0)}%가 손익분기 미달이지만 ` +
        `연속 부진 ${consecutiveBadReviews}회 — ${badReviewsBeforeAdjust}회까지는 표본을 더 봅니다`,
      evidence,
    };
  }

  // 4) 연속으로 부진하면 조정한다.
  //    승률이 부족할 때 익절폭을 **줄여** 손익분기 승률을 낮춘다. 익절을 늘리면
  //    손익분기는 낮아지지만 도달 확률도 같이 떨어져 실제로는 나아지지 않는다.
  return {
    action: 'adjust',
    reason:
      `연속 ${consecutiveBadReviews}회 부진 — 실측 승률 ${(review.winRate * 100).toFixed(0)}%에서도 ` +
      `성립하도록 익절폭을 좁혀 손익분기 승률을 낮춥니다`,
    patch: { takeProfitBps: 300, stopLossBps: 150 },
    evidence,
  };
}

module.exports = {
  REVIEW_EVERY,
  BAD_REVIEWS_BEFORE_ADJUST,
  shouldReview,
  reviewTrades,
  proposeAdjustment,
};
