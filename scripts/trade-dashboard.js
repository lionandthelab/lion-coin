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
const {
  detectBreakout, scoreCandidate, rankCandidates, dropUnclosedCandle,
} = require('../src/scanner');
const { planBracket } = require('../src/bracket');
const { candleChart } = require('../src/chart');
const engine = require('../src/engine');
const trade = require('../src/bithumb-trade');
const { FIELDS, validateConfigPatch } = require('../src/trading-config');
const { intervalToMs } = require('../src/klines');

const PORT = Number(process.env.DASHBOARD_PORT || 8787);
const CONFIG_PATH = path.join(__dirname, '..', 'harness', 'trading.json');

let config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));

// 화면에 내보낼 설정만 추린다 — note·rationale은 문서용이라 편집 대상이 아니다.
function publicConfig() {
  return Object.fromEntries(Object.keys(FIELDS).map((k) => [k, config[k]]));
}

// 실거래 승인은 환경변수로만 켤 수 있다. 화면에서 켤 수 없게 한 것이 요점이다.
const LIVE_APPROVED = process.env.BITHUMB_LIVE === '1';
const HAS_KEYS = Boolean(process.env.BITHUMB_API_KEY && process.env.BITHUMB_SECRET_KEY);

let state = engine.createEngineState();
let scanTimer = null;
// 열린 포지션. live에서만 채워지며, 청산될 때까지 같은 종목에 다시 진입하지 않는다.
const positions = new Map();

// ── 스캔 ────────────────────────────────────────────────────────────────────

async function scanOnce() {
  const universe = (await bithumb.fetchTickerAll())
    .filter((m) => m.tradeValue24h >= config.minTradeValue24h)
    .slice(0, config.maxSymbols);

  const candidates = [];
  const signals = [];

  for (const m of universe) {
    try {
      const [raw, book] = await Promise.all([
        bithumb.fetchCandles({ symbol: m.symbol, interval: config.interval }),
        bithumb.fetchOrderbook(m.symbol),
      ]);
      // 진행 중인 봉을 버려야 백테스트와 같은 전략이 된다.
      const candles = dropUnclosedCandle(raw, intervalToMs(config.interval));

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
            volumeRatio: breakout.volumeRatio,
            breakoutLevel: breakout.level,
            // 포착된 이유를 나중에 눈으로 확인할 수 있도록 그 순간의 캔들 창을
            // 함께 저장한다. 신호만 남기면 "왜 잡혔는지"를 되짚을 수 없다.
            chart: candleChart(candles.slice(-60), {
              breakoutLevel: breakout.level,
              takeProfit: plan.takeProfitPrice,
              stopLoss: plan.stopLossPrice,
              highlightLast: true,
              showVolume: true,
              label: `${m.symbol} 돌파 포착`,
            }),
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

  if (state.mode === 'live') {
    await manageOpenPositions();
    await dispatchEntries(signals);
  }
}

// ── 실주문 (mode === 'live'에서만 호출된다) ─────────────────────────────────

async function dispatchEntries(signals) {
  if (positions.size >= config.maxConcurrentPositions) return;

  // 점수가 가장 높은 신호 하나만 집행한다. 자본이 작아 분산이 오히려 최소 주문
  // 미달을 만든다.
  const best = signals
    .filter((g) => !positions.has(g.symbol))
    .sort((a, b) => b.score - a.score)[0];
  if (!best) return;

  try {
    const acct = await trade.getAccounts();
    const krwAmount = Math.floor(Math.min(best.notional, acct.krw * 0.99));
    if (krwAmount < config.minNotionalKrw) {
      state = engine.recordError(state, `${best.symbol}: 주문 금액 ${krwAmount}원 < 최소 ${config.minNotionalKrw}원`);
      return;
    }

    // 시장가 매수 — 금액만 넣는다. 돌파 직후는 지정가가 안 붙을 수 있다.
    const order = await trade.placeOrder(
      trade.buildEntryOrder({ symbol: best.symbol, krwAmount, ordType: 'price' })
    );

    positions.set(best.symbol, {
      symbol: best.symbol,
      entryUuid: order.uuid,
      entryAt: new Date().toISOString(),
      takeProfit: best.takeProfit,
      stopLoss: best.stopLoss,
      krwAmount,
      volume: null, // 체결 확인 후 채워진다
      tpUuid: null,
    });
    state.orders.push({
      at: new Date().toISOString(), symbol: best.symbol, side: 'bid',
      uuid: order.uuid, krwAmount, kind: 'entry',
    });
    best.dispatched = true;
  } catch (err) {
    state = engine.recordError(state, `진입 실패 ${best.symbol}: ${err.message}`);
  }
}

// 체결된 포지션에 익절 지정가를 걸고, 손절선을 감시한다.
async function manageOpenPositions() {
  for (const [symbol, pos] of positions) {
    try {
      // 진입 체결 수량 확인 → 익절 지정가 등록
      if (!pos.volume) {
        const o = await trade.getOrder(pos.entryUuid);
        const filled = Number(o.executed_volume || 0);
        if (filled <= 0) continue;
        pos.volume = filled;

        const tp = await trade.placeOrder(
          trade.buildExitOrder({ symbol, price: Math.round(pos.takeProfit), volume: filled, ordType: 'limit' })
        );
        pos.tpUuid = tp.uuid;
        state.orders.push({
          at: new Date().toISOString(), symbol, side: 'ask', uuid: tp.uuid,
          price: pos.takeProfit, volume: filled, kind: 'take-profit',
        });
        continue;
      }

      // 익절 체결 확인
      if (pos.tpUuid) {
        const tpOrder = await trade.getOrder(pos.tpUuid);
        if (tpOrder.state === 'done') {
          positions.delete(symbol);
          continue;
        }
      }

      // 손절 감시 — 지정가로 걸어둘 수 없으므로 현재가를 보고 시장가로 청산한다.
      const book = await bithumb.fetchOrderbook(symbol);
      if (book.bid <= pos.stopLoss) {
        if (pos.tpUuid) await trade.cancelOrder(pos.tpUuid).catch(() => {});
        const sl = await trade.placeOrder(
          trade.buildExitOrder({ symbol, volume: pos.volume, ordType: 'market' })
        );
        state.orders.push({
          at: new Date().toISOString(), symbol, side: 'ask', uuid: sl.uuid,
          volume: pos.volume, kind: 'stop-loss',
        });
        positions.delete(symbol);
      }
    } catch (err) {
      state = engine.recordError(state, `포지션 관리 ${symbol}: ${err.message}`);
    }
  }
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
      // 설정만 노출한다. 키는 여기 없다.
      config: publicConfig(),
      fields: FIELDS,
      liveApproved: LIVE_APPROVED,
      hasKeys: HAS_KEYS,
      orderDispatchReady: true,
      positions: [...positions.values()].map((p) => ({
        symbol: p.symbol, entryAt: p.entryAt, krwAmount: p.krwAmount,
        volume: p.volume, takeProfit: p.takeProfit, stopLoss: p.stopLoss,
      })),
      orders: state.orders.slice(-20).reverse(),
      top: rankCandidates(state.candidates, 20),
      blocked: state.candidates
        .filter((c) => !c.executable && c.reason !== '돌파 조건 미충족')
        .slice(0, 20),
      // 차트가 붙은 신호는 응답이 커진다 — 최근 것만 그림을 싣고 나머지는 표로만 본다.
      signals: state.signals.slice(-30).reverse().map((g, i) => (i < 8 ? g : { ...g, chart: null })),
      errors: state.errors.slice(-10).reverse(),
    });
    return;
  }

  if (url.pathname === '/api/config' && req.method === 'POST') {
    // 포지션이 열려 있는 동안 자본·손절을 바꾸면 이미 나간 주문과 앞뒤가 안 맞는다.
    if (positions.size > 0) {
      json(res, 409, { ok: false, errors: ['열린 포지션이 있어 설정을 바꿀 수 없습니다. 청산 후 다시 시도하세요.'] });
      return;
    }

    const patch = await readBody(req);
    const r = validateConfigPatch(patch, config);
    if (!r.ok) {
      json(res, 400, { ok: false, errors: r.errors });
      return;
    }

    // 문서 필드(note·rationale)는 그대로 두고 값만 갈아끼운다.
    config = { ...config, ...r.config };
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n');

    // 스캔 주기가 바뀌었으면 타이머를 다시 건다.
    if (state.mode !== 'stopped') {
      stopLoop();
      startLoop();
    }
    json(res, 200, { ok: true, config: publicConfig() });
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
  console.log(`  자본 ${config.capitalKrw.toLocaleString()}원 · 위험 ${config.riskPct}% · 동시 포지션 ${config.maxConcurrentPositions}개`);
  console.log('  ⚠ 실거래 스위치는 화면에 있습니다. 이 프로세스는 스스로 live로 전환하지 않습니다.');
});
