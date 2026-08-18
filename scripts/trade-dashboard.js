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
  detectBreakout, detectReversal, scoreCandidate, rankCandidates, dropUnclosedCandle,
} = require('../src/scanner');
const { REVIEW_EVERY, shouldReview, reviewTrades, proposeAdjustment } = require('../src/review');
const { runAgentReview } = require('../src/review-runner');
const { marketReturn, isIdiosyncraticDrop } = require('../src/idiosyncratic');
const { openPending, checkFill, summarizeFills } = require('../src/maker-fill');
const { planBracket } = require('../src/bracket');
const { candleChart } = require('../src/chart');
const engine = require('../src/engine');
const trade = require('../src/bithumb-trade');
const { FIELDS, validateConfigPatch } = require('../src/trading-config');
const { intervalToMs } = require('../src/klines');

const PORT = Number(process.env.DASHBOARD_PORT || 8787);
const CONFIG_PATH = path.join(__dirname, '..', 'harness', 'trading.json');

let config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));

// 설정 파일도 화면에서 오는 변경과 똑같이 검증한다. 실제로 있었던 사고: 손절폭을
// 넓히면서 위험 비중을 그대로 둬 계산된 주문 명목이 최소 주문금액 아래로 떨어졌다.
// 파일 로딩은 API 경로를 거치지 않아 이 검증을 건너뛰었고, 신호는 계속 뜨는데 단
// 한 건도 체결되지 않는 상태로 몇 시간을 그대로 돌았다. 시작 시점에 막아야 한다.
{
  const check = validateConfigPatch({}, config);
  if (!check.ok) {
    console.error('harness/trading.json 검증 실패 — 시작하지 않습니다:');
    for (const e of check.errors) console.error(`  - ${e}`);
    process.exit(1);
  }
}

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
// 신호 순간의 호가 폭 기록 — 실거래 판단에 남은 마지막 미지수를 채우는 표본이다.
const spreadLog = [];
// 지정가 체결 추적 — 이 전략의 남은 최대 미지수를 실주문 없이 잰다.
const makerPending = [];
let mktRetLast = null;
// 청산된 거래. 10건마다 복기가 돈다 — 실적을 되짚으려면 청산 결과가 필요하다.
const closedTrades = [];
// 복기 기록. 연속 부진 횟수를 세야 한 번 나빴다고 파라미터를 흔들지 않는다.
const reviews = [];
let consecutiveBadReviews = 0;

// 중앙값을 쓴다. 급락 순간의 호가는 한두 건이 극단적으로 벌어져 평균을 끌고 간다.
function medianSpread() {
  if (spreadLog.length === 0) return null;
  const v = spreadLog.map((x) => x.spreadBps).sort((a, b) => a - b);
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

// ── 복기 ────────────────────────────────────────────────────────────────────

function recordClose(symbol, pos, outcome, returnBps) {
  closedTrades.push({ at: new Date().toISOString(), symbol, outcome, returnBps });
  if (shouldReview(closedTrades.length)) runReview().catch((err) => {
    // 복기 실패가 매매를 멈추면 안 된다 — 복기가 안 되는 것과 전략이 무너진 것은 다르다.
    state = engine.recordError(state, `복기 실패: ${err.message}`);
  });
}

async function runReview() {
  const r = reviewTrades(closedTrades, {
    window: REVIEW_EVERY,
    takeProfitBps: config.takeProfitBps,
    stopLossBps: config.stopLossBps,
    costBps: config.feeBps * 2 + config.maxSpreadBps,
  });
  if (r.belowBreakeven) consecutiveBadReviews += 1;
  else consecutiveBadReviews = 0;

  // 규칙 기반 판정이 먼저다. 중단 판단은 모델을 기다리지 않는다.
  const rule = proposeAdjustment(r, { consecutiveBadReviews });

  // 그 다음 에이전트. 규칙이 미리 정한 질문에만 답하는 반면 이쪽은 코드 구조까지 본다.
  const agent = await runAgentReview({
    review: r,
    config: publicConfig(),
    trades: closedTrades.slice(-REVIEW_EVERY),
    history:
      '이 프로젝트는 68~114일 표본에서 유의해 보이던 신호 우위가 455일 4037거래 재검증에서 ' +
      '사라진 이력이 있다 (순기대값 -22bps, 시각 대응 대조군 대비 기여 +5.2±3.1bps로 유의하지 않음). ' +
      '짧은 표본의 우위를 믿지 말 것. 상세: docs/reversal-validation.md',
  });

  const entry = { at: new Date().toISOString(), n: closedTrades.length, review: r, rule, agent };
  reviews.push(entry);
  if (reviews.length > 50) reviews.shift();

  // 중단은 어느 쪽이든 하나만 요구해도 멈춘다. 멈추는 방향은 되돌릴 수 있다.
  if (rule.action === 'halt' || (agent.ok && agent.halt)) {
    state = engine.transition(state, 'stopped');
    stopLoop();
    return;
  }

  // 파라미터 조정은 게이트를 통과한 것만. 규칙과 에이전트가 모두 제안하면 규칙을 따른다 —
  // 규칙은 결정론적이라 나중에 왜 그렇게 됐는지 재현할 수 있다.
  const patch = rule.action === 'adjust' ? rule.patch : agent.ok ? agent.autoApplied : null;
  if (patch) {
    const v = validateConfigPatch(patch, config);
    if (v.ok) {
      config = v.config;
      entry.applied = patch;
    } else {
      entry.applyErrors = v.errors;
    }
  }
}

// ── 스캔 ────────────────────────────────────────────────────────────────────

async function scanOnce() {
  const universe = (await bithumb.fetchTickerAll())
    .filter((m) => m.tradeValue24h >= config.minTradeValue24h)
    .slice(0, config.maxSymbols);

  const candidates = [];
  const signals = [];

  // 1패스: 캔들·호가를 모아 **그 봉의 시장 수익률**을 먼저 구한다.
  // 고유 하락 판정에 시장이 필요한데, 종목을 하나씩 보면서는 알 수 없다.
  const fetched = [];
  for (const m of universe) {
    try {
      const [raw, book] = await Promise.all([
        bithumb.fetchCandles({ symbol: m.symbol, interval: config.interval }),
        bithumb.fetchOrderbook(m.symbol),
      ]);
      fetched.push({ m, raw, book });
    } catch (err) {
      state = engine.recordError(state, `${m.symbol}: ${err.message}`);
    }
  }

  const closedFor = (raw) => dropUnclosedCandle(raw, intervalToMs(config.interval));
  const mktBars = [];
  for (const f of fetched) {
    const c = closedFor(f.raw);
    if (c.length >= 2) mktBars.push({ prevClose: c[c.length - 2].close, close: c[c.length - 1].close });
  }
  const mktRet = marketReturn(mktBars, { minSymbols: 15 });
  mktRetLast = mktRet;

  // 대기 중인 지정가의 체결 여부를 갱신한다 (실주문 없이 캔들로 판정).
  for (const f of fetched) {
    const c = closedFor(f.raw);
    if (!c.length) continue;
    for (let k = 0; k < makerPending.length; k += 1) {
      const p = makerPending[k];
      if (p.symbol !== f.m.symbol || p.filled || p.expired) continue;
      if (c[c.length - 1].openTime <= p.signalBarTime) continue; // 같은 봉은 세지 않는다
      makerPending[k] = { ...checkFill(p, c[c.length - 1]), signalBarTime: c[c.length - 1].openTime };
    }
  }

  // 2패스: 신호 판정
  for (const { m, raw, book } of fetched) {
    try {
      // 진행 중인 봉을 버려야 백테스트와 같은 전략이 된다.
      const candles = dropUnclosedCandle(raw, intervalToMs(config.interval));

      // 전략에 따라 진입 조건이 정반대가 된다. 아래 로직은 신호 종류를 모른 채
      // 같은 모양을 받으므로 여기서만 갈린다.
      const detect = config.strategy === 'breakout' ? detectBreakout : detectReversal;
      const breakout = detect(candles, {
        lookback: config.lookback,
        volMult: config.volMult,
      });

      const spread = bithumb.spreadBps(book);
      // 남은 단 하나의 미지수를 여기서 채운다: **신호가 뜬 그 순간의 호가 폭.**
      // 백테스트는 평시 스냅샷 스프레드를 썼는데, 진입 시점은 하필 거래량이 폭발한
      // 급락 직후다. 평시보다 13bps만 넓어도 전략이 손실로 뒤집힌다
      // (docs/reversal-validation.md §3). 소급 측정이 불가능하므로 지금부터 쌓는다.
      // 스프레드 상한에 걸려 탈락한 신호도 기록해야 표본이 한쪽으로 치우치지 않는다.
      // ── 고유 하락 층 ──
      // 이 층 하나가 우위를 +6.5bps에서 +14.5bps로 바꾼다 (docs/venue-and-data.md §9).
      // 시장과 같이 빠진 것은 정보라 되돌아오지 않는다 — 여기서 걸러낸다.
      const own = candles.length >= 2
        ? (candles[candles.length - 1].close / candles[candles.length - 2].close - 1) * 10000
        : null;
      const idio = own != null && isIdiosyncraticDrop({
        ownReturnBps: own, marketReturnBps: mktRet, threshold: config.excessDropBps,
      });
      if (breakout.isBreakout && !idio) {
        breakout.isBreakout = false;
        breakout.rejectedBy = '시장과 같이 하락 — 고유 하락이 아님';
      }

      if (breakout.isBreakout) {
        // 신호 순간 매수호가에 걸었다면 체결됐을지 추적한다.
        try {
          makerPending.push({
            ...openPending({ symbol: m.symbol, at: Date.now(), bid: book.bid, ask: book.ask, expireBars: 4 }),
            signalBarTime: candles[candles.length - 1].openTime,
          });
          if (makerPending.length > 500) makerPending.shift();
        } catch { /* 호가가 뒤집힌 순간은 표본에서 뺀다 */ }

        spreadLog.push({
          at: new Date().toISOString(),
          symbol: m.symbol,
          spreadBps: spread,
          volumeRatio: breakout.volumeRatio,
          rejectedForSpread: spread > config.maxSpreadBps,
        });
        if (spreadLog.length > 2000) spreadLog.shift();
      }

      const c = scoreCandidate({
        symbol: m.symbol,
        breakout,
        spreadBps: spread,
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
              label: `${m.symbol} ${config.strategy === 'breakout' ? '돌파' : '반전'} 포착`,
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
          recordClose(symbol, pos, 'tp', config.takeProfitBps - pos.costBps);
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
        recordClose(symbol, pos, 'sl', -config.stopLossBps - pos.costBps);
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
      // 신호 순간의 호가 폭 — 실거래 판단에 남은 마지막 미지수. 평시 대비 얼마나
      // 넓어지는지가 +12.7bps의 여유를 먹느냐를 결정한다.
      spreadSamples: spreadLog.length,
      spreadMedianBps: medianSpread(),
      spreadLog: spreadLog.slice(-30).reverse(),
      // 복기 섹션 — 10거래마다 무엇을 보고 무엇을 했는지.
      reviewEvery: REVIEW_EVERY,
      closedCount: closedTrades.length,
      untilReview: REVIEW_EVERY - (closedTrades.length % REVIEW_EVERY),
      consecutiveBadReviews,
      reviews: reviews.slice(-10).reverse(),
      // 고유 하락 층 + 지정가 체결 실측
      marketReturnBps: mktRetLast,
      makerFill: summarizeFills(makerPending),
      makerPendingOpen: makerPending.filter((p) => !p.filled && !p.expired).length,
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
