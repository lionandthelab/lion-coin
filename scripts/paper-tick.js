#!/usr/bin/env node
'use strict';

// 페이퍼 트레이딩 1틱 — 최신 캔들을 받아 후보 전략들의 모의 성과를 갱신한다.
// 실행: npm run paper-tick   (하네스 회차에서 매일 1회 호출)
//
// 실주문은 내지 않는다. 이 스크립트는 신호와 모의 체결까지만 계산하며,
// 실거래 집행은 사람이 한다 (단타_전략랩_확장_제안서.md §4-2).
//
// 매 틱마다 전체 이력을 다시 계산한다 — 증분 상태를 이어가면 재실행·중단에서
// 값이 어긋나지만, 다시 계산하면 같은 입력에 늘 같은 결과가 나온다.

const fs = require('node:fs');
const path = require('node:path');
const { fetchKlinesRange } = require('../src/klines');
const { fetchFundingRange, attachFunding } = require('../src/funding');
const { evaluateCandidates, mergeHistory } = require('../src/paper');

const STATE_PATH = path.join(__dirname, '..', 'harness', 'paper.json');

function firstIndexAtOrAfter(candles, timeMs) {
  const i = candles.findIndex((c) => c.openTime >= timeMs);
  return i === -1 ? candles.length - 1 : i;
}

async function main() {
  const state = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));

  const warmupStart = Date.parse(`${state.warmupStart}T00:00:00Z`);
  const paperStart = Date.parse(`${state.paperStart}T00:00:00Z`);
  const now = Date.now();

  const priceOnly = await fetchKlinesRange({
    symbol: state.symbol,
    interval: state.interval,
    startTime: warmupStart,
    endTime: now,
  });
  if (priceOnly.length === 0) {
    throw new Error('캔들을 받지 못했습니다');
  }

  const funding = await fetchFundingRange({
    symbol: state.symbol,
    startTime: warmupStart,
    endTime: now,
  });
  const candles = attachFunding(priceOnly, funding);

  // 마지막 봉은 아직 진행 중일 수 있다. 닫힌 봉만 쓴다 — 진행 중인 봉의 종가로
  // 판단하면 그 값이 나중에 바뀌므로 사실상 미래를 보는 것과 같다.
  const closed = candles.filter((c) => c.closeTime < now);
  if (closed.length === 0) {
    throw new Error('닫힌 봉이 없습니다');
  }

  const equityFromIndex = firstIndexAtOrAfter(closed, paperStart);
  const rows = evaluateCandidates(state.candidates, closed, state.costs, { equityFromIndex });

  const latest = closed[closed.length - 1];
  const entry = {
    candleOpenTime: latest.openTime,
    close: latest.close,
    rows: rows.map((r) => ({
      id: r.id,
      position: r.position,
      equity: Number(r.equity.toFixed(4)),
      totalReturnPct: Number(r.summary.totalReturnPct.toFixed(4)),
      maxDrawdownPct: Number(r.summary.maxDrawdownPct.toFixed(4)),
      tradeCount: r.summary.tradeCount,
    })),
  };

  state.history = mergeHistory(state.history, entry);
  state.lastTickAt = new Date(now).toISOString();
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + '\n');

  console.log(
    `페이퍼 틱 — ${state.symbol} ${state.interval} · 마지막 봉 ${new Date(latest.openTime).toISOString()} ` +
      `· 종가 ${latest.close} · 기록 ${state.history.length}건 (모의, 실거래 아님)`
  );
  for (const r of entry.rows) {
    console.log(
      `  ${r.id.padEnd(20)} 포지션 ${r.position}  수익 ${r.totalReturnPct >= 0 ? '+' : ''}${r.totalReturnPct.toFixed(2)}%  ` +
        `MDD ${r.maxDrawdownPct.toFixed(2)}%  트레이드 ${r.tradeCount}`
    );
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(2);
});
