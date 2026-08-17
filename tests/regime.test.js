const { test } = require('node:test');
const assert = require('node:assert/strict');

const { classifyRegime, regimeSeries, TREND_BARS, VOL_BARS, PCT_BARS } = require('../src/regime');

const MIN = 1800000; // 30분

// 국면 판정의 유일한 안전 요건은 **인과성**이다. i봉의 국면을 정할 때 i+1봉 이후를
// 한 톨이라도 보면, 백테스트에서는 잘 되고 실전에서는 재현되지 않는다.
// 전 구간을 보고 "이 구간은 하락장이었다"고 나누는 것이 정확히 그 실수다.
//
// 실제로 이 프로젝트에서 정적 국면 필터(bear/turbulent만 매매)는 심볼 홀드아웃
// 세 번을 통과하고도 시간축 홀드아웃에서 뒤집혔다 — 국면이 BTC 하나로 정해지므로
// 심볼을 나눠도 독립 표본이 생기지 않았기 때문이다. docs/regime-validation.md 참조.

function series(closes) {
  return closes.map((close, i) => ({
    openTime: i * MIN, open: close, high: close * 1.001, low: close * 0.999, close, volume: 1,
  }));
}
// 워밍업(추세 48봉·변동성 백분위 480봉)을 채운 뒤 마지막 구간만 원하는 모양으로 만든다
function withWarmup(tail, level = 100) {
  const warm = [];
  for (let i = 0; i < PCT_BARS + VOL_BARS + TREND_BARS + 10; i += 1) {
    warm.push(level * (1 + (i % 2 ? 0.001 : -0.001))); // 잔잔한 톱니
  }
  return series([...warm, ...tail]);
}

test('classifyRegime: 24시간 수익률이 -2% 아래면 하락 국면', () => {
  const drop = [];
  for (let i = 0; i < TREND_BARS; i += 1) drop.push(100 * (1 - 0.05 * (i + 1) / TREND_BARS));
  const r = classifyRegime(withWarmup(drop));
  assert.equal(r.trend, 'bear', `24시간 -5%인데 ${r.trend}`);
});

test('classifyRegime: 24시간 수익률이 +2% 위면 상승 국면', () => {
  const up = [];
  for (let i = 0; i < TREND_BARS; i += 1) up.push(100 * (1 + 0.05 * (i + 1) / TREND_BARS));
  assert.equal(classifyRegime(withWarmup(up)).trend, 'bull');
});

test('classifyRegime: ±2% 안이면 횡보 국면', () => {
  const flat = Array.from({ length: TREND_BARS }, (_, i) => 100 * (1 + (i % 2 ? 0.002 : -0.002)));
  assert.equal(classifyRegime(withWarmup(flat)).trend, 'flat');
});

test('classifyRegime: 변동성이 직전 480봉 상위면 turbulent', () => {
  // 잔잔한 워밍업 뒤에 큰 폭으로 흔들면 백분위가 최상단이 된다
  const wild = Array.from({ length: TREND_BARS }, (_, i) => 100 * (1 + (i % 2 ? 0.04 : -0.04)));
  assert.equal(classifyRegime(withWarmup(wild)).vol, 'turbulent');
});

test('classifyRegime: 워밍업이 모자라면 국면을 만들어내지 않고 null', () => {
  // 없는 과거를 추정해 국면을 붙이면 초반 구간이 통째로 거짓 신호가 된다
  const r = classifyRegime(series(Array.from({ length: 50 }, () => 100)));
  assert.equal(r.label, null);
});

test('classifyRegime: label은 추세/변동성을 합친 문자열', () => {
  const drop = [];
  for (let i = 0; i < TREND_BARS; i += 1) drop.push(100 * (1 - 0.05 * (i + 1) / TREND_BARS));
  const r = classifyRegime(withWarmup(drop));
  assert.equal(r.label, `${r.trend}/${r.vol}`);
});

// ---- 인과성 (가장 중요) ----

test('classifyRegime: 미래 봉을 덧붙여도 같은 시점의 판정이 바뀌지 않는다', () => {
  const drop = [];
  for (let i = 0; i < TREND_BARS; i += 1) drop.push(100 * (1 - 0.05 * (i + 1) / TREND_BARS));
  const base = withWarmup(drop);
  const before = classifyRegime(base);

  // 뒤에 폭등을 붙인다. 인과적이라면 마지막 봉 기준 판정은 그대로여야 한다.
  const future = base.concat(series(Array.from({ length: 100 }, () => 500)).map((c, i) => ({
    ...c, openTime: base[base.length - 1].openTime + (i + 1) * MIN,
  })));
  const after = classifyRegime(future.slice(0, base.length));
  assert.deepEqual(after, before, '미래를 붙였다고 과거 판정이 바뀌면 미래 참조다');
});

test('regimeSeries: 각 봉의 국면을 그 봉까지의 데이터만으로 매긴다', () => {
  const drop = [];
  for (let i = 0; i < TREND_BARS; i += 1) drop.push(100 * (1 - 0.05 * (i + 1) / TREND_BARS));
  const c = withWarmup(drop);
  const s = regimeSeries(c);
  assert.equal(s.length, c.length);
  assert.equal(s[10], null, '워밍업 구간은 국면 없음');

  // 매 시점을 잘라서 개별 판정한 것과 일치해야 한다 — 이게 인과성의 정의다
  for (const i of [c.length - 1, c.length - 5, PCT_BARS + VOL_BARS + TREND_BARS + 5]) {
    assert.equal(s[i], classifyRegime(c.slice(0, i + 1)).label, `${i}번 봉 불일치`);
  }
});

test('regimeSeries: 빈 배열도 안전하게 처리한다', () => {
  assert.deepEqual(regimeSeries([]), []);
});
