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
function buildFolds(
  total,
  { foldCount = 6, firstTrainRatio = 0.4, minTestSize = 100, mode = 'anchored' } = {}
) {
  if (mode !== 'anchored' && mode !== 'rolling') {
    throw new RangeError(`mode는 anchored 또는 rolling이어야 합니다: ${mode}`);
  }

  const firstTrainEnd = Math.floor(total * firstTrainRatio);
  const testSize = Math.floor((total * (1 - firstTrainRatio)) / foldCount);
  const folds = [];

  for (let k = 0; k < foldCount; k += 1) {
    const trainEnd = firstTrainEnd + k * testSize;
    const testEnd = Math.min(trainEnd + testSize, total);
    if (testEnd - trainEnd < minTestSize) break;
    // 앵커드는 오래된 장세까지 계속 학습에 넣고, 롤링은 최근 구간만 본다.
    const trainFrom = mode === 'rolling' ? Math.max(0, trainEnd - firstTrainEnd) : 0;
    folds.push({ trainFrom, trainEnd, testEnd });
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

// 폴드별 아웃오브샘플 구간을 하나의 연속 포지션 배열로 이어붙인다.
//
// 폴드 수익률을 산술평균하면 두 가지가 사라진다: 복리와, 폴드 경계를 걸친 낙폭.
// 실제로 그 전략을 계속 굴렸다면 나왔을 곡선을 보려면 이어붙여야 한다.
// 각 구간은 자기 폴드의 파라미터로 계산된 전체 길이 포지션 배열이며,
// 여기서 [from, to) 슬라이스만 꺼내 쓴다.
function stitchSegments(segments) {
  if (!Array.isArray(segments) || segments.length === 0) {
    throw new Error('이어붙일 구간이 비어 있습니다');
  }

  const positions = [];
  let cursor = segments[0].from;

  for (const seg of segments) {
    if (seg.from !== cursor) {
      throw new Error(
        `구간이 연속되지 않습니다: ${cursor}에서 이어져야 하는데 ${seg.from}에서 시작합니다`
      );
    }
    positions.push(...seg.positions.slice(seg.from, seg.to));
    cursor = seg.to;
  }

  return { from: segments[0].from, to: cursor, positions };
}

// 이어붙인 자산곡선의 지표. 정의되지 않는 값은 null로 둔다.
function curveMetrics(equity, { periodsPerYear } = {}) {
  if (!Array.isArray(equity) || equity.length < 2) {
    throw new Error('자산곡선은 최소 2개 이상이어야 합니다');
  }
  if (!Number.isFinite(periodsPerYear) || periodsPerYear <= 0) {
    throw new RangeError(`periodsPerYear는 양수여야 합니다: ${periodsPerYear}`);
  }

  const first = equity[0];
  const last = equity[equity.length - 1];
  const totalReturnPct = (last / first - 1) * 100;

  let peak = first;
  let maxDd = 0;
  const rets = [];
  for (let i = 0; i < equity.length; i += 1) {
    if (equity[i] > peak) peak = equity[i];
    const dd = ((peak - equity[i]) / peak) * 100;
    if (dd > maxDd) maxDd = dd;
    if (i > 0 && equity[i - 1] > 0) rets.push(equity[i] / equity[i - 1] - 1);
  }

  const periods = equity.length - 1;
  const years = periods / periodsPerYear;
  const cagrPct = years > 0 && last > 0 ? ((last / first) ** (1 / years) - 1) * 100 : null;

  const avg = rets.length > 0 ? mean(rets) : null;
  const variance =
    rets.length > 1 ? rets.reduce((a, r) => a + (r - avg) ** 2, 0) / (rets.length - 1) : 0;
  const sd = Math.sqrt(variance);
  const sharpe = sd > 0 ? (avg / sd) * Math.sqrt(periodsPerYear) : null;

  return {
    totalReturnPct,
    maxDrawdownPct: maxDd,
    cagrPct,
    // 낙폭이 0이면 비율이 무한대가 된다 — 지표로 쓰지 않는다.
    calmar: maxDd > 0 && cagrPct != null ? cagrPct / maxDd : null,
    volatilityPct: sd > 0 ? sd * Math.sqrt(periodsPerYear) * 100 : null,
    sharpe,
  };
}

// 워크포워드 효율 — 학습 구간 성과 대비 검증 구간에서 실제로 살아남은 비율.
// 1에 가까울수록 견고하고, 0에 가까우면 학습 구간에만 맞춘 것이다.
// 학습 성과가 0 이하면 비율 자체가 무의미하므로 null.
function walkForwardEfficiency(inSampleReturns, outSampleReturns) {
  if (!Array.isArray(inSampleReturns) || inSampleReturns.length === 0) return null;
  const is = mean(inSampleReturns);
  if (!(is > 0)) return null;
  return mean(outSampleReturns) / is;
}

// 워크포워드 게이트. 페이퍼 30일 대신 이어붙인 아웃오브샘플 곡선으로 판정한다.
// 조건을 하나라도 못 넘으면 통과가 아니며, 실패 사유를 전부 돌려준다 —
// 어느 조건에서 걸렸는지 알아야 다음 시도의 방향이 정해진다.
const WF_GATE = { maxDrawdownPct: 35, minTrades: 30, minWfe: 0.2 };

function evaluateWfGate(
  { totalReturnPct, maxDrawdownPct, bhReturnPct, tradeCount, wfe },
  limits = WF_GATE
) {
  const reasons = [];
  if (!(totalReturnPct > 0)) reasons.push(`검증 총수익이 플러스가 아님 (${totalReturnPct?.toFixed(2)}%)`);
  if (!(totalReturnPct > bhReturnPct)) reasons.push(`매수보유 미달 (${totalReturnPct?.toFixed(2)}% ≤ ${bhReturnPct?.toFixed(2)}%)`);
  if (!(maxDrawdownPct <= limits.maxDrawdownPct)) reasons.push(`낙폭 초과 (${maxDrawdownPct?.toFixed(1)}% > ${limits.maxDrawdownPct}%)`);
  if (!(tradeCount >= limits.minTrades)) reasons.push(`표본 부족 (트레이드 ${tradeCount} < ${limits.minTrades})`);
  if (!(wfe != null && wfe >= limits.minWfe)) reasons.push(`워크포워드 효율 미달 (${wfe == null ? 'n/a' : wfe.toFixed(2)} < ${limits.minWfe})`);

  return { passes: reasons.length === 0, reasons };
}

module.exports = {
  grid,
  buildFolds,
  scoreSummary,
  aggregate,
  mean,
  stitchSegments,
  curveMetrics,
  walkForwardEfficiency,
  evaluateWfGate,
  WF_GATE,
};
