#!/usr/bin/env node
'use strict';

// 워크포워드 검증 — 인샘플에서 파라미터를 고르고, 손대지 않은 아웃오브샘플에서 그대로 잰다.
//
// 실행: node scripts/walkforward.js [심볼] [간격] [시작일 YYYY-MM-DD]
// 예:   node scripts/walkforward.js BTCUSDT 1h 2023-01-01
//
// 이 스크립트의 목적은 "좋은 숫자 찾기"가 아니라 "인샘플에서 좋아 보인 것이
// 아웃오브샘플에서도 유지되는지"를 재는 것이다. 두 수치가 크게 벌어지면
// 그건 전략이 아니라 과최적화다 (단타_전략랩_확장_제안서.md §7).

const fs = require('node:fs');
const path = require('node:path');
const { fetchKlinesRange } = require('../src/klines');
const { runBacktest, summarize } = require('../src/backtest');
const { STRATEGIES } = require('../src/strategies');

const SYMBOL = process.argv[2] || 'BTCUSDT';
const INTERVAL = process.argv[3] || '1h';
const START = process.argv[4] || '2023-01-01';

// 단일 70/30 분할은 아웃오브샘플 표본이 하나뿐이라, 그 구간이 어떤 장세였느냐에
// 결론이 통째로 좌우된다. 학습 구간을 늘려가며 다음 구간에서 재는 것을 여러 번
// 반복(앵커드 롤링 워크포워드)해, "몇 번 중 몇 번 통했나"로 본다.
const FOLD_COUNT = 6;
const FIRST_TRAIN_RATIO = 0.4;
const MIN_TRADES = 20; // 표본이 적으면 우연을 실력으로 오독한다

const COSTS = { feeBps: 10, slippageBps: 5, initialEquity: 1000 };

const DATA_DIR = path.join(__dirname, '..', 'data');

async function loadCandles() {
  const cache = path.join(DATA_DIR, `${SYMBOL}-${INTERVAL}-${START}.json`);
  if (fs.existsSync(cache)) {
    const candles = JSON.parse(fs.readFileSync(cache, 'utf8'));
    console.log(`캐시에서 ${candles.length}봉 로드: ${path.relative(process.cwd(), cache)}`);
    return candles;
  }

  const startTime = Date.parse(`${START}T00:00:00Z`);
  const endTime = Date.now();
  process.stdout.write(`바이낸스에서 ${SYMBOL} ${INTERVAL} 수집 중...`);
  const candles = await fetchKlinesRange({
    symbol: SYMBOL,
    interval: INTERVAL,
    startTime,
    endTime,
    onPage: (total) => process.stdout.write(`\r바이낸스에서 ${SYMBOL} ${INTERVAL} 수집 중... ${total}봉`),
  });
  console.log('');

  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(cache, JSON.stringify(candles));
  return candles;
}

// 파라미터 그리드를 데카르트 곱으로 펼친다.
function grid(spec) {
  return Object.entries(spec).reduce(
    (acc, [key, values]) => acc.flatMap((row) => values.map((v) => ({ ...row, [key]: v }))),
    [{}]
  );
}

const GRIDS = {
  emaCross: grid({
    fast: [5, 8, 12, 20, 30],
    slow: [21, 26, 50, 100, 200],
    atrStopMult: [null, 2, 3, 4],
    dailyLossLimitPct: [null, 5],
  }).filter((p) => p.fast < p.slow),

  rsiReversion: grid({
    rsiPeriod: [7, 14, 21],
    buyBelow: [20, 25, 30, 35],
    sellAbove: [60, 65, 70, 75],
    atrStopMult: [null, 2, 3],
    dailyLossLimitPct: [null, 5],
  }),

  donchianBreakout: grid({
    entryLookback: [10, 20, 50, 100],
    exitLookback: [5, 10, 20, 50],
    atrStopMult: [null, 2, 3],
    dailyLossLimitPct: [null, 5],
  }),
};

function evaluate(strategyName, params, candles) {
  const targetPositions = STRATEGIES[strategyName](candles, params);
  return summarize(runBacktest({ candles, targetPositions, ...COSTS }));
}

// 수익률만 보고 고르면 낙폭이 큰 극단값이 뽑힌다. 낙폭 대비 수익(Calmar 유사)으로 고른다.
function score(s) {
  if (s.tradeCount < MIN_TRADES) return -Infinity;
  if (s.totalReturnPct <= 0) return s.totalReturnPct;
  return s.totalReturnPct / Math.max(s.maxDrawdownPct, 1);
}

function buyAndHold(candles) {
  return summarize(
    runBacktest({ candles, targetPositions: candles.map(() => 1), ...COSTS })
  );
}

const pct = (v) => (v == null ? '  n/a' : `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`);
const iso = (ms) => new Date(ms).toISOString().slice(0, 10);

// 앵커드 롤링: 학습 구간은 처음부터 누적하고, 검증 구간만 앞으로 민다.
function buildFolds(total) {
  const testSize = Math.floor((total * (1 - FIRST_TRAIN_RATIO)) / FOLD_COUNT);
  const folds = [];
  for (let k = 0; k < FOLD_COUNT; k += 1) {
    const trainEnd = Math.floor(total * FIRST_TRAIN_RATIO) + k * testSize;
    const testEnd = Math.min(trainEnd + testSize, total);
    if (testEnd - trainEnd < 100) break;
    folds.push({ trainEnd, testEnd });
  }
  return folds;
}

function bestOnTrain(name, params, train) {
  let best = null;
  for (const p of params) {
    const s = evaluate(name, p, train);
    const sc = score(s);
    if (best === null || sc > best.score) best = { params: p, summary: s, score: sc };
  }
  return best;
}

const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;

async function main() {
  const candles = await loadCandles();
  if (candles.length < 500) {
    throw new Error(`봉이 너무 적습니다 (${candles.length}) — 시작일을 앞당기세요`);
  }

  const folds = buildFolds(candles.length);
  const combos = Object.values(GRIDS).reduce((a, g) => a + g.length, 0);

  console.log(`\n${SYMBOL} ${INTERVAL} · 총 ${candles.length}봉 (${iso(candles[0].openTime)} ~ ${iso(candles.at(-1).openTime)})`);
  console.log(`  앵커드 롤링 워크포워드: ${folds.length}개 폴드 · 전략당 ${combos}개 조합 탐색`);
  console.log(`  비용: 수수료 ${COSTS.feeBps}bps + 슬리피지 ${COSTS.slippageBps}bps (진입·청산 양쪽)\n`);

  const byStrategy = Object.fromEntries(Object.keys(GRIDS).map((n) => [n, []]));
  const baseline = [];

  for (const [k, { trainEnd, testEnd }] of folds.entries()) {
    const train = candles.slice(0, trainEnd);
    const test = candles.slice(trainEnd, testEnd);
    const bh = buyAndHold(test);
    baseline.push(bh.totalReturnPct);

    console.log(
      `폴드 ${k + 1}/${folds.length} — 학습 ${train.length}봉 → 검증 ${iso(test[0].openTime)}~${iso(test.at(-1).openTime)} ` +
        `(매수보유 ${pct(bh.totalReturnPct)})`
    );

    for (const [name, params] of Object.entries(GRIDS)) {
      const best = bestOnTrain(name, params, train);
      const out = evaluate(name, best.params, test);
      byStrategy[name].push({ fold: k + 1, params: best.params, train: best.summary, test: out, bh });
      console.log(
        `    ${name.padEnd(18)} 학습 ${pct(best.summary.totalReturnPct).padStart(9)} → ` +
          `검증 ${pct(out.totalReturnPct).padStart(9)}  MDD ${out.maxDrawdownPct.toFixed(1).padStart(5)}%  ` +
          `트레이드 ${String(out.tradeCount).padStart(3)}`
      );
    }
    console.log('');
  }

  console.log('폴드 종합 (검증 구간만 집계)\n');
  console.log(`  ${'전략'.padEnd(18)} ${'평균수익'.padStart(9)} ${'플러스폴드'.padStart(10)} ${'매수보유초과'.padStart(12)} ${'평균괴리'.padStart(9)}`);
  console.log(`  ${'매수보유(기준선)'.padEnd(16)} ${pct(mean(baseline)).padStart(9)}`);

  const verdicts = [];
  for (const [name, rows] of Object.entries(byStrategy)) {
    const tests = rows.map((r) => r.test.totalReturnPct);
    const positives = tests.filter((v) => v > 0).length;
    const beats = rows.filter((r) => r.test.totalReturnPct > r.bh.totalReturnPct).length;
    const gaps = rows.map((r) => r.train.totalReturnPct - r.test.totalReturnPct);
    console.log(
      `  ${name.padEnd(18)} ${pct(mean(tests)).padStart(9)} ${`${positives}/${rows.length}`.padStart(10)} ` +
        `${`${beats}/${rows.length}`.padStart(12)} ${`${mean(gaps).toFixed(1)}%p`.padStart(9)}`
    );
    verdicts.push({ name, meanTest: mean(tests), positives, total: rows.length });
  }

  // 게이트 판정 (확장 제안서 §4-1 중 백테스트로 판정 가능한 항목)
  console.log('\n실거래 착수 게이트 — 백테스트 단계 판정');
  const passed = verdicts.filter((v) => v.meanTest > 0 && v.positives > v.total / 2);
  for (const v of verdicts) {
    const mark = v.meanTest > 0 && v.positives > v.total / 2 ? '✅' : '❌';
    console.log(
      `  ${mark} ${v.name}: 검증 평균 플러스 ${v.meanTest > 0 ? 'O' : 'X'} · ` +
        `과반 폴드 플러스 ${v.positives > v.total / 2 ? 'O' : 'X'} (${v.positives}/${v.total})`
    );
  }
  console.log(
    passed.length === 0
      ? '\n→ 게이트 통과 전략 없음. 페이퍼 트레이딩·실거래 시드 투입 조건을 충족하지 않는다.'
      : `\n→ 게이트 통과: ${passed.map((v) => v.name).join(', ')} — 다음 단계는 페이퍼 30일(E1~E3).`
  );
}

main().catch((err) => {
  console.error(err.message);
  process.exit(2);
});
