#!/usr/bin/env node
'use strict';

// 유목민식 이벤트 기반 단타 데몬 — 재료 수집 → 분별 → 매매 → 알림.
// 실행: npm run event   (기본 http://localhost:8788)
//
// 유목민식 매매란: 아직 시장에 퍼지지 않은 재료(공시·속보)를 빠르게 포착하고,
// 재료의 급을 분별하고, 기대감과 시황을 고려해 손절·익절을 정하고,
// 짧게 기계적으로 실현하는 이벤트 매매법이다.
//
// ⚠ 안전 규약 (통계 전략 대시보드와 동일)
//   - 기본 모드는 stopped. 시작 버튼은 **감시(watching)**로만 들어간다.
//   - 실거래(live)는 .env의 BITHUMB_LIVE=1 승인과 화면에서의 명시적 확인이
//     **둘 다** 있어야 전환된다. 이 프로세스는 스스로 live로 가지 않는다.
//   - API 키·텔레그램 토큰은 이 프로세스 밖으로 나가지 않는다.
//
// **감시 모드에서도 가상 포지션을 만들어 끝까지 추적한다.** 거래소 공지 API는 과거를
// 소급 제공하지 않아 이 전략은 백테스트가 불가능하다. 감시 모드의 기록이 그 자리를
// 대신한다 — 재료가 실제로 얼마나 움직이는지 표본이 쌓여야 실거래를 판단할 수 있다.

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const bithumb = require('../src/bithumb');
const trade = require('../src/bithumb-trade');
const material = require('../src/material');
const sources = require('../src/event-sources');
const eventPlan = require('../src/event-plan');
const fsm = require('../src/event-engine');
const telegram = require('../src/telegram');

const PORT = Number(process.env.EVENT_PORT || 8788);
const CONFIG_PATH = path.join(__dirname, '..', 'harness', 'event-trading.json');
const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));

const LIVE_APPROVED = process.env.BITHUMB_LIVE === '1';
const HAS_KEYS = Boolean(process.env.BITHUMB_API_KEY && process.env.BITHUMB_SECRET_KEY);
const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TG_CHAT = process.env.TELEGRAM_CHAT_ID;
const TG_ON = Boolean(config.telegramEnabled && TG_TOKEN && TG_CHAT);

const GRADE_RANK = { S: 4, A: 3, B: 2, C: 1 };

let mode = 'stopped'; // stopped | watching | live
let state = fsm.createEventState();
let pollTimer = null;
let tickTimer = null;

// dedupeNewEvents는 전달받은 Set을 변경하지 않고 **새 Set을 돌려준다.** 반환값을
// 다시 대입하지 않으면 seenIds가 영원히 비어 있어, 신선한 재료를 폴링 주기마다
// 반복 매매하게 된다. 그래서 const가 아니라 let이다.
let seenIds = new Set();
// 첫 폴링은 기준선만 세운다. 처음 켠 순간 응답 전체가 "처음 보는 것"이라
// 27일 전 공지까지 새 재료로 잡혔던 사고가 있었다(2026-08-21).
let primed = false;
const events = [];      // 화면에 보여줄 최근 재료
const trades = [];      // 오늘 체결(또는 모의 체결)
const errors = [];
const srcHealth = new Map();
let knownSymbols = [];
let lastSymbolFetch = 0;
let marketContext = { regime: 'neutral', multiplier: 1, reason: '아직 평가 전' };
let tgLastSentAt = null;

function recordError(message) {
  errors.unshift({ at: Date.now(), message: String(message).slice(0, 300) });
  if (errors.length > 30) errors.pop();
}

// 텔레그램 실패가 매매를 멈추면 안 된다 — 알림이 안 가는 것과 전략이 무너진 것은 다르다.
async function notify(text) {
  if (!TG_ON) return;
  try {
    await telegram.sendMessage({ token: TG_TOKEN, chatId: TG_CHAT, text });
    tgLastSentAt = Date.now();
  } catch (err) {
    recordError(`텔레그램 전송 실패: ${err.message}`);
  }
}

// 재료 분별은 실제 거래 가능한 심볼과 대조해야 한다. 그러지 않으면 제목 속
// "(USDT 마켓)", "(완료)" 같은 괄호를 티커로 오인한다.
async function refreshSymbols() {
  if (Date.now() - lastSymbolFetch < 10 * 60 * 1000 && knownSymbols.length) return;
  try {
    const t = await bithumb.fetchTickerAll();
    knownSymbols = t.map((m) => m.symbol);
    lastSymbolFetch = Date.now();
  } catch (err) {
    recordError(`심볼 목록 갱신 실패: ${err.message}`);
  }
}

// 시황 — 재료가 얼마나 먹힐지를 좌우한다. 같은 공지도 상승장과 하락장에서 반응이 다르다.
async function refreshMarketContext() {
  try {
    const t = await bithumb.fetchTickerAll();
    const btc = t.find((m) => m.symbol === 'BTC');
    const ups = t.filter((m) => typeof m.changeRate === 'number' && m.changeRate > 0).length;
    marketContext = eventPlan.assessMarketContext({
      btcChange24hBps: btc && typeof btc.changeRate === 'number' ? btc.changeRate * 10000 : 0,
      breadthPct: t.length ? (ups / t.length) * 100 : 50,
    });
  } catch (err) {
    recordError(`시황 평가 실패: ${err.message}`);
  }
}

const SOURCE_FETCHERS = {
  upbit: () => sources.fetchUpbitNotices({ limit: 30 }),
  bithumb: () => sources.fetchBithumbNotices({ limit: 30 }),
  blockmedia: () => sources.fetchRss({ url: 'https://www.blockmedia.co.kr/feed', source: 'blockmedia' }),
  tokenpost: () => sources.fetchRss({ url: 'https://www.tokenpost.kr/rss', source: 'tokenpost' }),
};

async function collectEvents() {
  const all = [];
  for (const [name, fetcher] of Object.entries(SOURCE_FETCHERS)) {
    if (!config.sources[name]) continue;
    const h = srcHealth.get(name) || { source: name, count: 0 };
    try {
      const got = await fetcher();
      all.push(...got);
      srcHealth.set(name, { ...h, ok: true, lastFetchAt: Date.now(), error: null });
    } catch (err) {
      srcHealth.set(name, { ...h, ok: false, lastFetchAt: Date.now(), error: err.message });
    }
  }
  return all;
}

// 이 재료로 매매할 것인가. 판단 근거를 함께 돌려줘 화면과 텔레그램에 남긴다.
function shouldTrade(m) {
  if (!m.grade) return { ok: false, why: '매매 대상 아님' };
  if (m.direction === 'bearish') return { ok: false, why: '악재 — 현물은 하락에 베팅할 수 없음' };
  if (m.direction === 'neutral') return { ok: false, why: '방향성 없음' };
  if (m.stale && !config.tradeStaleEvents) return { ok: false, why: '이미 반영된 후속 공지' };
  if ((GRADE_RANK[m.grade] || 0) < (GRADE_RANK[config.minGrade] || 0)) {
    return { ok: false, why: `${m.grade}급은 하한(${config.minGrade}급) 미만` };
  }
  if (!m.tickers.length) return { ok: false, why: '거래 가능한 티커를 찾지 못함' };
  return { ok: true, why: null };
}

async function pollOnce() {
  await refreshSymbols();
  if (!knownSymbols.length) return;

  const fetched = await collectEvents();
  const deduped = sources.dedupeNewEvents(fetched, seenIds);
  const unseen = deduped.fresh;
  seenIds = deduped.seenIds;

  // 첫 폴링은 기준선만 세우고 매매하지 않는다. 지금 응답에 들어 있는 것은
  // 전부 이 프로세스가 켜지기 전에 이미 나온 재료다.
  if (!primed) {
    primed = true;
    console.log(`  기준선 설정: 기존 공지 ${unseen.length}건을 이미 본 것으로 표시 (매매하지 않음)`);
    return;
  }

  // 나이로 한 번 더 거른다. 중복 제거는 "처음 보는가"만 답하지 "지금 나온 것인가"는
  // 답하지 못한다 — RSS는 오래된 항목을 다시 밀어 올리기도 한다.
  const { fresh, stale } = sources.filterFreshEvents(unseen, {
    maxAgeMs: config.maxEventAgeSec * 1000,
  });
  // 걸러진 것도 화면에는 남긴다. 무엇이 지나갔는지 봐야 기준이 맞는지 판단할 수 있다.
  for (const ev of stale) {
    events.unshift({ ...ev, grade: null, direction: 'neutral', kind: null, tickers: [],
      stale: true, reason: '나이 초과 — 이미 시장에 퍼진 재료', traded: false });
  }
  if (events.length > 200) events.length = 200;
  if (!fresh.length) return;

  // 오래된 것부터 처리해야 같은 종목에 여러 재료가 있을 때 순서가 맞는다.
  fresh.sort((a, b) => a.at - b.at);

  for (const ev of fresh) {
    const m = material.classifyMaterial({
      title: ev.title, category: ev.category, source: ev.source, knownSymbols,
    });
    const decision = shouldTrade(m);
    const row = {
      ...ev, grade: m.grade, direction: m.direction, kind: m.kind,
      tickers: m.tickers, stale: m.stale,
      reason: decision.ok ? null : decision.why, traded: false,
    };
    events.unshift(row);
    if (events.length > 200) events.pop();

    const h = srcHealth.get(ev.source);
    if (h) srcHealth.set(ev.source, { ...h, count: (h.count || 0) + 1, lastEventAt: ev.at });

    // 매매 대상이 아니어도 등급이 매겨진 재료는 알린다 — 무엇이 지나갔는지 봐야
    // 분별 기준이 맞는지 사람이 판단할 수 있다.
    if (m.grade) await notify(telegram.formatEventAlert({ event: ev, material: m }));

    if (decision.ok) await tryEnter(row, m);
  }
}

async function tryEnter(row, m) {
  const symbol = m.tickers[0];
  let price;
  let spreadBps;
  try {
    const book = await bithumb.fetchOrderbook(symbol);
    price = book.ask;
    spreadBps = bithumb.spreadBps(book);
  } catch (err) {
    recordError(`${symbol} 호가 조회 실패: ${err.message}`);
    return;
  }

  // 상장 공지 직후에는 호가가 크게 벌어진다. 재료가 수백 bps를 움직여도 호가가
  // 비어 있으면 시장가가 어디에 체결될지 알 수 없다.
  if (spreadBps > config.maxSpreadBps) {
    row.reason = `스프레드 ${spreadBps.toFixed(0)}bps > 상한 ${config.maxSpreadBps}bps`;
    return;
  }

  const planned = eventPlan.planEventTrade({
    grade: m.grade, direction: m.direction, marketContext,
    capital: config.capitalKrw, riskPct: config.riskPct,
    price, feeBps: config.feeBps, minNotionalKrw: config.minNotionalKrw,
  });
  if (!planned.executable) { row.reason = planned.reason; return; }
  // 알림 포맷터가 진입가를 요구한다. planEventTrade는 price를 입력으로만 받고
  // 돌려주지 않으므로 여기서 붙인다 — 계획과 실제 진입가가 어긋나면 안 된다.
  const plan = { ...planned, entryPrice: price };

  const r = fsm.onMaterialDetected(state, { event: row, material: m, plan, now: Date.now() });
  state = r.state;
  if (r.action.type !== 'enter') { row.reason = r.action.reason; return; }

  if (mode === 'live') {
    try {
      const acct = await trade.getAccounts();
      const krwAmount = Math.floor(Math.min(plan.notional, acct.krw * 0.99));
      if (krwAmount < config.minNotionalKrw) {
        row.reason = `가용 원화 부족 (${krwAmount}원 < ${config.minNotionalKrw}원)`;
        state = fsm.halt(state, row.reason).state;
        return;
      }
      const order = await trade.placeOrder(
        trade.buildEntryOrder({ symbol, krwAmount, ordType: 'price' })
      );
      state = fsm.onFillConfirmed(state, {
        price, quantity: krwAmount / price, orderUuid: order.uuid, now: Date.now(),
      }).state;
    } catch (err) {
      recordError(`진입 실패 ${symbol}: ${err.message}`);
      state = fsm.halt(state, `진입 실패: ${err.message}`).state;
      return;
    }
  } else {
    // 감시 모드 — 가상 체결. 재료의 실제 가격 반응을 기록해 표본을 쌓는다.
    state = fsm.onFillConfirmed(state, {
      price, quantity: plan.quantity, orderUuid: null, now: Date.now(),
    }).state;
  }

  row.traded = true;
  await notify(telegram.formatEntryAlert({
    symbol, plan, event: row, material: m, simulated: mode !== 'live',
  }));
}

// 보유 중 모니터링 — 익절·손절·시간초과를 감시하다 조건 충족 시 즉시 시장가 청산.
async function priceTick() {
  if (state.status !== 'HOLDING' && state.status !== 'EXITING') return;
  const symbol = state.material && state.material.tickers ? state.material.tickers[0] : null;
  if (!symbol || !state.entryPrice) return;

  let price;
  try {
    const book = await bithumb.fetchOrderbook(symbol);
    price = book.bid; // 청산은 매도라 매수호가를 친다
  } catch (err) {
    recordError(`${symbol} 가격 조회 실패: ${err.message}`);
    return;
  }

  const entryPrice = state.entryPrice;
  const quantity = state.quantity;
  const entryAt = state.entryAt;
  const grade = state.material ? state.material.grade : null;

  const r = fsm.onPriceTick(state, { price, now: Date.now() });
  state = r.state;
  if (r.action.type !== 'exit') return;

  if (mode === 'live') {
    try {
      await trade.placeOrder(trade.buildExitOrder({ symbol, volume: quantity, ordType: 'market' }));
    } catch (err) {
      recordError(`청산 실패 ${symbol}: ${err.message}`);
      await notify(telegram.formatHaltAlert({ reason: `청산 실패 ${symbol}: ${err.message}` }));
      state = fsm.halt(state, '청산 실패').state;
      return;
    }
  }

  const holdSec = Math.round((Date.now() - entryAt) / 1000);
  const returnBps = (price / entryPrice - 1) * 10000 - config.feeBps * 2;
  const pnlKrw = (quantity * entryPrice * returnBps) / 10000;

  trades.unshift({
    at: Date.now(), symbol, grade, entryPrice, exitPrice: price,
    returnBps, pnlKrw, outcome: r.action.reason, holdSec, simulated: mode !== 'live',
  });
  if (trades.length > 100) trades.pop();

  state = fsm.onExitConfirmed(state, { price, now: Date.now() }).state;
  await notify(telegram.formatExitAlert({
    symbol, outcome: r.action.reason, returnBps, holdSec, pnlKrw, simulated: mode !== 'live',
  }));
}

function startLoops() {
  if (!pollTimer) {
    const poll = () => { if (mode !== 'stopped') pollOnce().catch((e) => recordError(e.message)); };
    poll();
    pollTimer = setInterval(poll, config.pollIntervalSec * 1000);
  }
  if (!tickTimer) {
    const tick = () => { if (mode !== 'stopped') priceTick().catch((e) => recordError(e.message)); };
    tickTimer = setInterval(tick, config.priceTickSec * 1000);
  }
  refreshMarketContext();
  if (!startLoops._ctx) {
    startLoops._ctx = setInterval(() => { if (mode !== 'stopped') refreshMarketContext(); }, 60_000);
  }
}

function stopLoops() {
  if (pollTimer) clearInterval(pollTimer);
  if (tickTimer) clearInterval(tickTimer);
  pollTimer = null;
  tickTimer = null;
}

// ── HTTP ────────────────────────────────────────────────────────────────────

function json(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => { raw += c; if (raw.length > 10000) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(raw || '{}')); } catch { resolve({}); } });
  });
}

function todayStats() {
  const start = new Date(); start.setHours(0, 0, 0, 0);
  const t = trades.filter((x) => x.at >= start.getTime());
  if (!t.length) return { trades: 0, wins: 0, losses: 0, netBps: 0, netKrw: 0 };
  return {
    trades: t.length,
    wins: t.filter((x) => x.returnBps > 0).length,
    losses: t.filter((x) => x.returnBps <= 0).length,
    netBps: t.reduce((s, x) => s + x.returnBps, 0),
    netKrw: t.reduce((s, x) => s + x.pnlKrw, 0),
  };
}

function positionView() {
  // event-engine은 포지션을 별도 객체가 아니라 상태에 평탄하게 담는다.
  if (!state.entryPrice || (state.status !== 'HOLDING' && state.status !== 'EXITING')) return null;
  const now = state.lastPrice ?? state.entryPrice;
  const grossBps = (now / state.entryPrice - 1) * 10000;
  const netBps = grossBps - config.feeBps * 2;
  const notional = (state.quantity ?? 0) * state.entryPrice;
  const maxHoldSec = state.deadlineAt && state.entryAt
    ? Math.round((state.deadlineAt - state.entryAt) / 1000)
    : null;
  return {
    symbol: (state.material && state.material.tickers && state.material.tickers[0]) || null,
    grade: state.material ? state.material.grade : null,
    eventTitle: state.event ? state.event.title : null,
    entryPrice: state.entryPrice, currentPrice: now,
    quantity: state.quantity, notional,
    takeProfitPrice: state.takeProfitPrice, stopLossPrice: state.stopLossPrice,
    unrealizedBps: netBps, unrealizedKrw: (notional * netBps) / 10000,
    entryAt: state.entryAt, maxHoldSec,
    holdSec: state.entryAt ? Math.round((Date.now() - state.entryAt) / 1000) : null,
  };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (url.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(fs.readFileSync(path.join(__dirname, '..', 'harness', 'event-dashboard.html'), 'utf8'));
    return;
  }

  if (url.pathname === '/api/state') {
    json(res, 200, {
      mode,
      fsm: { status: state.status, since: state.since },
      position: positionView(),
      events: events.slice(0, 60),
      sources: [...srcHealth.values()],
      marketContext,
      today: todayStats(),
      trades: trades.slice(0, 40),
      // 설정만 노출한다. 키·토큰은 여기 없다.
      config: {
        minGrade: config.minGrade, pollIntervalSec: config.pollIntervalSec,
        priceTickSec: config.priceTickSec, capitalKrw: config.capitalKrw,
        riskPct: config.riskPct, minNotionalKrw: config.minNotionalKrw,
        maxSpreadBps: config.maxSpreadBps, tradeStaleEvents: config.tradeStaleEvents,
      },
      telegram: { enabled: TG_ON, lastSentAt: tgLastSentAt },
      liveApproved: LIVE_APPROVED, hasKeys: HAS_KEYS,
      errors: errors.slice(0, 10),
    });
    return;
  }

  if (url.pathname === '/api/mode' && req.method === 'POST') {
    const body = await readBody(req);
    const next = body.mode;
    if (!['stopped', 'watching', 'live'].includes(next)) {
      json(res, 400, { ok: false, reason: `알 수 없는 모드: ${next}` });
      return;
    }
    // 두 관문을 모두 통과해야 한다 — 통계 전략 대시보드와 같은 규약이다.
    if (next === 'live') {
      if (!LIVE_APPROVED) {
        json(res, 400, { ok: false, reason: '실거래가 승인되지 않았습니다 — .env에 BITHUMB_LIVE=1이 필요합니다' });
        return;
      }
      if (body.confirmLive !== true) {
        json(res, 400, { ok: false, reason: '실거래 전환에는 명시적 확인이 필요합니다' });
        return;
      }
    }
    const prev = mode;
    mode = next;
    if (mode === 'stopped') stopLoops(); else startLoops();
    json(res, 200, { ok: true, mode });
    // 모드 전환은 반드시 알린다. 화면을 안 보고 있을 때 시스템이 실거래로 넘어갔는지
    // 멈췄는지를 모르면 안 된다 — 이 알림이 곧 생존 신호이기도 하다.
    const label = { stopped: '⏸ 정지', watching: '👀 감시 시작 (모의)', live: '🔴 실거래 시작' }[mode];
    notify(`${label}\n이전 상태: ${prev}\n하한 등급 ${config.minGrade} · 자본 ${config.capitalKrw.toLocaleString('ko-KR')}원 · 1회 위험 ${config.riskPct}%`);
    return;
  }

  json(res, 404, { error: 'not found' });
});

server.listen(PORT, () => {
  console.log(`유목민식 이벤트 단타: http://localhost:${PORT}`);
  console.log(`  모드: stopped (시작 버튼은 감시로만 진입)`);
  console.log(`  빗썸 키: ${HAS_KEYS ? '설정됨' : '없음'} · 실거래 승인: ${LIVE_APPROVED ? '켜짐' : '꺼짐'}`);
  console.log(`  텔레그램: ${TG_ON ? '켜짐' : '꺼짐'}`);
  console.log(`  매매 하한 등급: ${config.minGrade} · 폴링 ${config.pollIntervalSec}초`);
  console.log('  ⚠ 실거래 스위치는 화면에 있습니다. 이 프로세스는 스스로 live로 전환하지 않습니다.');
});
