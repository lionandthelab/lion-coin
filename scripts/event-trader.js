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
const gate = require('../src/trade-gate');
const snapshot = require('../src/market-snapshot');
const orphan = require('../src/orphan-check');
const store = require('../src/state-store');
const writer = require('../src/review-writer');
const { summarizeDay, proposeCalibration, postExitKey } = require('../src/daily-review');

const PORT = Number(process.env.EVENT_PORT || 8788);
const CONFIG_PATH = path.join(__dirname, '..', 'harness', 'event-trading.json');
const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));

const LIVE_APPROVED = process.env.BITHUMB_LIVE === '1';
const HAS_KEYS = Boolean(process.env.BITHUMB_API_KEY && process.env.BITHUMB_SECRET_KEY);
const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TG_CHAT = process.env.TELEGRAM_CHAT_ID;
const TG_ON = Boolean(config.telegramEnabled && TG_TOKEN && TG_CHAT);

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
// 평가 전에는 neutral로 위장하지 않는다. 켜자마자 들어온 재료가 "시황 중립"으로
// 계획되면, 시황을 보겠다고 만든 층이 정확히 가장 급한 순간에 없는 것과 같다.
let marketContext = { regime: null, multiplier: null, reason: '아직 평가 전' };
let marketContextAt = null;
let tgLastSentAt = null;

// **청산 후에도 가격을 계속 추적한다 — 이게 복기의 재료다.**
// 손절로 나왔는데 그 뒤 반등했다면 손절이 좁았던 것이고, 익절로 나왔는데 그 뒤 더 갔다면
// 익절이 빨랐던 것이다. 청산 시점의 손익만 보면 이 둘을 구별할 수 없다.
const postExits = new Map();   // 'SYM@진입시각' → {symbol, until, highest, lowest}
// 상태 저장 위치. 테스트가 실제 운영 상태를 덮어쓰지 않도록 환경변수로 옮길 수 있다 —
// 이 디렉터리의 파일들이 배포 게이트·복기·롤백 판정의 입력이라, 테스트가 남긴
// 가짜 거래 한 줄이 그대로 근거로 쓰인다.
const IMPROVE_DIR = process.env.EVENT_STATE_DIR || path.join(__dirname, '..', 'harness', 'improve');
const TRADE_LOG = path.join(IMPROVE_DIR, 'trade-log.jsonl');
const STATE_FILE = path.join(IMPROVE_DIR, 'daemon-state.json');

function kstDate(ms = Date.now()) {
  return new Date(ms + 9 * 3600 * 1000).toISOString().slice(0, 10);
}
function saveJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 1));
}

// 개선 사이클(별도 프로세스)이 읽을 수 있게 파일로 남긴다.
function persistDay() {
  const date = kstDate();
  const start = new Date(new Date(kstDate() + 'T00:00:00+09:00')).getTime();
  saveJson(path.join(IMPROVE_DIR, `day-${date}.json`), {
    trades: trades.filter((t) => t.at >= start),
    events: events.filter((e) => e.at >= start).map((e) => ({
      grade: e.grade, direction: e.direction, traded: e.traded, reason: e.reason,
    })),
    postExits: Object.fromEntries([...postExits.entries()].map(([k, v]) => [k, { highest: v.highest, lowest: v.lowest }])),
  });
  saveJson(path.join(IMPROVE_DIR, 'mode.json'), { mode });
  saveJson(path.join(IMPROVE_DIR, 'position.json'), positionView());
  persistState();
}

// **재시작이 상태를 지우지 않게 한다.**
// 이걸 안 하면 거래소에 포지션이 남은 채 상태 기계는 IDLE로 시작하고, 그 포지션은
// 익절·손절·시간초과 어느 것도 받지 못한다. 실거래를 재시작 후에도 이어가려면
// 상태 복원이 모드 복원보다 먼저다.
//
// 포지션이 바뀌는 모든 지점에서 부른다 — 크래시는 예고하지 않는다.
function persistState() {
  try {
    saveJson(STATE_FILE, store.buildSnapshot({
      state, mode, seenIds, postExits, trades, events, marketContextAt,
    }));
  } catch (err) {
    // 저장 실패가 매매를 멈추게 하지는 않는다. 다만 조용히 넘어가지도 않는다 —
    // 저장이 안 되고 있다는 사실을 모르면 다음 재시작에서 상태를 통째로 잃는다.
    recordError(`상태 저장 실패: ${err.message}`);
  }
}

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
    // 모르는 값을 0·50으로 채우지 않는다. 그 두 값은 완벽하게 중립이라 어떤
    // 가드에도 걸리지 않고, 시황을 한 번도 못 읽어도 계획이 만들어진다.
    marketContext = eventPlan.assessMarketContext(snapshot.marketInputsFromTickers(t));
    marketContextAt = marketContext.regime ? Date.now() : null;
  } catch (err) {
    recordError(`시황 평가 실패: ${err.message}`);
    // 마지막 값을 그대로 두되 시각은 갱신하지 않는다 — 나이가 쌓이면
    // isContextUsable이 스스로 만료시킨다.
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
    const decision = gate.shouldTrade(m, config);
    const row = {
      ...ev, grade: m.grade, direction: m.direction, kind: m.kind,
      // 후보 티커도 남긴다. 거래 불가 종목의 재료가 화면에서 이름을 잃으면
      // 무엇이 지나갔는지 사후에 확인할 방법이 없다.
      tickers: m.tickers, candidateTickers: m.candidateTickers || [],
      target: gate.describeTarget(m), stale: m.stale,
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

  // 재료 기억(seenIds)을 잃으면 재시작 직후 이미 지나간 공지를 새 재료로 다시
  // 잡는다. 이 폴링에서 무언가 처리했으면 저장한다.
  persistState();
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

  // 오래된 시황으로 계획을 세우지 않는다. 조회가 계속 실패하면 마지막 값이
  // 조용히 계속 쓰이는데, 한 시간 전 국면으로 지금 재료의 크기를 조절하는 것은
  // 모르는 것보다 나쁘다 — 모르면 적어도 멈춘다.
  if (!snapshot.isContextUsable(marketContext, { at: marketContextAt, now: Date.now() })) {
    row.reason = `시황을 판정하지 못했습니다 — ${marketContext.reason || '평가 전'}`;
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
  // 진입 직후가 가장 중요한 저장 시점이다. 여기서 크래시가 나면 거래소에는
  // 포지션이 있는데 이 프로세스만 모르는 상태가 된다.
  persistState();
  await notify(telegram.formatEntryAlert({
    symbol, plan, event: row, material: m, simulated: mode !== 'live',
  }));
}

// 보유 중 모니터링 — 익절·손절·시간초과를 감시하다 조건 충족 시 즉시 시장가 청산.
// 청산된 종목의 가격을 추적 기한까지 계속 읽는다.
async function trackPostExits() {
  const now = Date.now();
  for (const [key, pe] of [...postExits.entries()]) {
    if (now > pe.until) continue;      // 기한이 지난 것은 그대로 굳힌다
    try {
      const book = await bithumb.fetchOrderbook(pe.symbol);
      const px = book.bid;
      if (!(px > 0)) continue;
      pe.highest = pe.highest == null ? px : Math.max(pe.highest, px);
      pe.lowest = pe.lowest == null ? px : Math.min(pe.lowest, px);
    } catch { /* 사후 추적 실패가 매매를 막아선 안 된다 */ }
  }
}

// 중단된 채로 수량을 들고 있으면 어떤 감시도 받지 않는다 — 정확히 고아 상태다.
// 상태 기계는 HALTED에서 틱을 판정하지 않는 것이 옳고(중단은 사람이 풀어야 한다),
// 그래서 침묵을 깨는 일은 데몬 몫이다.
let lastOrphanWarnAt = 0;
const ORPHAN_WARN_MS = 10 * 60 * 1000;

async function priceTick() {
  if (state.status === 'HALTED' && state.quantity != null) {
    if (Date.now() - lastOrphanWarnAt > ORPHAN_WARN_MS) {
      lastOrphanWarnAt = Date.now();
      const sym = state.material && state.material.tickers ? state.material.tickers[0] : '?';
      await notify(telegram.formatHaltAlert({
        reason: `중단 상태에서 포지션이 남아 있습니다 — ${sym} 수량 ${state.quantity} · 진입가 ${state.entryPrice}\n`
          + `사유: ${state.haltReason || '알 수 없음'}\n`
          + '⚠ 자동 청산이 돌지 않습니다. 거래소에서 직접 처리하세요.',
      }));
    }
    return;
  }
  if (state.status !== 'HOLDING' && state.status !== 'EXITING') return;
  const symbol = state.material && state.material.tickers ? state.material.tickers[0] : null;
  // 조용히 돌아가면 포지션이 감시도 청산도 못 받고 기록조차 남지 않는다 —
  // 이 저장소가 가장 여러 번 당한 실패 방식이다. 도달하면 안 되는 자리이므로
  // 도달했다는 사실 자체를 남긴다.
  if (!symbol || !state.entryPrice) {
    if (Date.now() - lastOrphanWarnAt > ORPHAN_WARN_MS) {
      lastOrphanWarnAt = Date.now();
      const what = !symbol ? '청산할 종목을 읽지 못했습니다' : '진입가가 없습니다';
      recordError(`${state.status} 포지션을 감시할 수 없습니다 — ${what}`);
      await notify(telegram.formatHaltAlert({
        reason: `${state.status} 포지션을 감시할 수 없습니다 — ${what}\n`
          + `수량 ${state.quantity} · 진입가 ${state.entryPrice}\n`
          + '⚠ 익절·손절이 돌지 않습니다. 거래소에서 직접 확인하세요.',
      }));
    }
    return;
  }

  // **가격을 못 읽어도 판정은 돌린다.**
  // 여기서 return하면 상태 기계가 바로 이 경우를 위해 만든 시간초과 경로가
  // 유일한 운영 호출처에서 도달 불가능해진다(src/event-engine.js: "나올 수 없는
  // 것보다 가격을 모르는 채 나오는 편이 낫다"). 그리고 호가가 마르는 종목이
  // 정확히 이 전략이 노리는 종목이다 — 거래정지·유의종목 지정 직후.
  // 가장 크게 물릴 수 있는 자리에서만 청산이 멈춘다.
  //
  // null을 넘기면 익절·손절만 포기하고 시간초과는 그대로 판정된다.
  let price = null;
  try {
    const book = await bithumb.fetchOrderbook(symbol);
    price = book.bid; // 청산은 매도라 매수호가를 친다
  } catch (err) {
    recordError(`${symbol} 가격 조회 실패: ${err.message}`);
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
      // **중단하지 않는다.** halt하면 포지션은 HALTED에 수량을 든 채 굳고
      // 다음 틱이 판정하지 않아 아무도 보지 않는 고아가 된다. 청산 조건은
      // 사라진 게 아니라 그대로 남아 있으므로 HOLDING으로 되돌려 재시도한다.
      const r2 = fsm.onExitFailed(state, { reason: err.message, now: Date.now() });
      state = r2.state;
      persistState();   // 실패 횟수와 되돌아온 상태를 잃지 않는다
      const a = r2.action || {};
      // 연속 실패가 상한을 넘으면 알림의 성격이 바뀐다 — 재시도는 계속되지만
      // 거래소가 계속 거절하는 것은 사람이 손으로 나와야 하는 상황이다.
      if (a.needsManualIntervention) {
        await notify(telegram.formatHaltAlert({
          reason: `청산 ${a.failCount}회 연속 실패 ${symbol}: ${err.message}\n`
            + `수량 ${a.quantity} · 진입가 ${a.entryPrice}\n`
            + '⚠ 재시도는 계속됩니다. 거래소에서 직접 청산해야 할 수 있습니다.',
        }));
      }
      return;
    }
  }

  const holdSec = Math.round((Date.now() - entryAt) / 1000);
  // 가격을 모르면 손익도 모른다. 0으로 채우면 -100% 같은 거짓 기록이 남고,
  // 그 기록이 복기와 버전별 실적 비교의 근거가 된다.
  const priceKnown = price > 0;
  const returnBps = priceKnown ? (price / entryPrice - 1) * 10000 - config.feeBps * 2 : null;
  const pnlKrw = priceKnown ? (quantity * entryPrice * returnBps) / 10000 : null;

  trades.unshift({
    at: Date.now(), symbol, grade, entryPrice, exitPrice: priceKnown ? price : null,
    returnBps, pnlKrw, outcome: r.action.reason, holdSec, simulated: mode !== 'live',
  });
  if (trades.length > 100) trades.pop();

  // 청산 후 추적 시작 — 이 기록이 "익절·손절이 옳았는가"의 유일한 근거다.
  // 최대 보유시간의 3배까지 본다. 그보다 길게 보면 재료와 무관한 시장 움직임이 섞인다.
  const maxHold = state.deadlineAt && entryAt
    ? Math.round((state.deadlineAt - entryAt) / 1000) : config.priceTickSec * 60;
  const rec = { at: Date.now(), symbol, grade, entryPrice, exitPrice: priceKnown ? price : null,
    returnBps, pnlKrw, outcome: r.action.reason, holdSec,
    takeProfitBps: state.plan ? state.plan.takeProfitBps : null,
    stopLossBps: state.plan ? state.plan.stopLossBps : null,
    simulated: mode !== 'live' };
  // **관측 전에는 null이다.** 청산가로 미리 채우면 daily-review의 "청산 후 가격
  // 기록이 없습니다" 가드가 영영 참이 되지 않아, 사후 관측이 0건인데 복기가
  // "익절이 옳았다"고 단정한다. 표본이 없다는 사실 자체가 지워진다.
  postExits.set(postExitKey(rec), {
    symbol, until: Date.now() + maxHold * 3 * 1000, highest: null, lowest: null,
  });
  trades[0] = rec;   // 방금 unshift한 항목을 손익폭 정보까지 담아 갱신

  // 개선 사이클이 버전별 실적을 붙일 수 있게 append-only 로그로 남긴다.
  try {
    fs.mkdirSync(IMPROVE_DIR, { recursive: true });
    fs.appendFileSync(TRADE_LOG, JSON.stringify(rec) + '\n');
  } catch (err) { recordError(`거래 로그 기록 실패: ${err.message}`); }

  state = fsm.onExitConfirmed(state, { price: priceKnown ? price : null, now: Date.now() }).state;
  // **청산 확정 뒤에 저장한다.** 앞서 저장하면 아직 EXITING인 상태가 직렬화돼
  // position.json에 유령 포지션이 굳는다. 그 파일을 배포 게이트가 읽으므로,
  // 다음 거래가 끝날 때까지 POSITION_OPEN으로 영구 차단된다.
  persistDay();
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
    const tick = () => {
      if (mode === 'stopped') return;
      priceTick().catch((e) => recordError(e.message));
      trackPostExits().catch(() => {});
    };
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
      // 화면이 시황의 나이를 볼 수 있어야 한다. "neutral"만 보이면 방금 읽은
      // 것인지 한 시간 전 것인지 구별되지 않는다.
      marketContext: {
        ...marketContext,
        at: marketContextAt,
        usable: snapshot.isContextUsable(marketContext, { at: marketContextAt, now: Date.now() }),
      },
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

  // ── 복기 ──
  if (url.pathname === '/api/reviews') {
    const dates = writer.listReviews();
    json(res, 200, {
      dates,
      today: kstDate(),
      // 오늘치는 아직 파일이 없을 수 있다 — 지금까지의 집계를 미리보기로 준다.
      preview: (() => {
        const start = new Date(kstDate() + 'T00:00:00+09:00').getTime();
        const sum = summarizeDay({
          date: kstDate(),
          trades: trades.filter((t) => t.at >= start),
          events: events.filter((e) => e.at >= start),
          postExits: Object.fromEntries([...postExits.entries()]
            .map(([k, v]) => [k, { highest: v.highest, lowest: v.lowest }])),
        });
        return { summary: sum, calibration: proposeCalibration([sum]) };
      })(),
    });
    return;
  }

  if (url.pathname === '/api/review') {
    const date = url.searchParams.get('date');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) {
      json(res, 400, { error: '날짜 형식이 올바르지 않습니다 (YYYY-MM-DD)' });
      return;
    }
    const body = writer.readReview(date);
    if (body == null) { json(res, 404, { error: '해당 날짜의 복기문이 없습니다' }); return; }
    json(res, 200, { date, body });
    return;
  }

  if (url.pathname === '/api/review/generate' && req.method === 'POST') {
    // 오늘치 복기문을 지금 만든다. 자정을 기다리지 않고 확인할 수 있어야 한다.
    try {
      const date = kstDate();
      const start = new Date(date + 'T00:00:00+09:00').getTime();
      const sum = summarizeDay({
        date,
        trades: trades.filter((t) => t.at >= start),
        events: events.filter((e) => e.at >= start),
        postExits: Object.fromEntries([...postExits.entries()]
          .map(([k, v]) => [k, { highest: v.highest, lowest: v.lowest }])),
      });
      const cal = proposeCalibration([sum]);
      const file = writer.writeReview({ date, summary: sum, calibration: cal });
      persistDay();
      json(res, 200, { ok: true, date, file: path.basename(file) });
    } catch (err) {
      json(res, 500, { ok: false, error: err.message });
    }
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
    // 재시작이 이 선택을 꺼버리지 않게 즉시 저장한다. 실거래를 켜자마자 크래시가
    // 나면 다시 감시 모드로 돌아가는데, 그건 사람이 내린 결정이 아니다.
    persistState();
    json(res, 200, { ok: true, mode });
    // 모드 전환은 반드시 알린다. 화면을 안 보고 있을 때 시스템이 실거래로 넘어갔는지
    // 멈췄는지를 모르면 안 된다 — 이 알림이 곧 생존 신호이기도 하다.
    const label = { stopped: '⏸ 정지', watching: '👀 감시 시작 (모의)', live: '🔴 실거래 시작' }[mode];
    notify(`${label}\n이전 상태: ${prev}\n하한 등급 ${config.minGrade} · 자본 ${config.capitalKrw.toLocaleString('ko-KR')}원 · 1회 위험 ${config.riskPct}%`);
    return;
  }

  json(res, 404, { error: 'not found' });
});

// **이음매를 테스트가 볼 수 있게 연다.**
// 이 파일의 결함은 전부 모듈 사이의 이음매에서 나왔다 — 상태 기계에 청산 경로가
// 있는데 데몬이 안 부르고, 분별기가 필드를 내주는데 데몬이 안 읽는 식이다.
// 단위 테스트는 이런 것을 원리적으로 못 잡는다. 그래서 네트워크 경계만 갈아끼우고
// 실제 함수를 그대로 돌릴 수 있도록 내보낸다.
//
// 서버는 직접 실행할 때만 연다. require로 불러오면 포트를 잡지 않는다.
module.exports = {
  pollOnce,
  priceTick,
  trackPostExits,
  persistDay,
  positionView,
  setMode: (m) => { mode = m; },
  getMode: () => mode,
  getState: () => state,
  setState: (s) => { state = s; },
  getTrades: () => trades,
  getEvents: () => events,
  getErrors: () => errors,
  getPostExits: () => postExits,
  setPrimed: (v) => { primed = v; },
  setMarketContext: (ctx, at) => { marketContext = ctx; marketContextAt = at; },
  config,
};

if (require.main !== module) return;

// 기동 복원. **순서가 곧 안전 순서다: 상태를 먼저 되살리고, 그 다음에 모드다.**
// 모드를 먼저 켜면 상태가 비어 있는 채로 폴링이 돌아 이전 포지션을 모르고
// 새 재료에 또 진입한다. 크래시 루프에서 감시받지 않는 포지션이 쌓이는 경로다.
function restoreOnStartup() {
  let snap = null;
  try {
    if (fs.existsSync(STATE_FILE)) snap = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch (err) {
    recordError(`저장된 상태를 읽지 못했습니다: ${err.message}`);
  }

  const r = store.restoreSnapshot(snap);
  const lines = [];

  if (r.ok) {
    state = r.state;
    seenIds = r.seenIds;
    // 이미 본 공지를 기억하고 있으므로 기준선을 다시 세울 필요가 없다.
    // 그래도 나이 필터는 그대로 돌아, 내려가 있는 동안 나온 옛 재료는 걸러진다.
    primed = seenIds.size > 0;
    for (const [k, v] of r.postExits) postExits.set(k, v);
    trades.push(...r.trades);
    events.push(...r.events);
    marketContextAt = r.marketContextAt;
    lines.push(`  상태 복원: 재료 기억 ${seenIds.size}건 · 거래 ${trades.length}건 · 사후추적 ${postExits.size}건`);
    if (r.notice) { lines.push(`\n${r.notice}\n`); notify(telegram.formatHaltAlert({ reason: r.notice })); }
  } else if (r.warning) {
    // 조용히 깨끗해지는 것이 이 시스템에서 가장 비싼 실패다.
    lines.push(`  ⚠ ${r.warning}`);
    recordError(r.warning);
    notify(telegram.formatHaltAlert({ reason: r.warning }));
    // 상태는 못 살렸지만 마지막 포지션 기록은 따로 확인해 사람을 부른다.
    try {
      const p = path.join(IMPROVE_DIR, 'position.json');
      const saved = fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null;
      const o = orphan.checkStrandedPosition(saved);
      if (o.stranded) {
        lines.push(`\n${o.message}\n`);
        notify(telegram.formatHaltAlert({ reason: o.message }));
      }
    } catch { /* 기록이 없거나 깨졌으면 위 경고로 충분하다 */ }
  }

  // 이제 모드. 저장된 값이 .env의 승인을 이기지 않는다.
  const m = store.resolveStartupMode({
    saved: r.ok ? r.mode : null, liveApproved: LIVE_APPROVED, hasKeys: HAS_KEYS,
  });
  mode = m.mode;
  if (m.warning) { lines.push(`  ⚠ ${m.warning}`); recordError(m.warning); }
  if (m.notice) lines.push(`  ${m.notice}`);
  if (mode !== 'stopped') startLoops();
  if (m.notice || m.warning) notify(m.notice || m.warning);

  return lines;
}

server.listen(PORT, () => {
  const restored = restoreOnStartup();
  console.log(`유목민식 이벤트 단타: http://localhost:${PORT}`);
  for (const l of restored) console.log(l);
  console.log(`  모드: ${mode}${mode === 'stopped' ? ' (시작 버튼은 감시로만 진입)' : ' (재시작 전 상태를 이어받음)'}`);
  console.log(`  빗썸 키: ${HAS_KEYS ? '설정됨' : '없음'} · 실거래 승인: ${LIVE_APPROVED ? '켜짐' : '꺼짐'}`);
  console.log(`  텔레그램: ${TG_ON ? '켜짐' : '꺼짐'}`);
  console.log(`  매매 하한 등급: ${config.minGrade} · 폴링 ${config.pollIntervalSec}초`);
  console.log('  ⚠ 실거래 스위치는 화면에 있습니다. 이 프로세스는 스스로 live로 전환하지 않습니다.');
});
