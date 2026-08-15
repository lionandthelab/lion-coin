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
const { evaluateCandidates, mergeHistory, summarizeArena } = require('../src/paper');

const STATE_PATH = path.join(__dirname, '..', 'harness', 'paper.json');

function firstIndexAtOrAfter(candles, timeMs) {
  const i = candles.findIndex((c) => c.openTime >= timeMs);
  return i === -1 ? candles.length - 1 : i;
}

async function tickSymbol(state, symbol, warmupStart, paperStart, now) {
  const priceOnly = await fetchKlinesRange({
    symbol,
    interval: state.interval,
    startTime: warmupStart,
    endTime: now,
  });
  if (priceOnly.length === 0) throw new Error(`${symbol}: 캔들을 받지 못했습니다`);

  const funding = await fetchFundingRange({ symbol, startTime: warmupStart, endTime: now });
  const candles = attachFunding(priceOnly, funding);

  // 마지막 봉은 아직 진행 중일 수 있다. 닫힌 봉만 쓴다 — 진행 중인 봉의 종가로
  // 판단하면 그 값이 나중에 바뀌므로 사실상 미래를 보는 것과 같다.
  const closed = candles.filter((c) => c.closeTime < now);
  if (closed.length === 0) throw new Error(`${symbol}: 닫힌 봉이 없습니다`);

  const equityFromIndex = firstIndexAtOrAfter(closed, paperStart);
  const rows = evaluateCandidates(state.candidates, closed, state.costs, { equityFromIndex });
  const latest = closed[closed.length - 1];

  return {
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
}

const fmt = (v) => (v == null ? '   n/a' : `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`);

async function main() {
  const state = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));

  const warmupStart = Date.parse(`${state.warmupStart}T00:00:00Z`);
  const paperStart = Date.parse(`${state.paperStart}T00:00:00Z`);
  const now = Date.now();

  const failures = [];
  for (const symbol of state.symbols) {
    try {
      const entry = await tickSymbol(state, symbol, warmupStart, paperStart, now);
      state.series[symbol] ||= { history: [] };
      state.series[symbol].history = mergeHistory(state.series[symbol].history, entry);
    } catch (err) {
      // 한 심볼이 실패해도 나머지는 기록한다 — 한 틱 빠지는 것보다 전부 멈추는 게 나쁘다.
      failures.push(`${symbol}: ${err.message}`);
    }
  }

  state.lastTickAt = new Date(now).toISOString();
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + '\n');

  const days = Math.max(0, Math.floor((now - paperStart) / 86400000));
  console.log(
    `페이퍼 틱 — ${state.symbols.join(', ')} ${state.interval} · ${state.paperStart} 시작 (${days}일차) · 모의, 실거래 아님`
  );
  for (const f of failures) console.log(`  ⚠ ${f}`);

  const arena = summarizeArena(state);
  console.log(
    `  ${'후보'.padEnd(18)}${'평균'.padStart(9)}${'중앙'.padStart(9)}${'최악'.padStart(9)}${'최대MDD'.padStart(9)}${'플러스'.padStart(8)}  포지션`
  );
  for (const a of arena) {
    const pos = a.positions.map((p) => `${p.symbol.replace('USDT', '')}:${p.position > 0 ? 'L' : p.position < 0 ? 'S' : '-'}`).join(' ');
    console.log(
      `  ${a.id.padEnd(18)}${fmt(a.meanReturnPct).padStart(9)}${fmt(a.medianReturnPct).padStart(9)}` +
        `${fmt(a.worstReturnPct).padStart(9)}` +
        `${(a.maxDrawdownPct == null ? '  n/a' : `${a.maxDrawdownPct.toFixed(2)}%`).padStart(9)}` +
        `${`${a.positiveSymbols}/${a.symbolCount}`.padStart(8)}  ${pos}`
    );
  }
}

main().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(2);
});
