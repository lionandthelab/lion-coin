const { test } = require('node:test');
const assert = require('node:assert/strict');

const { candleChart, scaleY } = require('../src/chart');

const MIN = 60000;

function bars(rows) {
  return rows.map(([high, low, close, volume], i) => ({
    openTime: i * MIN,
    open: i === 0 ? close : rows[i - 1][2],
    high,
    low,
    close,
    volume,
    closeTime: i * MIN + MIN - 1,
  }));
}

// 포착된 이유를 눈으로 보려면 세 가지가 한 화면에 있어야 한다:
// 돌파선(직전 고가), 돌파한 봉, 그리고 그 봉의 거래량이 평소와 얼마나 다른지.
// 셋 중 하나라도 빠지면 "왜 잡혔는지"가 그림에서 사라진다.

// ---- scaleY ----

test('scaleY: 최고가는 위(작은 y), 최저가는 아래(큰 y)로 간다', () => {
  const s = scaleY({ min: 100, max: 200, top: 10, height: 100 });
  assert.equal(s(200), 10);
  assert.equal(s(100), 110);
});

test('scaleY: 값이 모두 같아도 NaN을 내지 않는다 (0으로 나누기)', () => {
  const s = scaleY({ min: 100, max: 100, top: 0, height: 100 });
  assert.ok(Number.isFinite(s(100)), '평평한 구간은 중앙에 그린다');
});

test('scaleY: 범위 밖 값도 유한한 좌표를 낸다', () => {
  const s = scaleY({ min: 100, max: 200, top: 0, height: 100 });
  assert.ok(Number.isFinite(s(500)));
});

// ---- candleChart ----

test('candleChart: 완결된 SVG를 만든다', () => {
  const svg = candleChart(bars([[110, 90, 100, 10], [120, 100, 115, 30]]), {});
  assert.match(svg, /^<svg /);
  assert.match(svg, /<\/svg>$/);
  assert.ok(!svg.includes('NaN'), svg.slice(0, 200));
});

test('candleChart: 봉 개수만큼 몸통을 그린다', () => {
  const svg = candleChart(bars([[110, 90, 100, 10], [120, 100, 115, 30], [118, 105, 110, 20]]), {});
  assert.equal((svg.match(/class="body/g) || []).length, 3);
});

test('candleChart: 상승봉과 하락봉의 클래스가 다르다', () => {
  const svg = candleChart(bars([[110, 90, 100, 10], [120, 100, 115, 30], [116, 100, 105, 20]]), {});
  assert.match(svg, /body up/);
  assert.match(svg, /body down/);
});

test('candleChart: 돌파선을 수평선으로 그린다', () => {
  const svg = candleChart(bars([[110, 90, 100, 10], [120, 100, 115, 30]]), { breakoutLevel: 110 });
  assert.match(svg, /class="level breakout"/);
});

test('candleChart: 익절·손절선을 각각 그린다', () => {
  const svg = candleChart(bars([[110, 90, 100, 10], [120, 100, 115, 30]]), {
    takeProfit: 117, stopLoss: 113,
  });
  assert.match(svg, /class="level tp"/);
  assert.match(svg, /class="level sl"/);
});

test('candleChart: 마지막 봉(돌파 봉)을 강조한다', () => {
  const svg = candleChart(bars([[110, 90, 100, 10], [120, 100, 115, 30]]), { highlightLast: true });
  assert.match(svg, /class="body up hit"/);
});

test('candleChart: 거래량 막대와 평균선을 함께 그린다', () => {
  const svg = candleChart(bars([[110, 90, 100, 10], [120, 100, 115, 30]]), { showVolume: true });
  assert.match(svg, /class="vol/);
  assert.match(svg, /class="volavg"/);
});

test('candleChart: 거래량이 모두 0이어도 NaN을 내지 않는다', () => {
  const svg = candleChart(bars([[110, 90, 100, 0], [120, 100, 115, 0]]), { showVolume: true });
  assert.ok(!svg.includes('NaN'), svg.slice(0, 300));
});

test('candleChart: 봉이 2개 미만이면 빈 문자열 (그릴 것이 없다)', () => {
  assert.equal(candleChart(bars([[110, 90, 100, 10]]), {}), '');
  assert.equal(candleChart([], {}), '');
});

test('candleChart: 주석 값이 캔들 범위 밖이어도 SVG가 깨지지 않는다', () => {
  const svg = candleChart(bars([[110, 90, 100, 10], [120, 100, 115, 30]]), {
    breakoutLevel: 99999, stopLoss: 0.0001,
  });
  assert.ok(!svg.includes('NaN'));
  assert.match(svg, /<\/svg>$/);
});

// 실제 렌더에서 드러난 버그: 9원대 코인(HEMI)에서 돌파선·익절·손절이
// 전부 "9"로 표기됐다. 정수 반올림이 소액 코인의 가격 차이를 통째로 지운다.

test('candleChart: 소액 코인은 소수점을 살려 표기한다', () => {
  const c = bars([[9.12, 9.01, 9.05, 10], [9.4, 9.1, 9.35, 30]]);
  const svg = candleChart(c, { breakoutLevel: 9.12, takeProfit: 9.54, stopLoss: 9.26 });
  assert.ok(!/돌파선 9</.test(svg), '정수로 뭉개지면 안 됨');
  assert.match(svg, /9\.\d/, '소수점이 보여야 함');
});

test('candleChart: 고액 코인은 정수로 표기한다 (소수점이 무의미)', () => {
  const c = bars([[89000000, 88000000, 88500000, 10], [90000000, 88500000, 89500000, 30]]);
  const svg = candleChart(c, { breakoutLevel: 89000000 });
  assert.ok(!/89000000\.\d/.test(svg), '고액에 소수점을 붙이지 않는다');
});

test('candleChart: 주석선 라벨이 서로 다른 위치에 놓인다 (겹침 방지)', () => {
  const svg = candleChart(bars([[110, 90, 100, 10], [120, 100, 115, 30]]), {
    breakoutLevel: 110, takeProfit: 111, stopLoss: 109,
  });
  const xs = [...svg.matchAll(/class="ltext [^"]*" x="(\d+)"/g)].map((m) => m[1]);
  assert.equal(new Set(xs).size, xs.length, `라벨 x가 겹침: ${xs}`);
});
