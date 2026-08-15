'use strict';

// 검증 방법론 — 순수 함수. 폴드 분할·격자 전개·점수·집계.
//
// 이 모듈이 "전략이 통과했는가"의 판정 기준을 독점한다. 판정 로직이 스크립트마다
// 흩어져 있으면, 통과시키고 싶은 유혹이 생겼을 때 어느 하나만 슬쩍 느슨해진다.
// 한 곳에 모아 테스트로 고정해 둔다.

// 파라미터 사양을 데카르트 곱으로 펼친다.
function grid(spec) {
  return Object.entries(spec).reduce(
    (acc, [key, values]) => acc.flatMap((row) => values.map((v) => ({ ...row, [key]: v }))),
    [{}]
  );
}

// 앵커드 롤링: 학습 구간은 처음부터 누적하고, 검증 구간만 앞으로 민다.
// 단일 분할은 검증 표본이 하나뿐이라 그 구간의 장세에 결론이 통째로 좌우된다.
function buildFolds(total, { foldCount = 6, firstTrainRatio = 0.4, minTestSize = 100 } = {}) {
  const testSize = Math.floor((total * (1 - firstTrainRatio)) / foldCount);
  const folds = [];
  for (let k = 0; k < foldCount; k += 1) {
    const trainEnd = Math.floor(total * firstTrainRatio) + k * testSize;
    const testEnd = Math.min(trainEnd + testSize, total);
    if (testEnd - trainEnd < minTestSize) break;
    folds.push({ trainEnd, testEnd });
  }
  return folds;
}

// 학습 구간에서 후보를 고르는 점수.
// 수익률만 보면 낙폭이 큰 극단값이 뽑히는데, 실거래에서는 계좌가 먼저 못 견딘다.
// 표본이 적으면 우연이 실력처럼 보이므로 최소 트레이드 수 미달은 아예 제외한다.
function scoreSummary(summary, { minTrades = 20 } = {}) {
  if (!summary || summary.tradeCount < minTrades) return -Infinity;
  if (summary.totalReturnPct <= 0) return summary.totalReturnPct;
  return summary.totalReturnPct / Math.max(summary.maxDrawdownPct, 1);
}

const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;

// 폴드별 결과를 하나의 판정으로 모은다.
//
// 게이트는 두 조건을 **모두** 요구한다: 검증 평균이 플러스이고, 플러스 폴드가 과반.
// 평균만 보면 한 폴드의 대박이 나머지 실패를 가리고, 폴드 수만 보면 작은 이익
// 여러 번이 한 번의 큰 손실을 덮는다.
function aggregate(rows) {
  if (!Array.isArray(rows) || rows.length === 0) {
    return {
      meanTestPct: null,
      meanGapPct: null,
      positiveFolds: 0,
      beatsBhFolds: 0,
      totalFolds: 0,
      passesGate: false,
    };
  }

  const tests = rows.map((r) => r.test.totalReturnPct);
  const gaps = rows.map((r) => r.train.totalReturnPct - r.test.totalReturnPct);
  const positiveFolds = tests.filter((v) => v > 0).length;
  const beatsBhFolds = rows.filter((r) => r.test.totalReturnPct > r.bh.totalReturnPct).length;
  const meanTestPct = mean(tests);

  return {
    meanTestPct,
    meanGapPct: mean(gaps),
    positiveFolds,
    beatsBhFolds,
    totalFolds: rows.length,
    passesGate: meanTestPct > 0 && positiveFolds > rows.length / 2,
  };
}

module.exports = { grid, buildFolds, scoreSummary, aggregate, mean };
