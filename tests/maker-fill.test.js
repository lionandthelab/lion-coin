const { test } = require('node:test');
const assert = require('node:assert/strict');

const { openPending, checkFill, summarizeFills } = require('../src/maker-fill');

// 지정가 체결 실측. **이 전략의 남은 최대 미지수다.**
//
// 순기대값 +11.7bps는 왕복 비용 8bps(지정가)를 전제한다. 시장가로 밀리면 15bps가 되어
// +4.7bps로 줄어든다. 그런데 진입 시점이 하필 급락 직후 — 호가가 가장 벌어진 순간이다.
//
// 실주문 없이도 잴 수 있다: 신호 순간의 매수호가를 기록해 두고, 이후 봉의 저가가
// 그 값에 닿았는지 보면 지정가가 체결됐을지 알 수 있다. 공개 데이터만으로 된다.

const c = (low, high = low + 10, close = low + 5) => ({ low, high, close, openTime: 0 });

test('openPending: 신호 순간의 매수호가와 시각을 붙잡는다', () => {
  const p = openPending({ symbol: 'BTC', at: 1000, bid: 99, ask: 101, expireBars: 4 });
  assert.equal(p.symbol, 'BTC');
  assert.equal(p.limitPrice, 99, '매수호가에 건다 — 스프레드를 내지 않는 쪽');
  assert.equal(p.filled, false);
  assert.equal(p.barsWaited, 0);
});

test('openPending: 호가가 뒤집혔으면 거부한다', () => {
  // 매도호가가 매수호가보다 낮으면 데이터가 잘못된 것이다
  assert.throws(() => openPending({ symbol: 'X', at: 1, bid: 101, ask: 99, expireBars: 4 }), /호가/);
});

// ---- 체결 판정 ----

test('checkFill: 저가가 지정가에 닿으면 체결', () => {
  const p = openPending({ symbol: 'BTC', at: 0, bid: 100, ask: 101, expireBars: 4 });
  const r = checkFill(p, c(99));
  assert.equal(r.filled, true);
  assert.equal(r.fillPrice, 100, '지정가에 체결된다 — 더 유리해도 보수적으로 지정가로 본다');
  assert.equal(r.barsWaited, 1);
});

test('checkFill: 저가가 지정가에 안 닿으면 미체결', () => {
  const p = openPending({ symbol: 'BTC', at: 0, bid: 100, ask: 101, expireBars: 4 });
  const r = checkFill(p, c(101));
  assert.equal(r.filled, false);
  assert.equal(r.barsWaited, 1);
  assert.equal(r.expired, false);
});

test('checkFill: 저가가 지정가와 정확히 같으면 체결로 본다', () => {
  const p = openPending({ symbol: 'BTC', at: 0, bid: 100, ask: 101, expireBars: 4 });
  assert.equal(checkFill(p, c(100)).filled, true);
});

test('checkFill: 대기 봉을 넘기면 만료 — 미체결로 확정', () => {
  let p = openPending({ symbol: 'BTC', at: 0, bid: 100, ask: 101, expireBars: 2 });
  p = checkFill(p, c(101));
  assert.equal(p.expired, false);
  p = checkFill(p, c(102));
  assert.equal(p.expired, true, '2봉을 기다렸으면 만료');
  assert.equal(p.filled, false);
});

test('checkFill: 이미 체결된 건은 다시 판정하지 않는다', () => {
  let p = openPending({ symbol: 'BTC', at: 0, bid: 100, ask: 101, expireBars: 4 });
  p = checkFill(p, c(99));
  const again = checkFill(p, c(200));
  assert.equal(again.filled, true, '체결 상태가 뒤집히면 통계가 오염된다');
  assert.equal(again.barsWaited, 1, '체결 후에는 대기 봉이 늘지 않는다');
});

test('checkFill: 만료된 건도 다시 판정하지 않는다', () => {
  let p = openPending({ symbol: 'BTC', at: 0, bid: 100, ask: 101, expireBars: 1 });
  p = checkFill(p, c(101));
  assert.equal(p.expired, true);
  const again = checkFill(p, c(50));
  assert.equal(again.filled, false, '만료 후 값이 내려와도 체결로 세면 안 된다');
});

// ---- 집계 ----

test('summarizeFills: 체결률과 평균 대기 봉을 낸다', () => {
  const s = summarizeFills([
    { filled: true, barsWaited: 1 }, { filled: true, barsWaited: 3 },
    { filled: false, expired: true, barsWaited: 4 },
  ]);
  assert.equal(s.total, 3);
  assert.equal(s.filled, 2);
  assert.ok(Math.abs(s.fillRate - 2 / 3) < 1e-9);
  assert.equal(s.avgBarsToFill, 2, '체결된 건만 평균낸다');
});

test('summarizeFills: 아직 판정 안 난 건은 세지 않는다', () => {
  // 대기 중인 주문을 미체결로 세면 체결률이 실제보다 낮게 나온다
  const s = summarizeFills([
    { filled: true, barsWaited: 1 },
    { filled: false, expired: false, barsWaited: 1 },
  ]);
  assert.equal(s.total, 1, '판정이 끝난 건만 센다');
  assert.equal(s.fillRate, 1);
});

test('summarizeFills: 표본이 없으면 0으로 위장하지 않는다', () => {
  const s = summarizeFills([]);
  assert.equal(s.total, 0);
  assert.equal(s.fillRate, null);
  assert.equal(s.avgBarsToFill, null);
});

test('summarizeFills: 체결이 하나도 없으면 평균 대기는 null', () => {
  const s = summarizeFills([{ filled: false, expired: true, barsWaited: 4 }]);
  assert.equal(s.fillRate, 0);
  assert.equal(s.avgBarsToFill, null);
});
