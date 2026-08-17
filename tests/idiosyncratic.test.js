const { test } = require('node:test');
const assert = require('node:assert/strict');

const { marketReturn, excessReturn, isIdiosyncraticDrop } = require('../src/idiosyncratic');

// 검증된 반전 신호 위에 얹는 층. **이 층이 신호를 아무것도 아닌 것에서 쓸 만한 것으로 바꾼다** —
// 조건 없이는 우위 +2.3bps인데, "시장이 아니라 그 코인만 빠졌을 때"로 좁히면 +25bps다.
//
// 근거는 여집합이 반대 부호라는 것이다(시장과 같이 빠진 경우 −8.2bps). 부분집합이 좋은 것은
// 선택 편의로도 생기지만, 여집합이 반대로 가는 것은 메커니즘이 있어야 나온다:
// 그 코인만 빠지면 유동성 사건이라 되돌아오고, 시장과 같이 빠지면 정보라 안 돌아온다.

const bar = (prev, close) => ({ prevClose: prev, close });

test('marketReturn: 여러 종목의 같은 봉 수익률 평균을 낸다', () => {
  const r = marketReturn([bar(100, 99), bar(200, 198), bar(50, 49.5)], { minSymbols: 3 });
  assert.ok(Math.abs(r - -100) < 1e-6, `전부 -1% → -100bps, 받은 값 ${r}`);
});

test('marketReturn: 종목이 모자라면 null (한두 종목으로 시장을 대표할 수 없다)', () => {
  assert.equal(marketReturn([bar(100, 99)], { minSymbols: 15 }), null);
});

test('marketReturn: 빈 입력은 null', () => {
  assert.equal(marketReturn([], { minSymbols: 1 }), null);
});

test('marketReturn: 유효하지 않은 봉은 빼고 센다', () => {
  // 0이나 음수 가격이 섞이면 수익률이 무한대가 되어 평균 전체를 오염시킨다
  const r = marketReturn([bar(100, 99), bar(0, 50), bar(100, 99)], { minSymbols: 2 });
  assert.ok(Math.abs(r - -100) < 1e-6);
});

test('excessReturn: 시장 대비 초과분을 낸다', () => {
  // 그 코인 -3%, 시장 -1% → 초과 -2% = -200bps
  assert.ok(Math.abs(excessReturn(-300, -100) - -200) < 1e-9);
});

test('excessReturn: 시장 수익률을 모르면 null (0으로 간주하지 않는다)', () => {
  // 시장을 0으로 가정하면 하락장 전체가 "고유 하락"으로 분류된다
  assert.equal(excessReturn(-300, null), null);
});

// ---- 판정 ----

test('isIdiosyncraticDrop: 시장보다 크게 빠졌으면 참', () => {
  assert.equal(isIdiosyncraticDrop({ ownReturnBps: -300, marketReturnBps: -50, threshold: -100 }), true);
});

test('isIdiosyncraticDrop: 시장과 같이 빠진 것은 거짓', () => {
  // 이쪽은 실측에서 우위가 -8.2bps로 **반대 부호**다. 걸러내야 하는 대상이다.
  assert.equal(isIdiosyncraticDrop({ ownReturnBps: -300, marketReturnBps: -280, threshold: -100 }), false);
});

test('isIdiosyncraticDrop: 시장이 오르는데 혼자 빠지면 더 확실한 고유 하락', () => {
  assert.equal(isIdiosyncraticDrop({ ownReturnBps: -100, marketReturnBps: 50, threshold: -100 }), true);
});

test('isIdiosyncraticDrop: 시장 수익률을 모르면 통과시키지 않는다', () => {
  // 판단 근거가 없을 때 통과시키면 이 층이 없는 것과 같아진다
  assert.equal(isIdiosyncraticDrop({ ownReturnBps: -300, marketReturnBps: null, threshold: -100 }), false);
});

test('isIdiosyncraticDrop: 임계값 경계는 미만일 때만 참', () => {
  assert.equal(isIdiosyncraticDrop({ ownReturnBps: -100, marketReturnBps: 0, threshold: -100 }), false);
  assert.equal(isIdiosyncraticDrop({ ownReturnBps: -101, marketReturnBps: 0, threshold: -100 }), true);
});

test('isIdiosyncraticDrop: 임계값은 음수여야 한다 (하락 조건이다)', () => {
  assert.throws(
    () => isIdiosyncraticDrop({ ownReturnBps: -300, marketReturnBps: 0, threshold: 100 }),
    /임계값/
  );
});
