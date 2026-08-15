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
const { grid, buildFolds, scoreSummary, aggregate, mean } = require('../src/research');

const SYMBOLS = (process.argv[2] || 'BTCUSDT').split(',').map((s) => s.trim().toUpperCase());
const INTERVAL = process.argv[3] || '4h';
const START = process.argv[4] || '2023-01-01';

// 무기한 선물 전제이므로 펀딩 비용을 문다. 빼면 장기 보유 전략이 실제보다 좋아 보인다.
const COSTS = { feeBps: 10, slippageBps: 5, initialEquity: 1000, fundingCost: true };
const FOLD_OPTS = { foldCount: 6, firstTrainRatio: 0.4, minTestSize: 100 };
const SCORE_OPTS = { minTrades: 15 };

const DATA_DIR = path.join(__dirname, '..', 'data');

// 손절·일일 한도는 격자에서 제외하고 고정한다. 1차 검증에서 최적화기가
// 세 전략 모두의 손절을 꺼버렸기 때문이다 (docs/walkforward-report.md §3).
const FIXED_RISK = { atrStopMult: 3, dailyLossLimitPct: 5 };
const withRisk = (rows) => rows.map((p) => ({ ...p, ...FIXED_RISK }));

const GRIDS = {
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

  const byStrategy = Object.fromEntries(Object.keys(GRIDS).map((n) => [n, []]));
  const bhReturns = [];

  for (const { trainEnd, testEnd } of folds) {
    const train = candles.slice(0, trainEnd);
    const test = candles.slice(trainEnd, testEnd);
    const bh = buyAndHold(test);
    bhReturns.push(bh.totalReturnPct);

    for (const [name, params] of Object.entries(GRIDS)) {
      let best = null;
      for (const p of params) {
        const s = evaluate(name, p, train);
        const sc = scoreSummary(s, SCORE_OPTS);
        if (best === null || sc > best.score) best = { params: p, summary: s, score: sc };
      }
      byStrategy[name].push({
        params: best.params,
        train: best.summary,
        test: evaluate(name, best.params, test),
        bh,
      });
    }
  }

  const results = Object.entries(byStrategy).map(([name, rows]) => ({
    name,
    ...aggregate(rows),
    rows,
  }));

  return { symbol, candles: candles.length, folds: folds.length, bhMeanPct: mean(bhReturns), results };
}

async function main() {
  console.log(`\n연구 캠페인 — ${SYMBOLS.join(', ')} · ${INTERVAL} · ${START}~`);
  console.log(`  전략 ${Object.keys(GRIDS).length}종 · 조합 ${Object.values(GRIDS).reduce((a, g) => a + g.length, 0)}개`);
  console.log(`  비용: 수수료 ${COSTS.feeBps}bps + 슬리피지 ${COSTS.slippageBps}bps + 펀딩 실비\n`);

  const all = [];
  for (const symbol of SYMBOLS) {
    const r = await runSymbol(symbol);
    if (!r) continue;
    all.push(r);

    console.log(`\n■ ${symbol} — ${r.candles}봉 · ${r.folds}폴드 · 매수보유 평균 ${pct(r.bhMeanPct)}`);
    console.log(`  ${'전략'.padEnd(18)}${'검증평균'.padStart(9)}${'플러스폴드'.padStart(9)}${'BH초과'.padStart(8)}${'평균괴리'.padStart(10)}  게이트`);
    for (const s of [...r.results].sort((a, b) => b.meanTestPct - a.meanTestPct)) {
      console.log(
        `  ${s.name.padEnd(18)}${pct(s.meanTestPct).padStart(9)}` +
          `${`${s.positiveFolds}/${s.totalFolds}`.padStart(9)}` +
          `${`${s.beatsBhFolds}/${s.totalFolds}`.padStart(8)}` +
          `${`${s.meanGapPct.toFixed(1)}%p`.padStart(10)}  ${s.passesGate ? '✅' : '❌'}`
      );
    }
  }

  // 심볼을 가로질러 일관되게 통과한 전략만 의미가 있다. 한 심볼에서만 통과한 것은
  // 그 심볼에 맞춘 결과일 가능성이 높다.
  console.log('\n\n═══ 종합 ═══\n');
  const names = Object.keys(GRIDS);
  console.log(`  ${'전략'.padEnd(18)}${'심볼별 게이트'.padStart(14)}${'전체 검증평균'.padStart(14)}`);
  const overall = [];
  for (const name of names) {
    const rows = all.map((a) => a.results.find((r) => r.name === name)).filter(Boolean);
    const passed = rows.filter((r) => r.passesGate).length;
    const m = mean(rows.map((r) => r.meanTestPct));
    overall.push({ name, passed, total: rows.length, meanTestPct: m });
  }
  for (const o of [...overall].sort((a, b) => b.passed - a.passed || b.meanTestPct - a.meanTestPct)) {
    console.log(
      `  ${o.name.padEnd(18)}${`${o.passed}/${o.total}`.padStart(14)}${pct(o.meanTestPct).padStart(14)}`
    );
  }

  const allPass = overall.filter((o) => o.passed === o.total && o.total > 0);
  console.log(
    allPass.length === 0
      ? '\n→ 모든 심볼에서 게이트를 통과한 전략 없음.'
      : `\n→ 전 심볼 게이트 통과: ${allPass.map((o) => o.name).join(', ')}`
  );

  fs.mkdirSync(DATA_DIR, { recursive: true });
  const out = path.join(DATA_DIR, `research-${SYMBOLS.join('_')}-${INTERVAL}.json`);
  fs.writeFileSync(out, JSON.stringify({ symbols: SYMBOLS, interval: INTERVAL, start: START, all, overall }, null, 2));
  console.log(`\n결과 저장: ${path.relative(process.cwd(), out)}`);
}

main().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(2);
});
