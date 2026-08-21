const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

// **데몬의 이음매 테스트.**
//
// 이 저장소에서 가장 비싼 결함은 전부 모듈 사이에서 나왔다 — 상태 기계에 청산
// 경로가 있는데 데몬이 부르지 않고, 분별기가 필드를 내주는데 데몬이 읽지 않는 식이다.
// 각 모듈의 단위 테스트는 전부 초록이었고, 그동안 실전 증상은 그대로였다.
//
// 그래서 여기서는 **저장소의 실제 함수를 그대로 돌린다.** 갈아끼우는 것은
// 네트워크 경계 세 개(빗썸 시세·주문, 이벤트 소스, 텔레그램)뿐이고,
// material·trade-gate·event-plan·event-engine·daily-review는 원본이다.

const fs = require('node:fs');
const os = require('node:os');

const SRC = (n) => require.resolve(path.join(__dirname, '..', 'src', n));
const DAEMON = require.resolve(path.join(__dirname, '..', 'scripts', 'event-trader.js'));

// **운영 상태 디렉터리를 절대 건드리지 않는다.**
// harness/improve의 파일들은 배포 게이트·복기·롤백 판정의 입력이다. 이 테스트가
// 거기에 쓰면 가짜 거래 한 줄이 그대로 근거가 되고, 유령 포지션 하나가 배포를
// 영구히 잠근다. 실제로 이 파일을 쓰다가 그 일이 벌어졌다.
const STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lion-seams-'));
process.env.EVENT_STATE_DIR = STATE_DIR;

// 네트워크 경계만 스텁으로 바꾼 뒤 데몬을 새로 적재한다.
// require.cache를 직접 비우는 이유: 데몬은 모듈 스코프 가변 상태를 쓰므로
// 테스트마다 완전히 새 인스턴스여야 서로 오염되지 않는다.
function bootDaemon({ orderbook, tickers, notices, placeOrder } = {}) {
  for (const k of Object.keys(require.cache)) {
    if (k === DAEMON || k.includes(`${path.sep}src${path.sep}`)) delete require.cache[k];
  }

  const sent = [];
  const orders = [];

  const bithumb = require(SRC('bithumb'));
  bithumb.fetchTickerAll = async () => (tickers ? tickers() : [
    { symbol: 'CRV', price: 1000, tradeValue24h: 1e9, changeRate: 0.05 },
    { symbol: 'BTC', price: 1e8, tradeValue24h: 9e9, changeRate: 0.01 },
    { symbol: 'ETH', price: 5e6, tradeValue24h: 5e9, changeRate: 0.02 },
  ]);
  bithumb.fetchOrderbook = async (sym) => (orderbook ? orderbook(sym) : { ask: 1001, bid: 1000, askQty: 10, bidQty: 10 });

  const trade = require(SRC('bithumb-trade'));
  trade.placeOrder = async (o) => { orders.push(o); if (placeOrder) return placeOrder(o); return { uuid: 'x' }; };

  const sources = require(SRC('event-sources'));
  sources.fetchUpbitNotices = async () => (notices ? notices() : []);
  sources.fetchBithumbNotices = async () => [];
  sources.fetchRss = async () => [];

  const telegram = require(SRC('telegram'));
  telegram.sendMessage = async ({ text }) => { sent.push(text); return { ok: true }; };

  const d = require(DAEMON);
  return { d, sent, orders };
}

// 실제 S급 원화 상장 공지 모양. 빗썸에 이미 상장된 종목이라 매매까지 간다.
const listingNotice = (title = '커브(CRV) KRW 마켓 디지털 자산 추가') => ({
  id: `upbit:${title.slice(0, 6)}`, source: 'upbit', at: Date.now(), category: '거래',
  title, url: null, updatedAt: null,
});

// 첫 폴링은 기준선이라 그때 실린 공지는 "이미 본 것"으로 표시된다(설계대로다).
// 그래서 기준선에는 빈 응답을 주고, 두 번째 폴링에서 재료를 넣는다.
function feed(...notices) {
  let n = 0;
  return () => (n++ === 0 ? [] : notices);
}

// 보유 한도를 넘긴 상태로 만든다. **진입 시각을 뒤로 미는 방식**을 쓴다 —
// 마감만 과거로 당기면 (마감 − 진입)이 음수가 되어 사후 추적 창까지 비어 버린다.
function expire(d, heldSec = 9) {
  const now = Date.now();
  const st = d.getState();
  d.setState({ ...st, entryAt: now - (heldSec + 1) * 1000, deadlineAt: now - 1000 });
}

// 데몬을 재료 하나로 진입까지 밀어넣는다.
async function enterOnce(boot, { maxHoldSec = 3 } = {}) {
  const { d } = boot;
  d.setMode('watching');
  d.setPrimed(false);
  await d.pollOnce();                          // 기준선 (빈 응답)
  d.setMarketContext({ regime: 'neutral', multiplier: 1, reason: 't' }, Date.now());
  await d.pollOnce();                          // 실제 재료
  const st = d.getState();
  if (st.status === 'HOLDING' && maxHoldSec != null) {
    // 보유 한도만 줄인다. 10분을 기다리지 않기 위해서이고 판정 규칙은 손대지 않는다.
    d.setState({ ...st, deadlineAt: st.entryAt + maxHoldSec * 1000 });
  }
  return d.getState();
}

// ---- 결함 1: 호가를 못 읽으면 시간초과 청산이 영영 발동하지 않는다 ----

test('데몬: 호가 조회가 실패해도 보유 한도를 넘기면 청산한다', async () => {
  // src/event-engine.js는 이 경우를 위한 경로를 명시적으로 만들어 두었다 —
  // "매수호가가 통째로 비어 bid가 0/undefined로 오는 일이 흔한데 … 나올 수 없는
  // 것보다 가격을 모르는 채 나오는 편이 낫다". 그런데 데몬이 fetchOrderbook의
  // 예외를 잡아 onPriceTick을 부르기 전에 return하면, 그 경로는 유일한 운영
  // 호출처에서 도달 불가능해진다.
  //
  // **호가가 마르는 종목이 정확히 이 전략이 노리는 종목이다** — 거래정지·유의종목
  // 지정 직후. 가장 크게 물릴 수 있는 자리에서만 청산이 멈춘다.
  let dry = false;
  const boot = bootDaemon({
    orderbook: async () => {
      if (dry) throw new TypeError('호가가 비어 있거나 유효하지 않습니다 (거래정지·신규상장 가능성)');
      return { ask: 1001, bid: 1000, askQty: 10, bidQty: 10 };
    },
    notices: feed(listingNotice()),
  });
  const held = await enterOnce(boot, { maxHoldSec: 1 });
  assert.equal(held.status, 'HOLDING', '먼저 진입했는지 확인');

  dry = true;
  expire(boot.d);
  await boot.d.priceTick();

  assert.notEqual(boot.d.getState().status, 'HOLDING',
    '한도를 넘겼는데 호가를 못 읽었다는 이유로 계속 들고 있다');
  assert.equal(boot.d.getTrades().length, 1, '청산 기록이 남아야 한다');
  assert.equal(boot.d.getTrades()[0].outcome, 'timeout');
});

test('데몬: 호가를 못 읽은 청산은 가격을 지어내지 않는다', async () => {
  // 0이나 마지막 가격으로 채우면 -100% 같은 거짓 손익이 기록에 남고,
  // 그 기록이 복기와 롤백 판정의 근거가 된다.
  let dry = false;
  const boot = bootDaemon({
    orderbook: async () => {
      if (dry) throw new TypeError('호가 없음');
      return { ask: 1001, bid: 1000, askQty: 10, bidQty: 10 };
    },
    notices: feed(listingNotice()),
  });
  await enterOnce(boot, { maxHoldSec: 1 });
  dry = true;
  expire(boot.d);
  await boot.d.priceTick();

  const t = boot.d.getTrades()[0];
  assert.ok(t, '청산 기록이 있어야 한다');
  assert.equal(t.exitPrice, null, `청산가를 지어냈다: ${t.exitPrice}`);
  assert.equal(t.returnBps, null, `손익을 지어냈다: ${t.returnBps}`);
});

test('데몬: 호가가 일시적으로 실패해도 한도 안이면 계속 보유한다', async () => {
  // 위 수정이 "가격을 못 읽으면 무조건 나간다"가 되면 안 된다.
  // 익절·손절만 포기하고 시간초과 판정만 살아 있어야 한다.
  const boot = bootDaemon({
    orderbook: async () => { throw new TypeError('일시적 5xx'); },
    notices: feed(listingNotice()),
  });
  // 진입은 호가가 살아 있어야 하므로 먼저 정상으로 진입시킨다.
  const ok = bootDaemon({ notices: feed(listingNotice()) });
  await enterOnce(ok, { maxHoldSec: 600 });
  assert.equal(ok.d.getState().status, 'HOLDING');

  // 같은 상태를 호가가 죽은 데몬에 옮겨 심는다.
  boot.d.setState(ok.d.getState());
  boot.d.setMode('watching');
  await boot.d.priceTick();
  assert.equal(boot.d.getState().status, 'HOLDING', '한도가 남았는데 나가버렸다');
  assert.equal(boot.d.getTrades().length, 0);
});

// ---- 결함 2: 사후 추적이 한 번도 성공하지 않아도 복기가 판정한다 ----

test('데몬: 청산 후 가격을 한 번도 못 읽으면 복기가 판정하지 않는다', async () => {
  // src/daily-review.js는 `!positive(postExit.highest)`로 "기록 없음"을 걸러
  // verdict를 unknown으로 둔다. 그런데 데몬이 추적을 시작할 때 highest/lowest를
  // **청산가로 미리 채우면** 그 가드가 영영 참이 되지 않는다.
  //
  // 결과: 사후 관측이 0건인데 복기문이 "익절이 옳았다"고 단정하고, 그 판정이
  // 보정 제안의 근거가 된다. 표본이 없다는 사실 자체가 지워진다.
  const { gradeTradeOutcome } = require(SRC('daily-review'));
  const boot = bootDaemon({ notices: feed(listingNotice()) });
  await enterOnce(boot, { maxHoldSec: 1 });
  expire(boot.d);
  await boot.d.priceTick();

  const pe = [...boot.d.getPostExits().values()][0];
  assert.ok(pe, '사후 추적이 시작됐는지 확인');
  assert.equal(pe.highest, null, '관측 전에 청산가로 채우면 "기록 없음"을 구별할 수 없다');
  assert.equal(pe.lowest, null);

  const g = gradeTradeOutcome({ trade: boot.d.getTrades()[0], postExit: pe });
  assert.equal(g.verdict, 'unknown', `관측 0건인데 ${g.verdict}으로 판정했다`);
});

test('데몬: 사후 추적이 한 번이라도 성공하면 그 값을 쓴다', async () => {
  // 위 수정이 사후 추적 자체를 망가뜨리면 안 된다.
  let px = 1000;
  const boot = bootDaemon({
    orderbook: async () => ({ ask: px + 1, bid: px, askQty: 10, bidQty: 10 }),
    notices: feed(listingNotice()),
  });
  await enterOnce(boot, { maxHoldSec: 1 });
  expire(boot.d);
  await boot.d.priceTick();

  px = 1200;                       // 청산 후 더 올랐다
  await boot.d.trackPostExits();
  px = 900;
  await boot.d.trackPostExits();

  const pe = [...boot.d.getPostExits().values()][0];
  assert.equal(pe.highest, 1200);
  assert.equal(pe.lowest, 900);
});

// ---- 결함 3: 청산이 끝났는데 position.json에 유령이 남는다 ----

test('데몬: 청산이 끝나면 저장되는 포지션이 비어 있다', async () => {
  // persistDay()가 fsm.onExitConfirmed보다 먼저 불리면 positionView()가 아직
  // EXITING인 상태를 읽어 "열린 포지션"을 파일에 굳힌다. 그 파일을 배포 게이트가
  // 읽으므로, 다음 거래가 끝날 때까지 POSITION_OPEN으로 영구 차단된다 —
  // 개선을 배포할 수 없게 만드는 자물쇠가 아무 포지션도 없을 때 걸린다.
  const boot = bootDaemon({ notices: feed(listingNotice()) });
  await enterOnce(boot, { maxHoldSec: 1 });
  assert.ok(boot.d.positionView(), '보유 중에는 포지션이 보여야 한다');

  expire(boot.d);
  await boot.d.priceTick();

  // **메모리가 아니라 파일을 본다.** 청산이 끝난 뒤의 positionView()는 당연히
  // null이다 — 문제는 그 사이에 무엇이 디스크에 굳었는가다. 게이트가 읽는 것은
  // 파일이고, persistDay는 다음 거래가 끝날 때까지 다시 불리지 않는다.
  const posFile = path.join(STATE_DIR, 'position.json');
  assert.ok(fs.existsSync(posFile), '청산 시점에 상태를 저장해야 한다');
  assert.equal(JSON.parse(fs.readFileSync(posFile, 'utf8')), null,
    '청산이 끝났는데 파일에 열린 포지션이 굳었다 — 배포 게이트가 영구히 막힌다');

  assert.equal(boot.d.getState().status, 'IDLE', '청산이 확정됐는지 확인');
  assert.equal(boot.d.positionView(), null, '청산이 끝났는데 포지션이 남아 있다');
});

// ---- 진입 경로 회귀 ----

test('데몬: 시황을 모르면 진입하지 않고 사유를 남긴다', async () => {
  const boot = bootDaemon({ notices: feed(listingNotice()) });
  boot.d.setMode('watching');
  boot.d.setPrimed(false);
  await boot.d.pollOnce();
  boot.d.setMarketContext({ regime: null, multiplier: null, reason: '아직 평가 전' }, null);
  await boot.d.pollOnce();

  assert.equal(boot.d.getState().status, 'IDLE');
  const row = boot.d.getEvents().find((e) => e.grade === 'S');
  assert.ok(row, 'S급 재료가 화면에 남아야 한다');
  assert.match(String(row.reason), /시황/, `사유가 남지 않았다: ${row.reason}`);
});

test('데몬: 미상장 종목의 재료는 이름과 함께 거절 사유를 남긴다', async () => {
  const boot = bootDaemon({
    notices: feed(listingNotice('소파이(SOPH) KRW 마켓 디지털 자산 추가')),
  });
  boot.d.setMode('watching');
  boot.d.setPrimed(false);
  await boot.d.pollOnce();
  boot.d.setMarketContext({ regime: 'neutral', multiplier: 1, reason: 't' }, Date.now());
  await boot.d.pollOnce();

  const row = boot.d.getEvents().find((e) => e.grade === 'S');
  assert.ok(row);
  assert.deepEqual(row.candidateTickers, ['SOPH'], '후보 티커를 화면 기록에 남긴다');
  assert.equal(row.target, 'SOPH');
  assert.match(String(row.reason), /SOPH/);
});
