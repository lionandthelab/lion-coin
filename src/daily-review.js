'use strict';

// 일일 복기 — "재료 분별과 익절·손절 설정이 옳았는가"를 사후에 검증한다. 순수 함수.
//
// **핵심 착상: 청산으로 이야기가 끝나지 않는다.**
// 손절로 나왔는데 그 뒤 반등했다면 손절이 좁았던 것이고, 익절로 나왔는데 그 뒤 더 갔다면
// 익절이 빨랐던 것이다. 청산 시점의 손익만 보면 이 둘을 구별할 수 없다 — 둘 다 그냥
// "손실 거래", "이익 거래"로 보인다. 그래서 **청산 후에도 계속 추적한 가격**이
// 판정의 재료가 된다(`postExit`).
//
// **가장 위험한 실패는 하루치 표본으로 파라미터를 바꾸는 것이다.**
// 이 프로젝트는 68~114일 표본에서 유의해 보이던 우위가 455일에서 사라진 이력이 있다
// (docs/reversal-validation.md). 하루는 거래가 0~3건이다. 그걸로 익절폭을 조정하면
// 다음 날 반대로 흔들리고, 결국 전략이 아니라 최근 잡음을 쫓는 기계가 된다.
// 그래서 복기문은 **매일 쓰되 보정 제안은 누적 표본이 찰 때만** 한다.

// 하루 거래량(0~3건)의 열 배 이상. 이틀치로 파라미터를 바꾸는 일이 없어야 한다.
const MIN_TRADES_FOR_CALIBRATION = 30;

// 사후 최고가가 익절가를 이만큼 넘어야 "익절이 좁았다"고 본다.
// 조금 넘은 것은 잡음이다 — 어떤 익절선이든 그 위로 한 틱은 지나간다.
const TP_MISS_MARGIN = 0.2;

// 이 비율 이상의 거래에서 같은 판정이 나와야 보정을 제안한다.
const CALIBRATION_THRESHOLD = 0.4;

const VERDICTS = [
  'good_exit',      // 청산 시점이 적절했다
  'tp_too_tight',   // 익절 후 더 크게 갔다 — 익절이 좁다
  'sl_too_tight',   // 손절 후 진입가를 회복했다 — 손절이 좁다
  'sl_correct',     // 손절 후 계속 빠졌다 — 손절이 살렸다
  'hold_too_short', // 시간초과 후 익절선에 닿았다 — 보유가 짧다
  'unknown',        // 사후 데이터 없음 — 판정하지 않는다
];

const positive = (v) => typeof v === 'number' && Number.isFinite(v) && v > 0;

// 거래 하나를 사후 가격으로 판정한다.
function gradeTradeOutcome({ trade, postExit } = {}) {
  const unknown = (why) => ({ verdict: 'unknown', missedBps: null, detail: why });

  if (!trade || !positive(trade.entryPrice)) return unknown('진입가가 없어 판정할 수 없습니다');
  // 없는 데이터로 추측하면 복기문이 근거 없는 조언을 하게 된다.
  if (!postExit || !positive(postExit.highest)) return unknown('청산 후 가격 기록이 없습니다');

  const { entryPrice, takeProfitBps, stopLossBps, outcome } = trade;
  const highest = postExit.highest;
  const lowest = positive(postExit.lowest) ? postExit.lowest : null;
  const tpPrice = positive(takeProfitBps) ? entryPrice * (1 + takeProfitBps / 10000) : null;

  const bpsFrom = (a, b) => ((a / b - 1) * 10000);

  if (outcome === 'take_profit') {
    const exit = positive(trade.exitPrice) ? trade.exitPrice : tpPrice;
    if (!positive(exit)) return unknown('청산가가 없어 판정할 수 없습니다');
    const gain = exit - entryPrice;
    // 익절 폭만큼 더 갔는지를 기준으로 본다 — 절대 bps가 아니라 이 거래가 노린 폭 대비다.
    if (gain > 0 && highest > exit + gain * TP_MISS_MARGIN) {
      return {
        verdict: 'tp_too_tight',
        missedBps: bpsFrom(highest, exit),
        detail: `익절 후 ${bpsFrom(highest, exit).toFixed(0)}bps 더 올랐습니다 (청산 ${exit} → 최고 ${highest})`,
      };
    }
    return { verdict: 'good_exit', missedBps: bpsFrom(highest, exit), detail: '익절 후 추가 상승이 크지 않았습니다' };
  }

  if (outcome === 'stop_loss') {
    // 손절 후 진입가를 회복했다면 그 손절은 불필요했다.
    if (highest >= entryPrice) {
      return {
        verdict: 'sl_too_tight',
        missedBps: bpsFrom(highest, entryPrice),
        detail: `손절 후 진입가를 회복했습니다 (최고 ${highest}, 진입 ${entryPrice}) — 손절폭 ${stopLossBps}bps가 좁았을 수 있습니다`,
      };
    }
    return {
      verdict: 'sl_correct',
      missedBps: null,
      detail: lowest != null
        ? `손절 후에도 ${lowest}까지 추가 하락했습니다 — 손절이 손실을 막았습니다`
        : '손절 후 진입가를 회복하지 못했습니다',
    };
  }

  if (outcome === 'timeout') {
    // 시간초과로 나왔는데 그 뒤 익절선에 닿았다면 보유시간이 짧았던 것이다.
    if (tpPrice != null && highest >= tpPrice) {
      return {
        verdict: 'hold_too_short',
        missedBps: bpsFrom(highest, trade.exitPrice ?? entryPrice),
        detail: `시간초과 청산 후 익절선(${tpPrice.toFixed(2)})에 닿았습니다 — 보유시간 ${trade.holdSec}초가 짧았을 수 있습니다`,
      };
    }
    return { verdict: 'good_exit', missedBps: null, detail: '시간초과 후에도 익절선에 닿지 않았습니다' };
  }

  return unknown(`알 수 없는 청산 사유입니다: ${outcome}`);
}

// 사후 기록은 종목+진입시각으로 찾는다 — 같은 종목을 하루에 두 번 매매할 수 있다.
function postExitKey(trade) {
  return `${trade.symbol}@${trade.at}`;
}

function summarizeDay({ date, trades = [], events = [], postExits = {} } = {}) {
  const list = Array.isArray(trades) ? trades : [];

  const byOutcome = {};
  const byGrade = {};
  const verdicts = Object.fromEntries(VERDICTS.map((v) => [v, 0]));
  const details = [];

  let netBps = 0;
  let netKrw = 0;
  let wins = 0;

  for (const t of list) {
    netBps += t.returnBps || 0;
    netKrw += t.pnlKrw || 0;
    if ((t.returnBps || 0) > 0) wins += 1;

    byOutcome[t.outcome] = (byOutcome[t.outcome] || 0) + 1;

    const g = t.grade || '미분류';
    if (!byGrade[g]) byGrade[g] = { count: 0, wins: 0, netBps: 0, netKrw: 0 };
    byGrade[g].count += 1;
    byGrade[g].netBps += t.returnBps || 0;
    byGrade[g].netKrw += t.pnlKrw || 0;
    if ((t.returnBps || 0) > 0) byGrade[g].wins += 1;

    const judged = gradeTradeOutcome({ trade: t, postExit: postExits[postExitKey(t)] });
    verdicts[judged.verdict] = (verdicts[judged.verdict] || 0) + 1;
    details.push({ symbol: t.symbol, at: t.at, grade: t.grade, outcome: t.outcome,
      returnBps: t.returnBps, ...judged });
  }

  // 왜 안 샀는지가 왜 샀는지만큼 중요하다 — 기준이 지나치게 좁으면 여기 쌓인다.
  const evs = Array.isArray(events) ? events : [];
  const skipped = {};
  let graded = 0;
  for (const e of evs) {
    if (!e.grade) continue;
    graded += 1;
    if (e.traded) continue;
    const why = e.reason || '사유 미기록';
    skipped[why] = (skipped[why] || 0) + 1;
  }

  const judgedCount = list.length - (verdicts.unknown || 0);
  let sampleWarning = null;
  if (list.length === 0) {
    sampleWarning = '이 날은 매매가 없습니다. 재료가 없었는지, 기준에 걸렸는지를 아래 "매매하지 않은 사유"에서 확인하세요.';
  } else if (list.length < 10) {
    sampleWarning = `거래 ${list.length}건은 결론을 내기에 부족합니다. 이 날의 수치는 기록이지 판단 근거가 아닙니다.`;
  }
  if (list.length > 0 && judgedCount === 0) {
    sampleWarning = (sampleWarning ? sampleWarning + ' ' : '')
      + '청산 후 가격 기록이 없어 익절·손절 설정이 옳았는지는 판정할 수 없습니다.';
  }

  return {
    date,
    tradeCount: list.length,
    wins,
    losses: list.length - wins,
    netBps,
    netKrw,
    byOutcome,
    byGrade,
    verdicts,
    details,
    judgedCount,
    materials: { total: evs.length, graded, traded: evs.filter((e) => e.traded).length, skipped },
    sampleWarning,
  };
}

// 누적 복기에서 보정을 제안한다. **하루치로는 절대 제안하지 않는다.**
function proposeCalibration(summaries, { minTrades = MIN_TRADES_FOR_CALIBRATION } = {}) {
  const days = Array.isArray(summaries) ? summaries : [];
  const totalTrades = days.reduce((s, d) => s + (d.tradeCount || 0), 0);
  const totalJudged = days.reduce((s, d) => s + (d.judgedCount || 0), 0);

  if (totalTrades < minTrades) {
    return {
      action: 'hold',
      suggestions: [],
      reason: `누적 거래 ${totalTrades}건 — 보정에 필요한 ${minTrades}건에 못 미칩니다. `
        + '적은 표본으로 파라미터를 바꾸면 다음 구간에서 반대로 흔들립니다.',
      totalTrades,
      totalJudged,
    };
  }

  // 사후 데이터가 없는 거래를 근거에 넣으면 없는 증거로 파라미터를 바꾸게 된다.
  if (totalJudged < minTrades) {
    return {
      action: 'hold',
      suggestions: [],
      reason: `판정 가능한 거래가 ${totalJudged}건뿐입니다(전체 ${totalTrades}건). `
        + '청산 후 가격 기록이 없는 거래는 익절·손절이 옳았는지 판정할 수 없어 근거로 쓰지 않습니다.',
      totalTrades,
      totalJudged,
    };
  }

  const agg = {};
  for (const d of days) for (const [k, v] of Object.entries(d.verdicts || {})) agg[k] = (agg[k] || 0) + v;

  const suggestions = [];
  const ratio = (k) => (agg[k] || 0) / totalJudged;

  if (ratio('tp_too_tight') >= CALIBRATION_THRESHOLD) {
    suggestions.push({
      param: 'takeProfitBps',
      direction: 'increase',
      rationale: '익절 후 추가 상승이 반복됩니다. 재료의 실제 폭이 설정한 익절폭보다 큽니다.',
      evidence: `판정 ${totalJudged}건 중 ${agg.tp_too_tight}건(${(ratio('tp_too_tight') * 100).toFixed(0)}%)이 익절 후 더 상승`,
      sampleSize: totalJudged,
    });
  }
  if (ratio('sl_too_tight') >= CALIBRATION_THRESHOLD) {
    suggestions.push({
      param: 'stopLossBps',
      direction: 'increase',
      rationale: '손절 후 진입가 회복이 반복됩니다. 재료가 살아 있는데 흔들림에 털리고 있습니다.',
      evidence: `판정 ${totalJudged}건 중 ${agg.sl_too_tight}건(${(ratio('sl_too_tight') * 100).toFixed(0)}%)이 손절 후 회복`,
      sampleSize: totalJudged,
    });
  }
  if (ratio('hold_too_short') >= CALIBRATION_THRESHOLD) {
    suggestions.push({
      param: 'maxHoldSec',
      direction: 'increase',
      rationale: '시간초과 청산 후 익절선 도달이 반복됩니다. 재료가 반응하는 데 설정한 시간보다 오래 걸립니다.',
      evidence: `판정 ${totalJudged}건 중 ${agg.hold_too_short}건(${(ratio('hold_too_short') * 100).toFixed(0)}%)이 시간초과 후 익절선 도달`,
      sampleSize: totalJudged,
    });
  }

  return {
    action: suggestions.length ? 'suggest' : 'hold',
    suggestions,
    reason: suggestions.length
      ? `누적 ${totalJudged}건의 사후 판정에서 반복되는 패턴을 찾았습니다.`
      : `누적 ${totalJudged}건에서 한 방향으로 치우친 패턴이 없습니다 — 현재 설정을 유지합니다.`,
    totalTrades,
    totalJudged,
    verdictTotals: agg,
  };
}

module.exports = {
  MIN_TRADES_FOR_CALIBRATION,
  TP_MISS_MARGIN,
  CALIBRATION_THRESHOLD,
  VERDICTS,
  gradeTradeOutcome,
  postExitKey,
  summarizeDay,
  proposeCalibration,
};
