'use strict';

// 브라우저용 최소 CommonJS 번들러 — 순수 함수.
//
// 랩 UI(트랙 F)는 정적 페이지에서 백테스트를 돌려야 한다. 엔진 모듈들은 외부
// 의존이 전혀 없고 서로만 require하므로, webpack 같은 빌드 도구를 새로 들이는 대신
// 최소 셈으로 감싼다. 의존이 생기면 그때 도구를 고민한다.
//
// 셈이 틀리면 브라우저에서만 조용히 깨지므로, 번들 결과를 실제로 실행해 검증한다
// (tests/bundle.test.js).

function bundleModules(files, globalName = 'LAB') {
  if (!Array.isArray(files) || files.length === 0) {
    throw new Error('번들할 모듈이 비어 있습니다');
  }

  const registry = files
    .map(
      (f) =>
        `__defs[${JSON.stringify(f.name)}] = function (module, exports, require) {\n${f.source}\n};`
    )
    .join('\n');

  return `(function () {
var __defs = {};
var __cache = {};
function __require(name) {
  // './backtest' 같은 상대 경로와 'backtest' 둘 다 받는다.
  var key = String(name).replace(/^\\.\\//, '').replace(/\\.js$/, '');
  if (Object.prototype.hasOwnProperty.call(__cache, key)) return __cache[key].exports;
  if (!Object.prototype.hasOwnProperty.call(__defs, key)) {
    // 조용히 undefined를 돌려주면 호출부에서 한참 뒤에야 터진다.
    throw new Error('번들에 없는 모듈입니다: ' + key);
  }
  var mod = { exports: {} };
  __cache[key] = mod;
  __defs[key](mod, mod.exports, __require);
  return mod.exports;
}
${registry}
globalThis[${JSON.stringify(globalName)}] = { require: __require, modules: Object.keys(__defs) };
})();`;
}

module.exports = { bundleModules };
