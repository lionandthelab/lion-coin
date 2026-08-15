#!/usr/bin/env node
'use strict';

// 포지셔닝 데이터 수집 1틱 — 미결제약정·롱숏비율·테이커 물량비율을 누적한다.
// 실행: npm run collect-positioning  (하네스 회차에서 매일 호출)
//
// 바이낸스는 이 데이터를 최근 30일치만 준다. 캔들과 달리 소급 수집이 불가능하므로
// 빠뜨린 회차는 영구 공백이 된다 — 그래서 실패해도 조용히 넘어가지 않고 로그에 남긴다.

const fs = require('node:fs');
const path = require('node:path');
const { fetchPositioning, mergeSeries, METRICS } = require('../src/positioning');

const STATE_PATH = path.join(__dirname, '..', 'harness', 'positioning.json');

async function main() {
  const state = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
  const failures = [];

  for (const symbol of state.symbols) {
    try {
      const fresh = await fetchPositioning({ symbol, period: state.period, limit: 500 });
      state.series[symbol] ||= {};
      for (const metric of METRICS) {
        state.series[symbol][metric] = mergeSeries(
          state.series[symbol][metric] || [],
          fresh[metric],
          state.maxLen
        );
      }
    } catch (err) {
      failures.push(`${symbol}: ${err.message}`);
    }
  }

  state.lastCollectedAt = new Date().toISOString();
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + '\n');

  console.log(`포지셔닝 수집 — ${state.symbols.join(', ')} · ${state.period}`);
  for (const f of failures) console.log(`  ⚠ ${f}`);
  for (const symbol of state.symbols) {
    const s = state.series[symbol] || {};
    const oi = s.openInterest || [];
    const span = oi.length > 1
      ? `${new Date(oi[0].t).toISOString().slice(0, 16)} ~ ${new Date(oi[oi.length - 1].t).toISOString().slice(0, 16)}`
      : '-';
    console.log(
      `  ${symbol.padEnd(10)} 관측 ${String(oi.length).padStart(5)}건 · ${span}` +
        (oi.length ? ` · 최근 OI ${oi[oi.length - 1].openInterest.toFixed(0)}` : '')
    );
  }
}

main().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(2);
});
