const { test } = require('node:test');
const assert = require('node:assert/strict');

const { runBacktest, summarize } = require('../src/backtest');

const near = (actual, expected, msg) =>
  assert.ok(Math.abs(actual - expected) < 1e-9, `${msg ?? ''} — got ${actual}, want ${expected}`);

function candle(openTime, open, high, low, close) {
  return { openTime, open, high, low, close, volume: 1, closeTime: openTime + 3599999 };
}

// 시가/종가만으로 손계산이 가능하도록 만든 4봉 픽스처
//        시가   종가
// c0     100    100
// c1     100    110
// c2     110    120
// c3     120    100
function fixture() {
  return [
    candle(0, 100, 110, 90, 100),
    candle(3600000, 100, 120, 95, 110),
    candle(7200000, 110, 130, 105, 120),
    candle(10800000, 120, 125, 90, 100),
  ];
}

const FREE = { feeBps: 0, slippageBps: 0, initialEquity: 1000 };

// ---- 체결 규약 (확장 제안서 §3-2) ----

test('runBacktest: i봉 종가로 낸 판단은 i+1봉 시가에 체결된다 (룩어헤드 차단)', () => {
  const r = runBacktest({ candles: fixture(), targetPositions: [1, 1, 0, 0], ...FREE });
  // tp[0]=1 → c1 시가 100에 매수, tp[2]=0 → c3 시가 120에 매도
  assert.equal(r.trades.length, 1);
  assert.equal(r.trades[0].entryIndex, 1);
  near(r.trades[0].entryPrice, 100, '진입가는 c1 시가');
  assert.equal(r.trades[0].exitIndex, 3);
  near(r.trades[0].exitPrice, 120, '청산가는 c3 시가');
});

test('runBacktest: 자산곡선은 각 봉 종가로 평가된다', () => {
  const r = runBacktest({ candles: fixture(), targetPositions: [1, 1, 0, 0], ...FREE });
  // c0: 미체결 1000 · c1: 10주×110 · c2: 10주×120 · c3: 청산 후 현금 1200
  assert.deepEqual(r.equity, [1000, 1100, 1200, 1200]);
  near(r.finalEquity, 1200);
});

test('runBacktest: 첫 봉에서는 체결이 일어나지 않는다 (직전 판단이 없음)', () => {
  const r = runBacktest({ candles: fixture(), targetPositions: [1, 1, 1, 1], ...FREE });
  assert.equal(r.equity[0], 1000);
  assert.equal(r.trades.length, 0); // 끝까지 보유 → 청산된 트레이드 없음
});

test('runBacktest: 마지막 봉의 판단은 체결 기회가 없어 무시된다', () => {
  const r = runBacktest({ candles: fixture(), targetPositions: [0, 0, 0, 1], ...FREE });
  assert.deepEqual(r.equity, [1000, 1000, 1000, 1000]);
  assert.equal(r.trades.length, 0);
  assert.equal(r.open, null);
});

test('runBacktest: 미청산 포지션은 trades에 넣지 않되 자산곡선에는 반영한다', () => {
  const r = runBacktest({ candles: fixture(), targetPositions: [1, 1, 1, 1], ...FREE });
  assert.equal(r.trades.length, 0);
  assert.equal(r.open.entryIndex, 1);
  near(r.equity[3], 1000, '10주 × c3 종가 100');
});

// ---- 비용 (확장 제안서 §3-2: 비용 0인 결과는 공개하지 않는다) ----

test('runBacktest: 수수료를 켜면 같은 신호의 성과가 반드시 나빠진다', () => {
  const args = { candles: fixture(), targetPositions: [1, 1, 0, 0] };
  const free = runBacktest({ ...args, ...FREE });
  const paid = runBacktest({ ...args, feeBps: 10, slippageBps: 0, initialEquity: 1000 });
  assert.ok(paid.finalEquity < free.finalEquity);
  // 명목은 자기자본 전액(1000)으로 잡고 수수료는 잔고에서 차감한다(증거금 방식).
  // 진입: 10주, 수수료 1 → 현금 -1 · 청산: 10×120에서 0.1%(1.2) 차감
  near(paid.finalEquity, -1 + 1200 - 1.2);
});

test('runBacktest: 슬리피지는 매수가를 올리고 매도가를 내린다', () => {
  const r = runBacktest({
    candles: fixture(),
    targetPositions: [1, 1, 0, 0],
    feeBps: 0,
    slippageBps: 100,
    initialEquity: 1000,
  });
  near(r.trades[0].entryPrice, 101, '100 × 1.01');
  near(r.trades[0].exitPrice, 118.8, '120 × 0.99');
  assert.ok(r.finalEquity < 1200);
});

// ---- 트레이드 기록 ----

test('runBacktest: 트레이드에 진입·청산 시각과 손익을 기록한다', () => {
  const r = runBacktest({ candles: fixture(), targetPositions: [1, 1, 0, 0], ...FREE });
  const t = r.trades[0];
  assert.equal(t.entryTime, 3600000);
  assert.equal(t.exitTime, 10800000);
  near(t.entryEquity, 1000);
  near(t.exitEquity, 1200);
  near(t.pnl, 200);
  near(t.returnPct, 20);
});

// ---- 입력 검증 ----

test('runBacktest: 캔들이 비어 있으면 TypeError', () => {
  assert.throws(() => runBacktest({ candles: [], targetPositions: [] }), TypeError);
  assert.throws(() => runBacktest({ candles: null, targetPositions: [] }), TypeError);
});

test('runBacktest: 신호 길이가 캔들 수와 다르면 TypeError (정렬 어긋남 차단)', () => {
  assert.throws(() => runBacktest({ candles: fixture(), targetPositions: [1, 0] }), TypeError);
});

test('runBacktest: 신호가 수가 아니면 TypeError', () => {
  assert.throws(() => runBacktest({ candles: fixture(), targetPositions: [1, '1', 0, 0] }), TypeError);
  assert.throws(() => runBacktest({ candles: fixture(), targetPositions: [1, null, 0, 0] }), TypeError);
});

test('runBacktest: 비용·초기자본이 음수/0이면 RangeError', () => {
  const args = { candles: fixture(), targetPositions: [1, 1, 0, 0] };
  assert.throws(() => runBacktest({ ...args, feeBps: -1 }), RangeError);
  assert.throws(() => runBacktest({ ...args, slippageBps: -1 }), RangeError);
  assert.throws(() => runBacktest({ ...args, initialEquity: 0 }), RangeError);
});

// ---- summarize ----

// 승리 1회(+200) · 패배 1회(-400)가 나오도록 만든 5봉 픽스처
function twoTradeFixture() {
  return [
    candle(0, 100, 100, 100, 100),
    candle(1, 100, 120, 100, 120),
    candle(2, 120, 120, 120, 120),
    candle(3, 120, 120, 80, 80),
    candle(4, 80, 80, 80, 80),
  ];
}

function twoTradeResult() {
  return runBacktest({ candles: twoTradeFixture(), targetPositions: [1, 0, 1, 0, 0], ...FREE });
}

test('summarize: 총수익률은 초기자본 대비 최종자산으로 계산한다', () => {
  const r = twoTradeResult();
  assert.deepEqual(r.equity, [1000, 1200, 1200, 800, 800]);
  near(summarize(r).totalReturnPct, -20);
});

test('summarize: 최대낙폭은 자산곡선의 고점 대비 최대 하락폭', () => {
  near(summarize(twoTradeResult()).maxDrawdownPct, (400 / 1200) * 100);
});

test('summarize: 트레이드 수·승률·손익비', () => {
  const s = summarize(twoTradeResult());
  assert.equal(s.tradeCount, 2);
  assert.equal(s.winCount, 1);
  near(s.winRatePct, 50);
  near(s.profitFactor, 0.5); // 이익 200 / 손실 400
});

test('summarize: 트레이드가 없으면 승률·손익비는 null (0으로 위장하지 않는다)', () => {
  const r = runBacktest({ candles: fixture(), targetPositions: [0, 0, 0, 0], ...FREE });
  const s = summarize(r);
  assert.equal(s.tradeCount, 0);
  assert.equal(s.winRatePct, null);
  assert.equal(s.profitFactor, null);
  near(s.totalReturnPct, 0);
  near(s.maxDrawdownPct, 0);
});

test('summarize: 손실 트레이드가 없으면 손익비는 null (Infinity를 지표로 쓰지 않는다)', () => {
  const r = runBacktest({ candles: fixture(), targetPositions: [1, 1, 0, 0], ...FREE });
  const s = summarize(r);
  assert.equal(s.tradeCount, 1);
  assert.equal(s.profitFactor, null);
  near(s.winRatePct, 100);
});

// ---- 숏 지원 (롱/숏 양방향) ----
// 검증 6폴드 중 4개가 하락장이었고 롱 온리가 할 수 있는 최선은 "덜 잃기"였다.
// targetPositions에 -1을 허용해 하락에서도 수익이 가능한 구조로 넓힌다.
// 현물로는 불가능하고 무기한 선물이 전제이므로, 펀딩 비용도 함께 모델링한다.

test('runBacktest: -1은 숏 진입이며 가격이 내리면 수익이 난다', () => {
  const r = runBacktest({ candles: fixture(), targetPositions: [-1, -1, 0, 0], ...FREE });
  // c1 시가 100에 숏 → c3 시가 120에 커버 → 20% 손실
  assert.equal(r.trades.length, 1);
  assert.equal(r.trades[0].side, 'short');
  near(r.trades[0].entryPrice, 100);
  near(r.trades[0].exitPrice, 120);
  near(r.finalEquity, 800);
});

test('runBacktest: 하락 구간 숏은 수익이다', () => {
  // 시가 100 → 시가 80으로 내리는 3봉
  const down = [
    candle(0, 100, 100, 100, 100),
    candle(3600000, 100, 100, 90, 90),
    candle(7200000, 80, 80, 80, 80),
  ];
  const r = runBacktest({ candles: down, targetPositions: [-1, 0, 0], ...FREE });
  // c1 시가 100에 숏 → c2 시가 80에 커버 → +20%
  near(r.finalEquity, 1200);
});

test('runBacktest: 숏 보유 중 자산곡선은 가격과 반대로 움직인다', () => {
  const down = [
    candle(0, 100, 100, 100, 100),
    candle(3600000, 100, 100, 90, 90),
    candle(7200000, 90, 90, 80, 80),
  ];
  const r = runBacktest({ candles: down, targetPositions: [-1, -1, -1], ...FREE });
  // c1 시가 100 숏 진입, 종가 90 → +10% / c2 종가 80 → +20%
  assert.deepEqual(r.equity, [1000, 1100, 1200]);
});

test('runBacktest: 롱에서 숏으로 뒤집으면 청산과 진입 수수료가 모두 든다', () => {
  const args = { candles: fixture(), targetPositions: [1, -1, -1, -1] };
  const free = runBacktest({ ...args, ...FREE });
  const paid = runBacktest({ ...args, feeBps: 10, slippageBps: 0, initialEquity: 1000 });
  assert.equal(free.trades.length, 1, '롱 한 건이 청산됨');
  assert.equal(free.trades[0].side, 'long');
  assert.ok(paid.finalEquity < free.finalEquity);
});

test('runBacktest: 신호가 -1/0/1이 아니면 TypeError', () => {
  assert.throws(() => runBacktest({ candles: fixture(), targetPositions: [2, 0, 0, 0] }), TypeError);
  assert.throws(
    () => runBacktest({ candles: fixture(), targetPositions: [-2, 0, 0, 0] }),
    TypeError
  );
});

// ---- 펀딩 비용 ----
// 무기한 선물은 8시간마다 펀딩을 주고받는다. 롱은 펀딩이 양수일 때 지불한다.
// 이걸 빼먹으면 장기 보유 전략의 성과가 실제보다 좋게 나온다.

function withFunding(rows) {
  return rows.map(([open, close, funding, settled], i) => ({
    openTime: i * 3600000,
    open,
    high: Math.max(open, close),
    low: Math.min(open, close),
    close,
    volume: 1,
    closeTime: i * 3600000 + 3599999,
    funding,
    fundingSettled: settled,
  }));
}

test('runBacktest: fundingCost를 켜면 롱은 양의 펀딩을 지불한다', () => {
  const c = withFunding([
    [100, 100, 0.001, false],
    [100, 100, 0.001, true],
  ]);
  const off = runBacktest({ candles: c, targetPositions: [1, 1], ...FREE });
  const on = runBacktest({ candles: c, targetPositions: [1, 1], ...FREE, fundingCost: true });
  near(off.finalEquity, 1000, '펀딩 미적용이면 가격이 안 움직였으니 그대로');
  near(on.finalEquity, 999, '명목 1000 × 0.1% 지불');
});

test('runBacktest: 숏은 양의 펀딩을 수취한다', () => {
  const c = withFunding([
    [100, 100, 0.001, false],
    [100, 100, 0.001, true],
  ]);
  const on = runBacktest({ candles: c, targetPositions: [-1, -1], ...FREE, fundingCost: true });
  near(on.finalEquity, 1001);
});

test('runBacktest: 정산 봉이 아니면 펀딩을 물리지 않는다', () => {
  const c = withFunding([
    [100, 100, 0.001, false],
    [100, 100, 0.001, false],
  ]);
  const on = runBacktest({ candles: c, targetPositions: [1, 1], ...FREE, fundingCost: true });
  near(on.finalEquity, 1000);
});

test('runBacktest: 포지션이 없으면 펀딩과 무관하다', () => {
  const c = withFunding([
    [100, 100, 0.01, true],
    [100, 100, 0.01, true],
  ]);
  const on = runBacktest({ candles: c, targetPositions: [0, 0], ...FREE, fundingCost: true });
  near(on.finalEquity, 1000);
});

// ---- 연속 노출 (포지션 사이징) ----
// 전량 진입/청산만 되면 포지션 사이징도 전략 포트폴리오도 시도할 수 없다.
// targetPositions를 [-1, 1] 연속값으로 넓혀 "자기자본의 몇 %를 노출할지"를 표현한다.
// 목표 노출이 바뀌면 **차액만** 거래한다 — 전량 청산 후 재진입으로 계산하면
// 회전이 잦은 전략의 수수료가 실제의 두 배로 잡힌다.

test('runBacktest: 0.5는 자기자본의 절반만 노출한다', () => {
  const r = runBacktest({ candles: fixture(), targetPositions: [0.5, 0.5, 0.5, 0.5], ...FREE });
  // c1 시가 100에 5주(=500 노출) → c1 종가 110에서 자산 1000 + 5×10 = 1050
  near(r.equity[1], 1050);
});

test('runBacktest: 목표가 그대로면 거래가 일어나지 않는다', () => {
  const flat = [
    candle(0, 100, 100, 100, 100),
    candle(3600000, 100, 100, 100, 100),
    candle(7200000, 100, 100, 100, 100),
  ];
  const r = runBacktest({
    candles: flat,
    targetPositions: [1, 1, 1],
    feeBps: 100,
    slippageBps: 0,
    initialEquity: 1000,
  });
  // 목표가 그대로면 재조정이 없다 — 수수료는 진입 1회분(명목 1000 × 1%)만
  near(r.finalEquity, 990);
});

test('runBacktest: 노출을 늘리면 차액만큼만 거래한다', () => {
  const flat = [
    candle(0, 100, 100, 100, 100),
    candle(3600000, 100, 100, 100, 100),
    candle(7200000, 100, 100, 100, 100),
  ];
  // 0.5 진입(명목 500, 수수료 5) → 1.0으로 증액(차액 명목 ~500, 수수료 ~5)
  const r = runBacktest({
    candles: flat,
    targetPositions: [0.5, 1, 1],
    feeBps: 100,
    slippageBps: 0,
    initialEquity: 1000,
  });
  // 전량 청산 후 재진입이었다면 수수료가 더 나갔을 것이다
  assert.ok(r.finalEquity > 989, `차액 거래여야 함: ${r.finalEquity}`);
  assert.ok(r.finalEquity < 996);
});

test('runBacktest: 음수 소수는 부분 숏이다', () => {
  const down = [
    candle(0, 100, 100, 100, 100),
    candle(3600000, 100, 100, 90, 90),
    candle(7200000, 90, 90, 90, 90),
  ];
  const r = runBacktest({ candles: down, targetPositions: [-0.5, -0.5, -0.5], ...FREE });
  // 절반 숏이므로 가격 -10%에서 자산 +5%
  near(r.equity[1], 1050);
});

test('runBacktest: 노출이 [-1, 1]을 벗어나면 TypeError (레버리지는 범위 밖)', () => {
  assert.throws(() => runBacktest({ candles: fixture(), targetPositions: [1.5, 0, 0, 0] }), TypeError);
  assert.throws(() => runBacktest({ candles: fixture(), targetPositions: [-2, 0, 0, 0] }), TypeError);
  assert.throws(() => runBacktest({ candles: fixture(), targetPositions: [NaN, 0, 0, 0] }), TypeError);
});

test('runBacktest: 부분 노출도 트레이드로 기록된다', () => {
  const r = runBacktest({ candles: fixture(), targetPositions: [0.5, 0.5, 0, 0], ...FREE });
  assert.equal(r.trades.length, 1);
  assert.equal(r.trades[0].side, 'long');
});

// ---- 메이커/테이커 체결 (초단타의 전제) ----
// 초단타는 봉당 움직임이 왕복 비용보다 작아 테이커로는 구조적으로 불가능하다
// (BTC 1분봉 중앙 1.5bps vs 테이커 왕복 14bps). 메이커 지정가는 왕복 4bps로
// 내려가지만 **체결이 보장되지 않는다** — 그 미체결 위험을 정직하게 모델링한다.

function bar(openTime, open, high, low, close) {
  return { openTime, open, high, low, close, volume: 1, closeTime: openTime + 59999 };
}

const MAKER = {
  execution: 'maker',
  makerFeeBps: 2,
  takerFeeBps: 5,
  makerOffsetBps: 20,
  initialEquity: 1000,
};

test('runBacktest: 메이커 매수는 시가보다 낮게 걸리고 저가가 닿으면 체결된다', () => {
  const c = [
    bar(0, 100, 100, 100, 100),
    bar(60000, 100, 101, 99, 100), // 저가 99 → 지정가 99.8에 닿음
    bar(120000, 100, 101, 99, 100),
  ];
  const r = runBacktest({ candles: c, targetPositions: [1, 1, 1], ...MAKER });
  assert.equal(r.trades.length, 0);
  assert.equal(r.open.side, 'long');
  near(r.open.entryPrice, 100 * (1 - 0.002), '시가 100 × (1 - 20bps)');
});

test('runBacktest: 저가가 지정가에 닿지 않으면 체결되지 않는다', () => {
  const c = [
    bar(0, 100, 100, 100, 100),
    bar(60000, 100, 101, 99.9, 101), // 저가 99.9 > 지정가 99.8
    bar(120000, 101, 101, 101, 101),
  ];
  const r = runBacktest({ candles: c, targetPositions: [1, 0, 0], ...MAKER });
  assert.equal(r.open, null, '미체결이어야 함');
  near(r.finalEquity, 1000, '거래가 없으니 자산 그대로');
});

test('runBacktest: 미체결이면 다음 봉에서 다시 시도한다', () => {
  const c = [
    bar(0, 100, 100, 100, 100),
    bar(60000, 100, 101, 99.9, 101), // 미체결
    bar(120000, 100, 101, 99, 100), // 체결
  ];
  const r = runBacktest({ candles: c, targetPositions: [1, 1, 1], ...MAKER });
  assert.ok(r.open, '두 번째 시도에서 체결되어야 함');
  assert.equal(r.open.entryIndex, 2);
});

test('runBacktest: 메이커 매도는 시가보다 높게 걸리고 고가가 닿아야 체결된다', () => {
  const c = [
    bar(0, 100, 100, 100, 100),
    bar(60000, 100, 101, 99, 100), // 진입
    bar(120000, 100, 100.1, 99, 99), // 고가 100.1 < 지정가 100.2 → 청산 미체결
    bar(180000, 100, 101, 99, 100), // 고가 101 → 청산 체결
  ];
  const r = runBacktest({ candles: c, targetPositions: [1, 0, 0, 0], ...MAKER });
  assert.equal(r.trades.length, 1);
  assert.equal(r.trades[0].exitIndex, 3, '청산은 세 번째 봉에서');
  near(r.trades[0].exitPrice, 100 * 1.002);
});

test('runBacktest: 메이커 수수료가 테이커보다 낮아 같은 신호의 성과가 낫다', () => {
  const c = [
    bar(0, 100, 100, 100, 100),
    bar(60000, 100, 102, 98, 101),
    bar(120000, 101, 103, 99, 102),
    bar(180000, 102, 104, 100, 103),
  ];
  const taker = runBacktest({
    candles: c,
    targetPositions: [1, 1, 0, 0],
    execution: 'taker',
    takerFeeBps: 5,
    slippageBps: 2,
    initialEquity: 1000,
  });
  const maker = runBacktest({ candles: c, targetPositions: [1, 1, 0, 0], ...MAKER });
  assert.ok(maker.finalEquity > taker.finalEquity, `maker ${maker.finalEquity} vs taker ${taker.finalEquity}`);
});

test('runBacktest: execution 기본값은 taker이며 기존 동작을 유지한다', () => {
  const r = runBacktest({ candles: fixture(), targetPositions: [1, 1, 0, 0], ...FREE });
  assert.deepEqual(r.equity, [1000, 1100, 1200, 1200]);
});

test('runBacktest: 알 수 없는 execution은 RangeError', () => {
  assert.throws(
    () => runBacktest({ candles: fixture(), targetPositions: [1, 1, 0, 0], execution: 'iceberg' }),
    RangeError
  );
});

test('runBacktest: 메이커 미체결 봉에서도 보유 중이면 펀딩은 정산된다', () => {
  // 진입 후, 청산 지정가가 안 붙는 봉에서 펀딩 정산이 일어난다
  const c = [
    { openTime: 0, open: 100, high: 100, low: 100, close: 100, volume: 1, closeTime: 59999, funding: 0.001, fundingSettled: false },
    { openTime: 60000, open: 100, high: 101, low: 99, close: 100, volume: 1, closeTime: 119999, funding: 0.001, fundingSettled: false },
    // 청산 지정가(100.2)에 고가 100.1이 못 닿음 + 펀딩 정산 봉
    { openTime: 120000, open: 100, high: 100.1, low: 99.5, close: 100, volume: 1, closeTime: 179999, funding: 0.001, fundingSettled: true },
  ];
  const withFund = runBacktest({ candles: c, targetPositions: [1, 0, 0], ...MAKER, fundingCost: true });
  const without = runBacktest({ candles: c, targetPositions: [1, 0, 0], ...MAKER, fundingCost: false });
  assert.ok(
    withFund.finalEquity < without.finalEquity,
    `미체결 봉에서도 펀딩이 나가야 함: ${withFund.finalEquity} vs ${without.finalEquity}`
  );
});
