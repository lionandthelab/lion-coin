const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');

const { bundleModules } = require('../harness/lib/bundle');

// 랩 UI는 정적 페이지에서 백테스트를 돌려야 한다. 번들러를 새로 들이는 대신
// 의존이 없는 순수 모듈들만 CommonJS 셈으로 감싼다. 셈이 틀리면 브라우저에서만
// 조용히 깨지므로, 번들 결과를 실제로 실행해 검증한다.

function evaluate(source) {
  const sandbox = { globalThis: {} };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);
  return sandbox.LAB;
}

test('bundleModules: 모듈을 감싸 require로 꺼낼 수 있게 만든다', () => {
  const lab = evaluate(
    bundleModules([{ name: 'a', source: 'module.exports = { hi: () => 42 };' }])
  );
  assert.equal(lab.require('a').hi(), 42);
});

test('bundleModules: 모듈 간 상대 경로 require를 해석한다', () => {
  const lab = evaluate(
    bundleModules([
      { name: 'dep', source: 'module.exports = { two: 2 };' },
      { name: 'main', source: "const { two } = require('./dep'); module.exports = { four: two * 2 };" },
    ])
  );
  assert.equal(lab.require('main').four, 4);
});

test('bundleModules: 같은 모듈을 두 번 require해도 한 번만 실행된다', () => {
  const lab = evaluate(
    bundleModules([
      { name: 'counter', source: 'globalThis.__n = (globalThis.__n || 0) + 1; module.exports = { n: globalThis.__n };' },
      { name: 'x', source: "module.exports = require('./counter');" },
      { name: 'y', source: "module.exports = require('./counter');" },
    ])
  );
  assert.equal(lab.require('x').n, 1);
  assert.equal(lab.require('y').n, 1);
});

test('bundleModules: 없는 모듈을 require하면 Error (조용히 undefined를 돌려주지 않는다)', () => {
  const lab = evaluate(bundleModules([{ name: 'a', source: 'module.exports = {};' }]));
  assert.throws(() => lab.require('nope'), /nope/);
});

test('bundleModules: use strict 지시문이 있는 소스도 감싼다', () => {
  const lab = evaluate(
    bundleModules([{ name: 'a', source: "'use strict';\nmodule.exports = { ok: true };" }])
  );
  assert.equal(lab.require('a').ok, true);
});

test('bundleModules: 모듈이 비어 있으면 Error', () => {
  assert.throws(() => bundleModules([]), /비어/);
});

// ---- 실제 엔진 모듈로 검증 ----

test('bundleModules: 실제 엔진을 번들해 브라우저 문맥에서 백테스트가 돌아간다', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const names = ['indicators', 'risk', 'backtest', 'strategies', 'research'];
  const files = names.map((name) => ({
    name,
    source: fs.readFileSync(path.join(__dirname, '..', 'src', `${name}.js`), 'utf8'),
  }));

  const lab = evaluate(bundleModules(files));
  const { runBacktest, summarize } = lab.require('backtest');
  const { STRATEGIES } = lab.require('strategies');

  const candles = Array.from({ length: 60 }, (_, i) => ({
    openTime: i * 3600000,
    open: 100 + i,
    high: 101 + i,
    low: 99 + i,
    close: 100 + i,
    volume: 1,
    closeTime: i * 3600000 + 3599999,
  }));

  const positions = STRATEGIES.emaCross(candles, { fast: 5, slow: 20 });
  const result = summarize(runBacktest({ candles, targetPositions: positions }));
  assert.equal(typeof result.totalReturnPct, 'number');
  assert.ok(Number.isFinite(result.maxDrawdownPct));
});
