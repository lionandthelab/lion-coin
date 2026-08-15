#!/usr/bin/env node
'use strict';

// 랩 UI 생성 — _site/lab.html (F2)
//
// 엔진을 브라우저로 번들하고, 캔들은 브라우저가 바이낸스에서 직접 받는다
// (공개 엔드포인트가 Access-Control-Allow-Origin: * 를 준다).
// 서버가 없으므로 GitHub Pages에 그대로 올라간다.

const fs = require('node:fs');
const path = require('node:path');
const { bundleModules } = require('../harness/lib/bundle');

const ROOT = path.join(__dirname, '..');
const OUT_DIR = path.join(ROOT, '_site');
const MODULES = ['indicators', 'risk', 'backtest', 'strategies', 'research', 'funding', 'klines'];

const universe = JSON.parse(fs.readFileSync(path.join(ROOT, 'harness', 'universe.json'), 'utf8'));

// 심볼 목록은 검증 유니버스에서 가져온다. 사용자가 아무 심볼이나 칠 수도 있어야 하므로
// datalist로 붙여 드롭다운과 직접 입력을 동시에 지원한다.
const SYMBOL_GROUPS = [
  { label: '메이저', symbols: universe.groups.majors },
  { label: '밈코인 (탐색)', symbols: universe.groups['meme-a'] },
  { label: '밈코인 (확인)', symbols: universe.groups['meme-b'] },
  { label: '상장폐지 (생존편향 대조)', symbols: universe.groups.delisted },
];

// 템플릿은 "돌려보면 무언가를 알게 되는" 조합만 넣는다. 파라미터를 처음부터
// 직접 채우게 하면 대부분 아무 의미 없는 결과를 보고 도구를 닫는다.
// note는 무엇을 보라는 안내이고, 결과가 좋다는 뜻이 아니다.
const TEMPLATES = [
  {
    name: '① 과최적화 함정 — 단일 백테스트는 왜 못 믿나',
    cfg: { symbol: 'BTCUSDT', interval: '1h', days: 730, strategy: 'emaCross', execution: 'taker', fee: 5,
      params: { fast: 20, slow: 100, atrStopMult: 3, dailyLossLimitPct: 5 } },
    note: '먼저 <b>백테스트 실행</b>을, 그다음 <b>워크포워드 검증</b>을 눌러 두 결과를 비교하세요. 같은 전략·같은 구간인데 판정이 갈립니다. 이 차이가 이 도구의 존재 이유입니다.',
  },
  {
    name: '② 청산 되받기 — 엣지는 있는데 비용 아래',
    cfg: { symbol: 'BTCUSDT', interval: '5m', days: 365, strategy: 'liquidationFade', execution: 'maker', fee: 2,
      params: { lookback: 100, volMult: 8, rangeMult: 3, holdBars: 6, atrStopMult: 3, dailyLossLimitPct: 5 } },
    note: '수수료를 <b>0</b>으로 바꿔 한 번, 원래대로 <b>2</b>로 한 번 돌려보세요. 신호 자체는 돈을 버는데 실행 비용이 그것을 넘습니다 — 초단타에서 가장 흔한 사망 원인입니다.',
  },
  {
    name: '③ 비용의 벽 — 테이커 vs 메이커',
    cfg: { symbol: 'BTCUSDT', interval: '5m', days: 180, strategy: 'liquidationFade', execution: 'taker', fee: 5,
      params: { lookback: 100, volMult: 8, rangeMult: 3, holdBars: 6, atrStopMult: 3, dailyLossLimitPct: 5 } },
    note: '체결을 <b>메이커</b>로 바꿔 다시 돌려보세요. 5분봉 BTC의 봉당 움직임 중앙값은 3.5bps인데 테이커 왕복은 14bps입니다 — 신호가 아니라 산수의 문제입니다.',
  },
  {
    name: '④ 같은 전략, 밈코인에서는 부호가 뒤집힌다',
    cfg: { symbol: '1000PEPEUSDT', interval: '15m', days: 365, strategy: 'liquidationFade', execution: 'maker', fee: 2,
      params: { lookback: 100, volMult: 8, rangeMult: 3, holdBars: 6, atrStopMult: 3, dailyLossLimitPct: 5 } },
    note: '②와 같은 전략입니다. 심볼을 <b>BTCUSDT</b>와 번갈아 넣어 비교하세요. "급락 = 일시적 강제 매도"라는 가정이 구조적 하락장에서는 거짓이 됩니다.',
  },
  {
    name: '⑤ 추세추종 롱숏 — 매수보유와 비교하기',
    cfg: { symbol: 'ETHUSDT', interval: '4h', days: 730, strategy: 'emaCrossLS', execution: 'taker', fee: 5,
      params: { fast: 20, slow: 100, atrStopMult: 3, dailyLossLimitPct: 5 } },
    note: '결과표의 <b>매수보유(같은 구간)</b> 줄을 함께 보세요. 하락장에서 덜 잃는 것은 수익이 아닙니다 — 게이트가 매수보유 초과를 요구하는 이유입니다.',
  },
  {
    name: '⑥ 필터가 신호를 죽일 때 — 레짐 게이트',
    cfg: { symbol: '1000PEPEUSDT', interval: '15m', days: 365, strategy: 'regimeGate', execution: 'maker', fee: 2,
      params: { inner: 'liquidationFade', innerParams: { lookback: 100, volMult: 8, rangeMult: 3, holdBars: 6 }, trendLookback: 200, atrStopMult: 3, dailyLossLimitPct: 5 } },
    note: '④와 비교하세요. 추세 역행 포지션을 걸러내면 나아질 것 같지만, 실제로는 거래 수가 줄면서 성과도 나빠집니다. 필터는 잡음만 걷어내지 않습니다.',
  },
];

const bundle = bundleModules(
  MODULES.map((name) => ({
    name,
    source: fs.readFileSync(path.join(ROOT, 'src', `${name}.js`), 'utf8'),
  }))
);

const html = `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>전략 랩 — 백테스트 검증기</title>
<style>
:root {
  color-scheme: light;
  --plane: #f9f9f7; --surface: #fcfcfb; --ink: #0b0b0b; --ink-2: #52514e; --muted: #898781;
  --hairline: rgba(11,11,11,0.10); --grid: #e1e0d9; --accent: #2a78d6;
  --good: #0ca30c; --good-text: #006300; --bad: #c0392b; --warning: #fab219;
}
@media (prefers-color-scheme: dark) {
  :root { --plane:#0d0d0d; --surface:#1a1a19; --ink:#fff; --ink-2:#c3c2b7; --muted:#898781;
    --hairline:rgba(255,255,255,0.10); --grid:#2c2c2a; --accent:#3987e5; --bad:#ff7b6b; color-scheme: dark; }
}
* { box-sizing: border-box; }
body { margin:0; background:var(--plane); color:var(--ink);
  font:15px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif; }
main { max-width: 980px; margin: 0 auto; padding: 32px 20px 64px; }
h1 { font-size: 24px; margin: 0 0 4px; }
h2 { font-size: 17px; margin: 28px 0 10px; }
.subtitle { color: var(--ink-2); margin: 0 0 24px; }
.subtitle a { color: var(--accent); }
.card { background:var(--surface); border:1px solid var(--hairline); border-radius:10px;
  padding:20px; margin-bottom:16px; }
.grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(160px,1fr)); gap:12px; }
label { display:block; font-size:12.5px; color:var(--ink-2); margin-bottom:4px; }
input, select, textarea { width:100%; padding:7px 9px; border:1px solid var(--grid);
  border-radius:6px; background:var(--plane); color:var(--ink); font:inherit; font-size:14px; }
textarea { font-family: ui-monospace, monospace; font-size:12.5px; min-height:64px; }
button { margin-top:14px; padding:9px 18px; border:none; border-radius:7px;
  background:var(--accent); color:#fff; font:inherit; font-weight:600; cursor:pointer; }
button:disabled { opacity:.5; cursor:default; }
button.secondary { background:transparent; color:var(--accent); border:1px solid var(--accent); margin-left:8px; }
table { width:100%; border-collapse:collapse; font-size:14px; }
th { text-align:left; color:var(--muted); font-weight:500; font-size:12.5px;
  border-bottom:1px solid var(--grid); padding:6px 8px; }
td { border-bottom:1px solid var(--grid); padding:8px; }
tr:last-child td { border-bottom:none; }
td.neg, .neg { color: var(--bad); }
td.pos, .pos { color: var(--good-text); }
.notes { color:var(--muted); font-size:12.5px; }
.warn { background:color-mix(in srgb,var(--warning) 14%,transparent); border:1px solid var(--warning);
  border-radius:8px; padding:10px 12px; font-size:13px; margin:0 0 14px; }
.verdict { font-size:16px; font-weight:600; margin: 4px 0 10px; }
.reasons { margin:0; padding-left:20px; color:var(--ink-2); font-size:13.5px; }
#status { color:var(--ink-2); font-size:13.5px; margin-top:10px; min-height:20px; }
svg.curve { width:100%; height:200px; display:block; }
footer { color:var(--muted); font-size:12.5px; margin-top:32px; }
footer a { color:var(--accent); }
</style>
</head>
<body>
<main>
<h1>전략 랩</h1>
<p class="subtitle">당신의 전략이 정말 통하는지 검증합니다 —
<a href="https://lionandthelab.github.io/lion-coin/">경과 대시보드</a> ·
<a href="https://github.com/lionandthelab/lion-coin">저장소</a></p>

<p class="warn"><strong>이 도구는 매매 조언이 아닙니다.</strong> 과거 데이터로 전략을 검증하는
계산기이며, 백테스트 결과는 미래 성과를 뜻하지 않습니다. 여기 내장된 전략들은
<a href="https://github.com/lionandthelab/lion-coin/blob/main/docs/walkforward-evaluation.md">전부 실거래 게이트를 통과하지 못했습니다</a>.</p>

<section class="card">
<label for="template">템플릿 — 돌려보면 무언가를 알게 되는 조합</label>
<select id="template">
  <option value="">(직접 설정)</option>
${TEMPLATES.map((t, i) => `  <option value="${i}">${t.name}</option>`).join('\n')}
</select>
<p id="tnote" class="notes" style="margin:8px 0 16px"></p>
<div class="grid">
  <div><label for="symbol">심볼</label>
    <input id="symbol" list="symbols" value="BTCUSDT" autocomplete="off">
    <datalist id="symbols">
${SYMBOL_GROUPS.map(
  (g) => g.symbols.map((sym) => `      <option value="${sym}">${g.label}</option>`).join('\n')
).join('\n')}
    </datalist>
  </div>
  <div><label for="interval">간격</label><select id="interval">
    <option>5m</option><option>15m</option><option selected>1h</option><option>4h</option><option>1d</option>
  </select></div>
  <div><label for="days">기간 (일)</label><input id="days" type="number" value="365" min="30" max="1500"></div>
  <div><label for="strategy">전략</label><select id="strategy"></select></div>
  <div><label for="execution">체결</label><select id="execution">
    <option value="taker">테이커 (시장가)</option><option value="maker">메이커 (지정가·미체결 위험)</option>
  </select></div>
  <div><label for="fee">수수료 (bps)</label><input id="fee" type="number" value="5" min="0" step="0.5"></div>
</div>
<div style="margin-top:12px"><label for="params">파라미터 (JSON)</label>
<textarea id="params">{ "fast": 20, "slow": 100, "atrStopMult": 3, "dailyLossLimitPct": 5 }</textarea></div>
<button id="run">백테스트 실행</button>
<button id="walk" class="secondary">워크포워드 검증</button>
<div id="status"></div>
</section>

<div id="out"></div>

<footer>엔진 소스: <a href="https://github.com/lionandthelab/lion-coin/tree/main/src">src/</a> ·
캔들은 브라우저가 바이낸스 공개 API에서 직접 받습니다 (서버 없음)</footer>
</main>

<script>
${bundle}
</script>
<script>
(function () {
  var backtest = LAB.require('backtest');
  var strategies = LAB.require('strategies');
  var klines = LAB.require('klines');
  var research = LAB.require('research');

  var PPY = { '5m': 105120, '15m': 35040, '1h': 8760, '4h': 2190, '1d': 365 };
  var $ = function (id) { return document.getElementById(id); };
  var status = $('status');
  var out = $('out');

  // 내부 도우미 전략(always/never)은 사용자에게 보여줄 것이 아니다.
  var HIDDEN = { always: 1, never: 1 };
  Object.keys(strategies.STRATEGIES).filter(function (n) { return !HIDDEN[n]; }).sort()
    .forEach(function (n) {
      var o = document.createElement('option');
      o.value = n; o.textContent = n;
      $('strategy').appendChild(o);
    });
  $('strategy').value = 'emaCross';

  var TEMPLATES = ${JSON.stringify(TEMPLATES)};
  $('template').addEventListener('change', function () {
    var t = TEMPLATES[this.value];
    if (!t) { $('tnote').innerHTML = ''; return; }
    $('symbol').value = t.cfg.symbol;
    $('interval').value = t.cfg.interval;
    $('days').value = t.cfg.days;
    $('strategy').value = t.cfg.strategy;
    $('execution').value = t.cfg.execution;
    $('fee').value = t.cfg.fee;
    $('params').value = JSON.stringify(t.cfg.params, null, 2);
    $('tnote').innerHTML = t.note;
    out.innerHTML = '';
  });

  function costs() {
    var exec = $('execution').value;
    var fee = Number($('fee').value);
    return {
      execution: exec,
      takerFeeBps: fee,
      makerFeeBps: exec === 'maker' ? fee : 2,
      makerOffsetBps: 2,
      slippageBps: 2,
      initialEquity: 1000,
      fundingCost: false,
    };
  }

  function pct(v) { return v == null ? 'n/a' : (v >= 0 ? '+' : '') + v.toFixed(2) + '%'; }
  function cls(v) { return v == null ? '' : v < 0 ? 'neg' : 'pos'; }

  function curve(values) {
    if (!values || values.length < 2) return '';
    var min = Math.min.apply(null, values), max = Math.max.apply(null, values);
    var span = (max - min) || 1;
    var pts = values.map(function (v, i) {
      var x = (i / (values.length - 1)) * 1000;
      var y = 190 - ((v - min) / span) * 180;
      return x.toFixed(1) + ',' + y.toFixed(1);
    }).join(' ');
    var up = values[values.length - 1] >= values[0];
    return '<svg class="curve" viewBox="0 0 1000 200" preserveAspectRatio="none">' +
      '<polyline points="' + pts + '" fill="none" stroke="' + (up ? 'var(--good)' : 'var(--bad)') +
      '" stroke-width="2" vector-effect="non-scaling-stroke"/></svg>';
  }

  async function loadCandles() {
    var interval = $('interval').value;
    var days = Math.max(1, Number($('days').value));
    var end = Date.now();
    var start = end - days * 86400000;
    status.textContent = '캔들 수집 중...';
    var c = await klines.fetchKlinesRange({
      symbol: $('symbol').value.trim().toUpperCase(),
      interval: interval, startTime: start, endTime: end, market: 'futures',
      onPage: function (n) { status.textContent = '캔들 수집 중... ' + n + '봉'; },
    });
    if (c.length < 200) throw new Error('봉이 너무 적습니다 (' + c.length + '). 기간을 늘리세요.');
    return c;
  }

  function positionsFor(candles) {
    var name = $('strategy').value;
    var params = JSON.parse($('params').value || '{}');
    return strategies.STRATEGIES[name](candles, params);
  }

  function metricsTable(m, extra) {
    var rows = [
      ['총수익률', pct(m.totalReturnPct), cls(m.totalReturnPct)],
      ['최대낙폭 (MDD)', m.maxDrawdownPct.toFixed(2) + '%', ''],
      ['CAGR', pct(m.cagrPct), cls(m.cagrPct)],
      ['샤프', m.sharpe == null ? 'n/a' : m.sharpe.toFixed(2), cls(m.sharpe)],
      ['Calmar', m.calmar == null ? 'n/a' : m.calmar.toFixed(2), ''],
    ].concat(extra || []);
    return '<table><tbody>' + rows.map(function (r) {
      return '<tr><td>' + r[0] + '</td><td class="' + r[2] + '">' + r[1] + '</td></tr>';
    }).join('') + '</tbody></table>';
  }

  async function runSingle() {
    var candles = await loadCandles();
    status.textContent = '백테스트 실행 중...';
    var positions = positionsFor(candles);
    var result = backtest.runBacktest(Object.assign({ candles: candles, targetPositions: positions }, costs()));
    var s = backtest.summarize(result);
    var m = research.curveMetrics(result.equity, { periodsPerYear: PPY[$('interval').value] });

    var bh = backtest.runBacktest(Object.assign(
      { candles: candles, targetPositions: candles.map(function () { return 1; }) }, costs()));
    var bhM = research.curveMetrics(bh.equity, { periodsPerYear: PPY[$('interval').value] });

    out.innerHTML =
      '<h2>백테스트 결과</h2><section class="card">' + curve(result.equity) +
      metricsTable(m, [
        ['트레이드 수', String(s.tradeCount), ''],
        ['승률', s.winRatePct == null ? 'n/a' : s.winRatePct.toFixed(1) + '%', ''],
        ['손익비', s.profitFactor == null ? 'n/a' : s.profitFactor.toFixed(2), ''],
        ['매수보유 (같은 구간)', pct(bhM.totalReturnPct), cls(bhM.totalReturnPct)],
      ]) +
      '<p class="notes">단일 구간 백테스트입니다. 파라미터를 이 구간에서 고르고 같은 구간에서 평가하면 ' +
      '과최적화를 잡을 수 없습니다 — <strong>워크포워드 검증</strong>을 함께 돌리세요.</p></section>';
    status.textContent = '';
  }

  async function runWalkForward() {
    var candles = await loadCandles();
    status.textContent = '워크포워드 검증 중...';
    var folds = research.buildFolds(candles.length, { foldCount: 6, firstTrainRatio: 0.4, minTestSize: 50 });
    if (!folds.length) throw new Error('폴드를 만들 수 없습니다. 기간을 늘리세요.');

    var params = JSON.parse($('params').value || '{}');
    var name = $('strategy').value;
    var segments = [], isRet = [], oosRet = [];

    for (var k = 0; k < folds.length; k++) {
      var f = folds[k];
      var pos = strategies.STRATEGIES[name](candles.slice(0, f.testEnd), params);
      segments.push({ from: f.trainEnd, to: f.testEnd, positions: pos });
      var tr = candles.slice(f.trainFrom, f.trainEnd);
      isRet.push(backtest.summarize(backtest.runBacktest(Object.assign(
        { candles: tr, targetPositions: strategies.STRATEGIES[name](tr, params) }, costs()))).totalReturnPct);
      var te = candles.slice(f.trainEnd, f.testEnd);
      oosRet.push(backtest.summarize(backtest.runBacktest(Object.assign(
        { candles: te, targetPositions: strategies.STRATEGIES[name](te, params) }, costs()))).totalReturnPct);
    }

    var stitched = research.stitchSegments(segments);
    var seg = candles.slice(stitched.from, stitched.to);
    var r = backtest.runBacktest(Object.assign({ candles: seg, targetPositions: stitched.positions }, costs()));
    var m = research.curveMetrics(r.equity, { periodsPerYear: PPY[$('interval').value] });
    var s = backtest.summarize(r);
    var wfe = research.walkForwardEfficiency(isRet, oosRet);

    var bh = backtest.runBacktest(Object.assign(
      { candles: seg, targetPositions: seg.map(function () { return 1; }) }, costs()));
    var bhM = research.curveMetrics(bh.equity, { periodsPerYear: PPY[$('interval').value] });

    var gate = research.evaluateWfGate({
      totalReturnPct: m.totalReturnPct, maxDrawdownPct: m.maxDrawdownPct,
      bhReturnPct: bhM.totalReturnPct, tradeCount: s.tradeCount, wfe: wfe,
    });

    out.innerHTML =
      '<h2>워크포워드 검증 <span class="notes">(' + folds.length + '폴드, 이어붙인 곡선)</span></h2>' +
      '<section class="card">' + curve(r.equity) +
      '<p class="verdict ' + (gate.passes ? 'pos' : 'neg') + '">' +
      (gate.passes ? '✅ 실거래 착수 게이트 통과' : '❌ 실거래 착수 게이트 미통과') + '</p>' +
      (gate.reasons.length ? '<ul class="reasons"><li>' + gate.reasons.map(function (x) {
        return x.replace(/</g, '&lt;');
      }).join('</li><li>') + '</li></ul>' : '') +
      metricsTable(m, [
        ['워크포워드 효율 (WFE)', wfe == null ? 'n/a' : wfe.toFixed(2), wfe != null && wfe < 0.2 ? 'neg' : 'pos'],
        ['트레이드 수', String(s.tradeCount), ''],
        ['매수보유 (같은 구간)', pct(bhM.totalReturnPct), cls(bhM.totalReturnPct)],
      ]) +
      '<p class="notes"><strong>WFE</strong>는 학습 구간 성과 대비 검증 구간에서 살아남은 비율입니다. ' +
      '0에 가까우면 학습 구간에만 맞춰진 것이고, 그 상태로 실거래에 들어가면 백테스트와 전혀 다른 결과가 나옵니다.</p>' +
      '</section>';
    status.textContent = '';
  }

  function guardRun(fn) {
    return async function () {
      $('run').disabled = $('walk').disabled = true;
      out.innerHTML = '';
      try { await fn(); }
      catch (e) { status.textContent = '오류: ' + e.message; }
      finally { $('run').disabled = $('walk').disabled = false; }
    };
  }

  $('run').addEventListener('click', guardRun(runSingle));
  $('walk').addEventListener('click', guardRun(runWalkForward));
})();
</script>
</body>
</html>
`;

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(path.join(OUT_DIR, 'lab.html'), html);
console.log(`빌드 완료: _site/lab.html (엔진 모듈 ${MODULES.length}개 번들, ${(html.length / 1024).toFixed(0)}KB)`);
