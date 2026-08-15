#!/usr/bin/env node
'use strict';

// 연구 캠페인 — 심볼 × 시간대 × 전략을 한 번에 롤링 워크포워드로 검증한다.
//
// 실행: npm run research -- BTCUSDT,ETHUSDT,SOLUSDT 4h 2023-01-01
//
// 판정 기준(src/research.js)은 이 스크립트가 만지지 않는다. 통과시키고 싶은
// 유혹이 생겼을 때 슬쩍 느슨해질 수 있는 곳을 하나로 몰아두기 위함이다.
//
// 결과는 data/research-<타임스탬프없음키>.json 에도 남겨 리포트 작성에 쓴다.

const fs = require('node:fs');
const path = require('node:path');
const { fetchKlinesRange } = require('../src/klines');
const { fetchFundingRange, attachFunding } = require('../src/funding');
const { runBacktest, summarize } = require('../src/backtest');
const { STRATEGIES } = require('../src/strategies');
const {
  grid,
  buildFolds,
  scoreSummary,
  mean,
  stitchSegments,
  curveMetrics,
  walkForwardEfficiency,
  evaluateWfGate,
  WF_GATE,
} = require('../src/research');

// 심볼은 쉼표 목록으로 주거나, harness/universe.json의 그룹 이름으로 줄 수 있다.
// 그룹을 파일에 고정해 두는 이유: 탐색과 확인에 쓸 심볼을 미리 갈라 둬야
// 나중에 결과를 보고 유리한 쪽으로 심볼을 고르는 일이 생기지 않는다.
function resolveSymbols(arg) {
  const raw = arg || 'BTCUSDT';
  const uniPath = path.join(__dirname, '..', 'harness', 'universe.json');
  if (fs.existsSync(uniPath)) {
    const uni = JSON.parse(fs.readFileSync(uniPath, 'utf8'));
    const picked = raw
      .split(',')
      .map((x) => x.trim())
      .flatMap((x) => uni.groups[x] || [x.toUpperCase()]);
    return [...new Set(picked)];
  }
  return raw.split(',').map((s) => s.trim().toUpperCase());
}

const SYMBOLS = resolveSymbols(process.argv[2]);
const INTERVAL = process.argv[3] || '4h';
const START = process.argv[4] || '2023-01-01';
const MODE = process.argv[5] || 'anchored'; // anchored | rolling
const EXECUTION = process.argv[6] || 'taker'; // taker | maker

// 이어붙인 곡선의 연율화 지표(CAGR·샤프)를 내려면 봉 하나가 1년의 몇 분의 일인지 알아야 한다.
const PERIODS_PER_YEAR = {
  '1m': 525600, '5m': 105120, '15m': 35040, '30m': 17520,
  '1h': 8760, '2h': 4380, '4h': 2190, '6h': 1460, '12h': 730, '1d': 365,
};

// 무기한 선물 전제이므로 펀딩 비용을 문다. 빼면 장기 보유 전략이 실제보다 좋아 보인다.
// 바이낸스 선물 실제 요율에 맞춘다 — 테이커 5bps, 메이커 2bps.
// 초단타는 봉당 움직임이 왕복 비용보다 작아 이 차이가 결론을 가른다.
const COSTS = {
  execution: EXECUTION,
  takerFeeBps: 5,
  makerFeeBps: 2,
  makerOffsetBps: 2,
  slippageBps: 2,
  initialEquity: 1000,
  fundingCost: true,
};
// 폴드를 늘리면 재최적화가 잦아져 실제 운용에 가까워지고, 이어붙인 곡선도 길어진다.
const FOLD_OPTS = { foldCount: 8, firstTrainRatio: 0.4, minTestSize: 60, mode: MODE };
const SCORE_OPTS = { minTrades: 15 };

const DATA_DIR = path.join(__dirname, '..', 'data');

// 손절·일일 한도는 격자에서 제외하고 고정한다. 1차 검증에서 최적화기가
// 세 전략 모두의 손절을 꺼버렸기 때문이다 (docs/walkforward-report.md §3).
const FIXED_RISK = { atrStopMult: 3, dailyLossLimitPct: 5 };
const withRisk = (rows) => rows.map((p) => ({ ...p, ...FIXED_RISK }));

const PPY = PERIODS_PER_YEAR[INTERVAL] || 2190;

const GRIDS = {
  // 사이징 계층 — 연속 노출 엔진이 열리면서 처음 시도하는 축.
  // 봇 역이용 계열 — 다른 참여자의 예측 가능한 강제 행동을 되받는다.
  stopRunReversal: withRisk(
    grid({ lookback: [12, 24, 48, 96], holdBars: [1, 3, 6, 12] })
  ),
  liquidationFade: withRisk(
    grid({ lookback: [50, 100], volMult: [3, 5, 8], rangeMult: [2, 3], holdBars: [1, 3, 6] })
  ),

  volTarget: withRisk(
    grid({
      inner: ['emaCrossLS', 'donchianLS', 'tsMomentum'],
      targetVolPct: [20, 30, 40],
      volLookback: [30, 60],
    }).map((p) => ({ ...p, periodsPerYear: PPY }))
  ),
  portfolio: withRisk(
    [
      [
        { strategy: 'emaCrossLS', params: {}, weight: 1 },
        { strategy: 'donchianLS', params: {}, weight: 1 },
        { strategy: 'tsMomentum', params: {}, weight: 1 },
      ],
      [
        { strategy: 'emaCrossLS', params: { fast: 20, slow: 100 } , weight: 1 },
        { strategy: 'volBreakout', params: {}, weight: 1 },
        { strategy: 'fundingLS', params: {}, weight: 1 },
      ],
      [
        { strategy: 'emaCrossLS', params: {}, weight: 2 },
        { strategy: 'volBreakout', params: {}, weight: 1 },
        { strategy: 'rsiReversion', params: {}, weight: 1 },
        { strategy: 'fundingLS', params: {}, weight: 1 },
      ],
      [
        { strategy: 'tsMomentum', params: { lookback: 48 }, weight: 1 },
        { strategy: 'tsMomentum', params: { lookback: 168 }, weight: 1 },
        { strategy: 'tsMomentum', params: { lookback: 336 }, weight: 1 },
      ],
    ].map((members) => ({ members }))
  ),
  emaCross: withRisk(grid({ fast: [8, 12, 20, 30], slow: [26, 50, 100, 200] }).filter((p) => p.fast < p.slow)),
  emaCrossLS: withRisk(grid({ fast: [8, 12, 20, 30], slow: [26, 50, 100, 200] }).filter((p) => p.fast < p.slow)),
  rsiReversion: withRisk(grid({ rsiPeriod: [7, 14, 21], buyBelow: [20, 30], sellAbove: [70, 80] })),
  donchianBreakout: withRisk(grid({ entryLookback: [10, 20, 50], exitLookback: [5, 10, 20] })),
  donchianLS: withRisk(grid({ entryLookback: [10, 20, 50], exitLookback: [5, 10, 20] })),
  tsMomentum: withRisk(grid({ lookback: [12, 24, 48, 96, 168, 336] })),
  volBreakout: withRisk(grid({ rangeLookback: [12, 24, 48], k: [0.3, 0.5, 0.8] })),
  fundingReversion: withRisk(grid({ fundingLookback: [30, 90, 180], buyBelowPct: [20, 30], sellAbovePct: [70, 80] })),
  fundingLS: withRisk(grid({ fundingLookback: [30, 90, 180], buyBelowPct: [20, 30], sellAbovePct: [70, 80] })),
  ensemble: withRisk(
    grid({ threshold: [2, 3] }).flatMap((p) => [
      { ...p, members: [
        { strategy: 'emaCrossLS', params: {} },
        { strategy: 'donchianLS', params: {} },
        { strategy: 'tsMomentum', params: {} },
      ] },
      { ...p, members: [
        { strategy: 'emaCrossLS', params: { fast: 20, slow: 100 } },
        { strategy: 'tsMomentum', params: { lookback: 96 } },
        { strategy: 'volBreakout', params: {} },
      ] },
    ])
  ),
};

async function loadSymbol(symbol) {
  const cache = path.join(DATA_DIR, `${symbol}-${INTERVAL}-${START}-f.json`);
  if (fs.existsSync(cache)) {
    return JSON.parse(fs.readFileSync(cache, 'utf8'));
  }

  const startTime = Date.parse(`${START}T00:00:00Z`);
  const endTime = Date.now();
  process.stdout.write(`  ${symbol} 캔들 수집...`);
  const priceOnly = await fetchKlinesRange({ symbol, interval: INTERVAL, startTime, endTime });
  process.stdout.write(` ${priceOnly.length}봉 · 펀딩 수집...`);
  const rates = await fetchFundingRange({ symbol, startTime, endTime });
  console.log(` ${rates.length}건`);

  const candles = attachFunding(priceOnly, rates);
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(cache, JSON.stringify(candles));
  return candles;
}

function evaluate(name, params, candles) {
  const targetPositions = STRATEGIES[name](candles, params);
  return summarize(runBacktest({ candles, targetPositions, ...COSTS }));
}

const buyAndHold = (candles) =>
  summarize(runBacktest({ candles, targetPositions: candles.map(() => 1), ...COSTS }));

const pct = (v) => (v == null ? '   n/a' : `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`);

async function runSymbol(symbol) {
  const candles = await loadSymbol(symbol);
  const folds = buildFolds(candles.length, FOLD_OPTS);
  if (folds.length === 0) {
    console.log(`  ${symbol}: 봉이 모자라 건너뜀 (${candles.length})`);
    return null;
  }

  const periodsPerYear = PERIODS_PER_YEAR[INTERVAL];
  if (!periodsPerYear) throw new Error(`연율화 계수를 모르는 간격: ${INTERVAL}`);

  // 이어붙일 전체 아웃오브샘플 구간
  const wfFrom = folds[0].trainEnd;
  const wfTo = folds[folds.length - 1].testEnd;
  const wfCandles = candles.slice(wfFrom, wfTo);
  const bhResult = runBacktest({
    candles: wfCandles,
    targetPositions: wfCandles.map(() => 1),
    ...COSTS,
  });
  const bhMetrics = curveMetrics(bhResult.equity, { periodsPerYear });

  const results = [];

  for (const [name, params] of Object.entries(GRIDS)) {
    const segments = [];
    const isReturns = [];
    const oosReturns = [];

    for (const { trainFrom, trainEnd, testEnd } of folds) {
      const train = candles.slice(trainFrom, trainEnd);
      let best = null;
      for (const p of params) {
        const s = evaluate(name, p, train);
        const sc = scoreSummary(s, SCORE_OPTS);
        if (best === null || sc > best.score) best = { params: p, summary: s, score: sc };
      }
      isReturns.push(best.summary.totalReturnPct);

      // 신호는 워밍업 포함 전체 이력으로 내고, 이어붙일 때 [trainEnd, testEnd)만 꺼낸다.
      const positions = STRATEGIES[name](candles.slice(0, testEnd), best.params);
      segments.push({ from: trainEnd, to: testEnd, positions });
      oosReturns.push(evaluate(name, best.params, candles.slice(trainEnd, testEnd)).totalReturnPct);
    }

    // 폴드 수익률의 산술평균이 아니라, 실제로 계속 굴렸을 때의 연속 곡선으로 평가한다.
    const stitched = stitchSegments(segments);
    const result = runBacktest({ candles: wfCandles, targetPositions: stitched.positions, ...COSTS });
    const metrics = curveMetrics(result.equity, { periodsPerYear });
    const summary = summarize(result);
    const wfe = walkForwardEfficiency(isReturns, oosReturns);
    const gate = evaluateWfGate({
      totalReturnPct: metrics.totalReturnPct,
      maxDrawdownPct: metrics.maxDrawdownPct,
      bhReturnPct: bhMetrics.totalReturnPct,
      tradeCount: summary.tradeCount,
      wfe,
    });

    results.push({ name, metrics, tradeCount: summary.tradeCount, winRatePct: summary.winRatePct, wfe, gate });
  }

  return {
    symbol,
    candles: candles.length,
    folds: folds.length,
    wfSpan: [wfFrom, wfTo],
    bh: bhMetrics,
    results,
  };
}

async function main() {
  console.log(`\n워크포워드 평가 — ${SYMBOLS.join(', ')} · ${INTERVAL} · ${START}~ · ${MODE}`);
  console.log(`  전략 ${Object.keys(GRIDS).length}종 · 조합 ${Object.values(GRIDS).reduce((a, g) => a + g.length, 0)}개 · 폴드 ${FOLD_OPTS.foldCount}`);
  console.log(
    `  체결: ${EXECUTION} · 수수료 ${EXECUTION === 'maker' ? COSTS.makerFeeBps : COSTS.takerFeeBps}bps · ` +
      `${EXECUTION === 'maker' ? `지정가 오프셋 ${COSTS.makerOffsetBps}bps (미체결 위험 반영)` : `슬리피지 ${COSTS.slippageBps}bps`} + 펀딩 실비`
  );
  console.log(`  게이트: 수익>0 · 매수보유 초과 · MDD≤${WF_GATE.maxDrawdownPct}% · 트레이드≥${WF_GATE.minTrades} · WFE≥${WF_GATE.minWfe}`);
  console.log('  ※ 폴드 수익률 평균이 아니라 아웃오브샘플 구간을 이어붙인 연속 곡선으로 평가한다.\n');

  const all = [];
  for (const symbol of SYMBOLS) {
    const r = await runSymbol(symbol);
    if (!r) continue;
    all.push(r);

    console.log(
      `\n■ ${symbol} — ${r.candles}봉 · ${r.folds}폴드 · 이어붙인 검증구간 ${r.wfSpan[1] - r.wfSpan[0]}봉`
    );
    console.log(
      `  매수보유: 수익 ${pct(r.bh.totalReturnPct)} · MDD ${r.bh.maxDrawdownPct.toFixed(1)}% · ` +
        `CAGR ${pct(r.bh.cagrPct)} · 샤프 ${r.bh.sharpe == null ? 'n/a' : r.bh.sharpe.toFixed(2)}`
    );
    console.log(
      `  ${'전략'.padEnd(18)}${'수익'.padStart(10)}${'CAGR'.padStart(10)}${'MDD'.padStart(8)}${'샤프'.padStart(7)}${'WFE'.padStart(7)}${'거래'.padStart(6)}  게이트`
    );
    for (const s of [...r.results].sort((a, b) => b.metrics.totalReturnPct - a.metrics.totalReturnPct)) {
      console.log(
        `  ${s.name.padEnd(18)}${pct(s.metrics.totalReturnPct).padStart(10)}` +
          `${pct(s.metrics.cagrPct).padStart(10)}` +
          `${`${s.metrics.maxDrawdownPct.toFixed(1)}%`.padStart(8)}` +
          `${(s.metrics.sharpe == null ? 'n/a' : s.metrics.sharpe.toFixed(2)).padStart(7)}` +
          `${(s.wfe == null ? 'n/a' : s.wfe.toFixed(2)).padStart(7)}` +
          `${String(s.tradeCount).padStart(6)}  ${s.gate.passes ? '✅' : '❌ ' + s.gate.reasons.length}`
      );
    }
  }

  console.log('\n\n═══ 종합 (이어붙인 워크포워드 곡선 기준) ═══\n');
  const names = Object.keys(GRIDS);
  console.log(`  ${'전략'.padEnd(18)}${'게이트'.padStart(9)}${'평균수익'.padStart(11)}${'중앙수익'.padStart(11)}${'평균MDD'.padStart(9)}${'평균WFE'.padStart(9)}`);

  const overall = names.map((name) => {
    const rows = all.map((a) => a.results.find((r) => r.name === name)).filter(Boolean);
    const rets = rows.map((r) => r.metrics.totalReturnPct).sort((a, b) => a - b);
    const wfes = rows.map((r) => r.wfe).filter((v) => v != null);
    return {
      name,
      passed: rows.filter((r) => r.gate.passes).length,
      total: rows.length,
      meanRet: mean(rets),
      medianRet: rets[Math.floor(rets.length / 2)],
      meanMdd: mean(rows.map((r) => r.metrics.maxDrawdownPct)),
      meanWfe: wfes.length > 0 ? mean(wfes) : null,
    };
  });

  for (const o of [...overall].sort((a, b) => b.passed - a.passed || b.medianRet - a.medianRet)) {
    console.log(
      `  ${o.name.padEnd(18)}${`${o.passed}/${o.total}`.padStart(9)}${pct(o.meanRet).padStart(11)}` +
        `${pct(o.medianRet).padStart(11)}${`${o.meanMdd.toFixed(1)}%`.padStart(9)}` +
        `${(o.meanWfe == null ? 'n/a' : o.meanWfe.toFixed(2)).padStart(9)}`
    );
  }

  // 심볼 과반에서 통과해야 의미가 있다. 한둘에서만 통과한 것은 그 심볼에 맞춰진 결과다.
  const majority = overall.filter((o) => o.total > 0 && o.passed > o.total / 2);
  console.log(
    majority.length === 0
      ? '\n→ 심볼 과반에서 워크포워드 게이트를 통과한 전략 없음.'
      : `\n→ 심볼 과반 통과: ${majority.map((o) => `${o.name} (${o.passed}/${o.total})`).join(', ')}`
  );

  // 가장 흔한 탈락 사유를 세어 다음 시도의 방향을 잡는다.
  const reasonCounts = {};
  for (const a of all) {
    for (const r of a.results) {
      for (const reason of r.gate.reasons) {
        const key = reason.split('(')[0].trim();
        reasonCounts[key] = (reasonCounts[key] || 0) + 1;
      }
    }
  }
  console.log('\n  탈락 사유 빈도:');
  for (const [k, v] of Object.entries(reasonCounts).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${String(v).padStart(4)}회  ${k}`);
  }

  fs.mkdirSync(DATA_DIR, { recursive: true });
  const out = path.join(DATA_DIR, `wf-${SYMBOLS.join('_')}-${INTERVAL}-${MODE}-${EXECUTION}.json`);
  fs.writeFileSync(out, JSON.stringify({ symbols: SYMBOLS, interval: INTERVAL, start: START, mode: MODE, all, overall }, null, 2));
  console.log(`\n결과 저장: ${path.relative(process.cwd(), out)}`);
}

main().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(2);
});
