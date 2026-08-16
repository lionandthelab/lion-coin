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
const MODULES = ['indicators', 'risk', 'backtest', 'strategies', 'research', 'funding', 'klines', 'labkit'];

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

const GROUPS = universe.groups;

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
  <div><label for="group">캠페인 유니버스</label><select id="group">
${Object.keys(GROUPS).map((g) => `    <option value="${g}">${g} (${GROUPS[g].length}종)</option>`).join('\n')}
  </select></div>
</div>
<div style="margin-top:12px"><label for="params">파라미터 (JSON)</label>
<textarea id="params">{ "fast": 20, "slow": 100, "atrStopMult": 3, "dailyLossLimitPct": 5 }</textarea></div>
<div id="customWrap" style="margin-top:12px; display:none">
  <label for="customCode">전략 코드 (함수 본문) — <code>candles</code>, <code>params</code>, <code>helpers</code>를 받아 노출 배열을 반환</label>
  <textarea id="customCode" style="min-height:150px"></textarea>
  <p class="notes" style="margin:6px 0 0">
    <code>helpers</code>: ema · sma · rsi · atr · closes · rollingPercentileRank ·
    반환값은 캔들 수와 길이가 같고 각 원소가 -1(전량 숏) ~ 1(전량 롱)이어야 합니다.
    <strong>코드는 이 브라우저에만 저장되며 공유 링크에 실리지 않습니다.</strong>
  </p>
</div>
<button id="run">백테스트 실행</button>
<button id="walk" class="secondary">워크포워드 검증</button>
<button id="campaign" class="secondary">캠페인 (탐색→확인)</button>
<button id="share" class="secondary">공유 링크 복사</button>
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
  var customOpt = document.createElement('option');
  customOpt.value = '__custom__';
  customOpt.textContent = '✎ 내 전략 (직접 작성)';
  $('strategy').insertBefore(customOpt, $('strategy').firstChild);
  $('strategy').value = 'emaCross';

  var GROUPS = ${JSON.stringify(GROUPS)};
  var labkit = LAB.require('labkit');

  var SAMPLE_CODE = [
    '// 20봉 이동평균 위면 롱, 아래면 숏',
    'var price = helpers.closes(candles);',
    'var ma = helpers.sma(price, params.period || 20);',
    'return candles.map(function (c, i) {',
    '  if (ma[i] == null) return 0;',
    '  return c.close > ma[i] ? 1 : -1;',
    '});',
  ].join(String.fromCharCode(10));

  var CUSTOM_KEY = 'lab.customCode';
  $('customCode').value = localStorage.getItem(CUSTOM_KEY) || SAMPLE_CODE;
  $('customCode').addEventListener('input', function () {
    localStorage.setItem(CUSTOM_KEY, this.value);
  });

  function syncCustomVisibility() {
    $('customWrap').style.display = $('strategy').value === '__custom__' ? 'block' : 'none';
  }
  $('strategy').addEventListener('change', syncCustomVisibility);
  syncCustomVisibility();

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

  function strategyFn() {
    var name = $('strategy').value;
    if (name === '__custom__') return labkit.compileUserStrategy($('customCode').value);
    return strategies.STRATEGIES[name];
  }

  function positionsFor(candles) {
    var params = JSON.parse($('params').value || '{}');
    return strategyFn()(candles, params);
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
    var fn = strategyFn();
    var segments = [], isRet = [], oosRet = [];

    for (var k = 0; k < folds.length; k++) {
      var f = folds[k];
      var pos = fn(candles.slice(0, f.testEnd), params);
      segments.push({ from: f.trainEnd, to: f.testEnd, positions: pos });
      var tr = candles.slice(f.trainFrom, f.trainEnd);
      isRet.push(backtest.summarize(backtest.runBacktest(Object.assign(
        { candles: tr, targetPositions: fn(tr, params) }, costs()))).totalReturnPct);
      var te = candles.slice(f.trainEnd, f.testEnd);
      oosRet.push(backtest.summarize(backtest.runBacktest(Object.assign(
        { candles: te, targetPositions: fn(te, params) }, costs()))).totalReturnPct);
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

  // 한 심볼에 대한 워크포워드 게이트 판정 — 캠페인이 심볼마다 이걸 부른다.
  async function gateFor(symbol, params, fn) {
    var interval = $('interval').value;
    var days = Math.max(1, Number($('days').value));
    var end = Date.now();
    var candles = await klines.fetchKlinesRange({
      symbol: symbol, interval: interval, startTime: end - days * 86400000,
      endTime: end, market: 'futures',
    });
    if (candles.length < 300) throw new Error(symbol + ': 봉 부족 (' + candles.length + ')');

    var folds = research.buildFolds(candles.length, { foldCount: 6, firstTrainRatio: 0.4, minTestSize: 50 });
    if (!folds.length) throw new Error(symbol + ': 폴드 생성 불가');

    var segments = [], isRet = [], oosRet = [];
    for (var k = 0; k < folds.length; k++) {
      var f = folds[k];
      segments.push({ from: f.trainEnd, to: f.testEnd, positions: fn(candles.slice(0, f.testEnd), params) });
      var tr = candles.slice(f.trainFrom, f.trainEnd);
      isRet.push(backtest.summarize(backtest.runBacktest(Object.assign(
        { candles: tr, targetPositions: fn(tr, params) }, costs()))).totalReturnPct);
      var te = candles.slice(f.trainEnd, f.testEnd);
      oosRet.push(backtest.summarize(backtest.runBacktest(Object.assign(
        { candles: te, targetPositions: fn(te, params) }, costs()))).totalReturnPct);
    }
    var st = research.stitchSegments(segments);
    var seg = candles.slice(st.from, st.to);
    var r = backtest.runBacktest(Object.assign({ candles: seg, targetPositions: st.positions }, costs()));
    var m = research.curveMetrics(r.equity, { periodsPerYear: PPY[interval] });
    var bh = backtest.runBacktest(Object.assign(
      { candles: seg, targetPositions: seg.map(function () { return 1; }) }, costs()));
    var bhM = research.curveMetrics(bh.equity, { periodsPerYear: PPY[interval] });
    var s = backtest.summarize(r);
    var wfe = research.walkForwardEfficiency(isRet, oosRet);
    var gate = research.evaluateWfGate({
      totalReturnPct: m.totalReturnPct, maxDrawdownPct: m.maxDrawdownPct,
      bhReturnPct: bhM.totalReturnPct, tradeCount: s.tradeCount, wfe: wfe,
    });
    return { symbol: symbol, passes: gate.passes, ret: m.totalReturnPct, mdd: m.maxDrawdownPct, wfe: wfe };
  }

  // 캠페인 — 유니버스를 절반으로 갈라 탐색/확인으로 돌린다.
  // 이 프로젝트에서 사전 등록 가설이 네 번 기각된 경로를 도구가 대신 잡아준다.
  async function runCampaign() {
    var group = $('group').value;
    var symbols = GROUPS[group];
    if (!symbols || symbols.length < 4) throw new Error('캠페인에는 심볼 4개 이상이 필요합니다');

    var half = Math.floor(symbols.length / 2);
    var exploration = symbols.slice(0, half);
    var confirmation = symbols.slice(half);
    var params = JSON.parse($('params').value || '{}');
    var fn = strategyFn();

    var expR = [], conR = [], failed = [];
    var total = symbols.length, done = 0;

    async function runSet(list, into) {
      for (var i = 0; i < list.length; i++) {
        status.textContent = '캠페인 ' + (++done) + '/' + total + ' — ' + list[i];
        try { into.push(await gateFor(list[i], params, fn)); }
        catch (e) { failed.push(e.message); }
      }
    }
    await runSet(exploration, expR);
    await runSet(confirmation, conR);

    if (!expR.length || !conR.length) {
      throw new Error('데이터를 받은 심볼이 부족합니다. ' + failed.join(' · '));
    }

    var v = labkit.campaignVerdict({ exploration: expR, confirmation: conR });
    var row = function (r) {
      return '<tr><td class="tid">' + r.symbol + '</td><td>' + (r.passes ? '✅' : '❌') +
        '</td><td class="' + cls(r.ret) + '">' + pct(r.ret) + '</td><td>' + r.mdd.toFixed(1) +
        '%</td><td class="' + (r.wfe != null && r.wfe >= 0.2 ? 'pos' : 'neg') + '">' +
        (r.wfe == null ? 'n/a' : r.wfe.toFixed(2)) + '</td></tr>';
    };

    out.innerHTML =
      '<h2>캠페인 결과 — ' + group + '</h2><section class="card">' +
      '<p class="verdict ' + (v.replicated ? 'pos' : 'neg') + '">' +
      (v.replicated ? '✅ ' : '❌ ') + v.headline + '</p>' +
      '<p class="notes">' + v.detail + '</p>' +
      (failed.length ? '<p class="warn">건너뛴 심볼 ' + failed.length + '개: ' +
        failed.join(' · ').replace(/</g, '&lt;') + '</p>' : '') +
      '<h3>탐색 그룹 (' + v.explorationPassed + '/' + v.explorationTotal + ' 통과)</h3>' +
      '<table><thead><tr><th>심볼</th><th>게이트</th><th>수익</th><th>MDD</th><th>WFE</th></tr></thead><tbody>' +
      expR.map(row).join('') + '</tbody></table>' +
      '<h3>확인 그룹 (' + v.confirmationPassed + '/' + v.confirmationTotal + ' 통과)</h3>' +
      '<table><thead><tr><th>심볼</th><th>게이트</th><th>수익</th><th>MDD</th><th>WFE</th></tr></thead><tbody>' +
      conR.map(row).join('') + '</tbody></table>' +
      '<p class="notes">유니버스를 앞뒤 절반으로 갈라 탐색/확인으로 씁니다. ' +
      '탐색에서 통과한 설정이 손대지 않은 확인 그룹에서도 통과해야 의미가 있습니다.</p></section>';
    status.textContent = '';
  }

  // 공유 링크 — 설정만 담고 전략 코드는 절대 담지 않는다.
  function currentConfig() {
    return {
      symbol: $('symbol').value.trim().toUpperCase(),
      interval: $('interval').value,
      days: Number($('days').value),
      strategy: $('strategy').value,
      params: JSON.parse($('params').value || '{}'),
      execution: $('execution').value,
      fee: Number($('fee').value),
      group: $('group').value,
    };
  }

  function applyConfig(c) {
    if (c.symbol) $('symbol').value = c.symbol;
    if (c.interval) $('interval').value = c.interval;
    if (c.days) $('days').value = c.days;
    if (c.strategy) $('strategy').value = c.strategy;
    if (c.params) $('params').value = JSON.stringify(c.params, null, 2);
    if (c.execution) $('execution').value = c.execution;
    if (c.fee != null) $('fee').value = c.fee;
    if (c.group) $('group').value = c.group;
    syncCustomVisibility();
  }

  $('share').addEventListener('click', async function () {
    var cfg = currentConfig();
    var url = location.origin + location.pathname + '#c=' + labkit.encodeShareConfig(cfg);
    try { await navigator.clipboard.writeText(url); status.textContent = '공유 링크를 복사했습니다.'; }
    catch (e) { status.textContent = '복사 실패 — 주소: ' + url; }
    if (cfg.strategy === '__custom__') {
      status.textContent += ' (내 전략 코드는 링크에 포함되지 않습니다 — 받는 사람은 설정만 보게 됩니다.)';
    }
  });

  // 링크로 들어온 경우 설정을 복원한다. 코드가 실려 있어도 디코더가 걸러낸다.
  if (location.hash.indexOf('#c=') === 0) {
    try { applyConfig(labkit.decodeShareConfig(location.hash.slice(3))); }
    catch (e) { status.textContent = '공유 링크 오류: ' + e.message; }
  }

  function guardRun(fn) {
    return async function () {
      $('run').disabled = $('walk').disabled = $('campaign').disabled = true;
      out.innerHTML = '';
      try { await fn(); }
      catch (e) { status.textContent = '오류: ' + e.message; }
      finally { $('run').disabled = $('walk').disabled = $('campaign').disabled = false; }
    };
  }

  $('run').addEventListener('click', guardRun(runSingle));
  $('walk').addEventListener('click', guardRun(runWalkForward));
  $('campaign').addEventListener('click', guardRun(runCampaign));
})();
</script>
</body>
</html>
`;

// 생성된 스크립트의 문법을 빌드 시점에 검사한다.
// 템플릿 리터럴로 JS를 찍어내면 이스케이프가 빌드 때 한 번 소비되어, 문자열이
// 조용히 끊긴 채 배포될 수 있다 — 페이지를 열기 전에는 보이지 않는 종류의 버그다.
const blocks = html.split('<script>').slice(1).map((b) => b.split('</script>')[0]);
blocks.forEach((code, i) => {
  try {
    new Function(code);
  } catch (err) {
    throw new Error(`생성된 script 블록 ${i + 1}에 문법 오류가 있습니다: ${err.message}`);
  }
});

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(path.join(OUT_DIR, 'lab.html'), html);
console.log(
  `빌드 완료: _site/lab.html (엔진 모듈 ${MODULES.length}개 번들, ` +
    `script 블록 ${blocks.length}개 문법 검사 통과, ${(html.length / 1024).toFixed(0)}KB)`
);
