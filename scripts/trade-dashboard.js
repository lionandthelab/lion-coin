#!/usr/bin/env node
'use strict';

// 실시간 매매 대시보드 — 로컬 웹서버.
// 실행: npm run dashboard   (기본 http://localhost:8787)
//
// ⚠ 안전 규약
//   - 기본 모드는 stopped. 시작 버튼은 **모의(dry)**로만 들어간다.
//   - 실거래(live)는 .env의 BITHUMB_LIVE=1 승인과 화면에서의 명시적 확인이
//     **둘 다** 있어야 전환된다.
//   - API 키·시크릿은 이 프로세스 밖으로 나가지 않는다. 응답·로그·화면 어디에도
//     실리지 않으며, summarize()가 허용된 키만 노출한다.

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const bithumb = require('../src/bithumb');
const { detectBreakout, scoreCandidate, rankCandidates } = require('../src/scanner');
const { planBracket } = require('../src/bracket');
const engine = require('../src/engine');

const PORT = Number(process.env.DASHBOARD_PORT || 8787);
const CONFIG_PATH = path.join(__dirname, '..', 'harness', 'trading.json');

const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));

// 실거래 승인은 환경변수로만 켤 수 있다. 화면에서 켤 수 없게 한 것이 요점이다.
const LIVE_APPROVED = process.env.BITHUMB_LIVE === '1';
const HAS_KEYS = Boolean(process.env.BITHUMB_API_KEY && process.env.BITHUMB_SECRET_KEY);

let state = engine.createEngineState();
let scanTimer = null;

// ── 스캔 ────────────────────────────────────────────────────────────────────

async function scanOnce() {
  const universe = (await bithumb.fetchTickerAll())
    .filter((m) => m.tradeValue24h >= config.minTradeValue24h)
    .slice(0, config.maxSymbols);

  const candidates = [];
  const signals = [];

  for (const m of universe) {
    try {
      const [candles, book] = await Promise.all([
        bithumb.fetchCandles({ symbol: m.symbol, interval: config.interval }),
        bithumb.fetchOrderbook(m.symbol),
      ]);

      const breakout = detectBreakout(candles, {
        lookback: config.lookback,
        volMult: config.volMult,
      });

      const c = scoreCandidate({
        symbol: m.symbol,
        breakout,
        spreadBps: bithumb.spreadBps(book),
        feeBpsRoundTrip: config.feeBps * 2,
        takeProfitBps: config.takeProfitBps,
        stopLossBps: config.stopLossBps,
        tradeValue24h: m.tradeValue24h,
        minTradeValue24h: config.minTradeValue24h,
        maxSpreadBps: config.maxSpreadBps,
        maxBreakevenWinRate: config.maxBreakevenWinRate,
      });
      candidates.push(c);

      if (c.executable) {
        const plan = planBracket({
          entryPrice: book.ask, // 시장가 진입 가정 — 매도호가를 친다
          takeProfitBps: config.takeProfitBps,
          stopLossBps: config.stopLossBps,
          capital: config.capitalKrw,
          riskPct: config.riskPct,
          costBps: c.costBps,
        });
        if (plan.executable) {
          signals.push({
            at: new Date().toISOString(),
            symbol: m.symbol,
            mode: state.mode,
            score: c.score,
            entry: plan.entryPrice,
            takeProfit: plan.takeProfitPrice,
            stopLoss: plan.stopLossPrice,
            quantity: plan.quantity,
            notional: plan.notional,
            breakevenWinRate: plan.breakevenWinRate,
            costBps: c.costBps,
            // dry에서는 여기까지. live 전환 시 주문 전송 모듈이 이 신호를 받는다.
            dispatched: false,
          });
        }
      }
    } catch (err) {
      state = engine.recordError(state, `${m.symbol}: ${err.message}`);
    }
  }

  state = engine.applyScan(state, { candidates, signals });
}

function startLoop() {
  if (scanTimer) return;
  const tick = async () => {
    if (state.mode === 'stopped') return;
    try {
      await scanOnce();
    } catch (err) {
      state = engine.recordError(state, err.message);
    }
  };
  tick();
  scanTimer = setInterval(tick, config.scanIntervalSec * 1000);
}

function stopLoop() {
  if (scanTimer) clearInterval(scanTimer);
  scanTimer = null;
}

// ── HTTP ────────────────────────────────────────────────────────────────────

function json(res, code, body) {
  const payload = JSON.stringify(body);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
      if (raw.length > 10000) req.destroy();
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(raw || '{}'));
      } catch {
        resolve({});
      }
    });
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (url.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(fs.readFileSync(path.join(__dirname, '..', 'harness', 'dashboard.html'), 'utf8'));
    return;
  }

  if (url.pathname === '/api/state') {
    json(res, 200, {
      summary: engine.summarize(state),
      config: {
        // 설정만 노출한다. 키는 여기 없다.
        interval: config.interval,
        maxSymbols: config.maxSymbols,
        lookback: config.lookback,
        volMult: config.volMult,
        takeProfitBps: config.takeProfitBps,
        stopLossBps: config.stopLossBps,
        feeBps: config.feeBps,
        capitalKrw: config.capitalKrw,
        riskPct: config.riskPct,
        scanIntervalSec: config.scanIntervalSec,
        minTradeValue24h: config.minTradeValue24h,
        maxSpreadBps: config.maxSpreadBps,
        maxBreakevenWinRate: config.maxBreakevenWinRate,
      },
      liveApproved: LIVE_APPROVED,
      hasKeys: HAS_KEYS,
      // 주문 전송 모듈은 아직 없다. 버튼이 거래하는 것처럼 보이면 안 되므로
      // 화면이 이 값을 보고 비활성화한다.
      orderDispatchReady: false,
      top: rankCandidates(state.candidates, 20),
      blocked: state.candidates
        .filter((c) => !c.executable && c.reason !== '돌파 조건 미충족')
        .slice(0, 20),
      signals: state.signals.slice(-30).reverse(),
      errors: state.errors.slice(-10).reverse(),
    });
    return;
  }

  if (url.pathname === '/api/mode' && req.method === 'POST') {
    const body = await readBody(req);
    const r = engine.transition(state, body.mode, {
      liveApproved: LIVE_APPROVED,
      confirmLive: body.confirmLive === true,
    });
    if (!r.ok) {
      json(res, 400, { ok: false, reason: r.reason });
      return;
    }
    state = r.state;
    if (state.mode === 'stopped') stopLoop();
    else startLoop();
    json(res, 200, { ok: true, mode: state.mode });
    return;
  }

  json(res, 404, { error: 'not found' });
});

server.listen(PORT, () => {
  console.log(`매매 대시보드: http://localhost:${PORT}`);
  console.log(`  모드: stopped (시작 버튼은 모의로만 진입)`);
  console.log(`  API 키: ${HAS_KEYS ? '설정됨' : '없음'} · 실거래 승인: ${LIVE_APPROVED ? '켜짐' : '꺼짐'}`);
  console.log(`  대상: 거래대금 ${(config.minTradeValue24h / 1e8).toFixed(0)}억원 이상 상위 ${config.maxSymbols}종목`);
});
