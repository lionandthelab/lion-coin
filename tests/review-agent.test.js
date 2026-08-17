const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  MODEL,
  DECISION_SCHEMA,
  buildReviewRequest,
  parseDecision,
  gateDecision,
} = require('../src/review-agent');
const { validateConfigPatch } = require('../src/trading-config');

// 10거래 복기를 클로드에게 맡기는 부분. 요청 조립과 응답 검증은 순수 함수로 두어
// 네트워크 없이 검증한다 — 실주문 경로에 붙는 로직을 실제 호출 없이는 못 고치는
// 상태로 두면 안 된다.
//
// **가장 중요한 것은 게이트다.** 에이전트는 제안만 하고, 무엇이 자동 적용되고
// 무엇이 사람 검토를 거치는지는 코드가 정한다. 모델 응답이 그 경계를 스스로
// 넘을 수 있으면 안전장치가 아니다.

const base = {
  strategy: 'reversal', interval: '30m', maxSymbols: 60, minTradeValue24h: 3e8,
  lookback: 20, volMult: 5, takeProfitBps: 500, stopLossBps: 200, feeBps: 4,
  capitalKrw: 39000, riskPct: 1, scanIntervalSec: 60, maxSpreadBps: 30,
  maxBreakevenWinRate: 0.6, maxConcurrentPositions: 1, minNotionalKrw: 5000, maxHoldBars: 6,
};
const review = {
  count: 10, wins: 3, winRate: 0.3, expectancyBps: -120, totalBps: -1200,
  maxLossStreak: 4, breakevenWinRate: 0.32, belowBreakeven: true, byOutcome: { tp: 3, sl: 7 },
};
const trades = Array.from({ length: 10 }, (_, i) => ({
  symbol: 'BTC', at: '2026-08-17T00:00:00.000Z', outcome: i < 3 ? 'tp' : 'sl',
  returnBps: i < 3 ? 475 : -225,
}));

test('MODEL은 최신 모델을 가리킨다', () => {
  assert.equal(MODEL, 'claude-opus-5');
});

// ---- 요청 조립 ----

test('buildReviewRequest: 구조화 출력 스키마를 요구한다', () => {
  // 자유 텍스트를 파싱하면 형식이 흔들릴 때마다 복기가 조용히 실패한다
  const r = buildReviewRequest({ review, config: base, trades });
  assert.deepEqual(r.output_config.format.schema, DECISION_SCHEMA);
  assert.equal(r.output_config.format.type, 'json_schema');
});

test('buildReviewRequest: 실적·설정·거래내역을 모두 넣는다', () => {
  const r = buildReviewRequest({ review, config: base, trades });
  const text = JSON.stringify(r.messages);
  assert.match(text, /takeProfitBps/, '설정이 없으면 무엇을 바꿀지 판단할 수 없다');
  assert.match(text, /-225/, '개별 거래가 없으면 집계만 보고 판단하게 된다');
  assert.match(text, /0\.3|30/, '승률이 없으면 손익분기 대비를 못 본다');
});

test('buildReviewRequest: 검증 이력을 함께 넘긴다', () => {
  // 이 프로젝트는 짧은 표본의 우위가 긴 표본에서 사라진 전력이 있다.
  // 그 사실을 모르는 에이전트는 10거래를 보고 확신하게 된다.
  const r = buildReviewRequest({
    review, config: base, trades,
    history: '455일 재검증 결과 순기대값 -22bps, 신호 우위는 유의하지 않음',
  });
  assert.match(JSON.stringify(r), /455일/);
});

test('buildReviewRequest: 표본이 작다는 사실을 시스템 프롬프트에 못박는다', () => {
  const r = buildReviewRequest({ review, config: base, trades });
  assert.match(r.system, /표본/, '10거래가 작은 표본임을 모르면 잡음에 반응한다');
});

test('buildReviewRequest: 키를 요청 본문에 담지 않는다', () => {
  const r = buildReviewRequest({ review, config: base, trades });
  assert.equal(JSON.stringify(r).includes('api_key'), false);
  assert.equal(JSON.stringify(r).includes('sk-'), false);
});

// ---- 응답 검증 ----

test('parseDecision: 유효한 결정을 그대로 돌려준다', () => {
  const d = parseDecision({
    action: 'hold', reasoning: '표본 부족', confidence: 0.4,
  });
  assert.equal(d.ok, true);
  assert.equal(d.decision.action, 'hold');
});

test('parseDecision: 모르는 action은 거부한다', () => {
  const d = parseDecision({ action: 'go_all_in', reasoning: 'x', confidence: 1 });
  assert.equal(d.ok, false);
  assert.match(d.errors.join(' '), /go_all_in/);
});

test('parseDecision: 근거 없는 결정은 거부한다', () => {
  // 근거 없이 설정을 바꾸면 나중에 왜 바뀌었는지 되짚을 수 없다
  const d = parseDecision({ action: 'halt', reasoning: '', confidence: 0.9 });
  assert.equal(d.ok, false);
  assert.match(d.errors.join(' '), /근거/);
});

test('parseDecision: 응답이 아예 아니면 거부한다', () => {
  assert.equal(parseDecision(null).ok, false);
  assert.equal(parseDecision('그냥 텍스트').ok, false);
});

// ---- 게이트 (핵심) ----

test('gateDecision: 중단은 항상 통과시킨다', () => {
  // 멈추는 방향은 손실을 늘리지 않는다. 막을 이유가 없다.
  const g = gateDecision({ action: 'halt', reasoning: '연속 손실', confidence: 0.5 }, base);
  assert.equal(g.halt, true);
  assert.equal(g.autoApplied, null);
});

test('gateDecision: 파라미터 조정은 설정 검증을 통과해야 적용된다', () => {
  const ok = gateDecision(
    { action: 'adjust', reasoning: '익절 축소', confidence: 0.7, configPatch: { takeProfitBps: 300 } },
    base
  );
  assert.deepEqual(ok.autoApplied, { takeProfitBps: 300 });

  const bad = gateDecision(
    { action: 'adjust', reasoning: 'x', confidence: 0.7, configPatch: { takeProfitBps: 20 } },
    base
  );
  assert.equal(bad.autoApplied, null, '손익분기 100% 초과 설정을 모델이 제안해도 막아야 한다');
  assert.match(bad.blocked.join(' '), /손익분기/);
});

test('gateDecision: 자본·위험 비중은 모델이 못 바꾼다', () => {
  // 주문 금액을 정하는 값이다. 검증을 통과하더라도 자동 적용 대상이 아니다.
  const g = gateDecision(
    { action: 'adjust', reasoning: '자본 늘리자', confidence: 0.9, configPatch: { capitalKrw: 1000000 } },
    base
  );
  assert.equal(g.autoApplied, null);
  assert.match(g.blocked.join(' '), /capitalKrw/);
});

test('gateDecision: 코드 변경 제안은 절대 자동 적용하지 않는다', () => {
  // 실주문이 나가는 경로다. 검토 없는 코드가 들어가면 안 된다.
  const g = gateDecision(
    {
      action: 'propose_code', reasoning: '스캐너 분리', confidence: 0.8,
      codeProposals: [{ file: 'src/scanner.js', rationale: '중복 제거', diff: '- a\n+ b' }],
    },
    base
  );
  assert.equal(g.autoApplied, null);
  assert.equal(g.proposals.length, 1);
  assert.match(g.needsHumanReview, /검토/);
});

test('gateDecision: 조정과 코드 제안이 함께 오면 조정만 적용한다', () => {
  const g = gateDecision(
    {
      action: 'adjust', reasoning: '둘 다', confidence: 0.7,
      configPatch: { takeProfitBps: 300 },
      codeProposals: [{ file: 'src/x.js', rationale: 'y', diff: 'z' }],
    },
    base
  );
  assert.deepEqual(g.autoApplied, { takeProfitBps: 300 });
  assert.equal(g.proposals.length, 1, '코드 제안은 남기되 적용하지 않는다');
});

test('gateDecision: 적용된 설정은 실제로 유효하다', () => {
  const g = gateDecision(
    { action: 'adjust', reasoning: 'x', confidence: 0.7, configPatch: { stopLossBps: 150 } },
    base
  );
  assert.equal(validateConfigPatch(g.autoApplied, base).ok, true);
});

test('gateDecision: 게이트 결과는 무엇이 왜 막혔는지 남긴다', () => {
  const g = gateDecision(
    { action: 'adjust', reasoning: 'x', confidence: 0.7, configPatch: { capitalKrw: 1e6, takeProfitBps: 300 } },
    base
  );
  assert.ok(Array.isArray(g.blocked));
  assert.ok(g.blocked.length > 0, '조용히 무시하면 왜 안 바뀌었는지 알 수 없다');
});

// ---- 스키마 ----

test('DECISION_SCHEMA: 구조화 출력이 요구하는 형태를 갖춘다', () => {
  assert.equal(DECISION_SCHEMA.type, 'object');
  assert.equal(DECISION_SCHEMA.additionalProperties, false, '구조화 출력은 이 값을 요구한다');
  assert.ok(Array.isArray(DECISION_SCHEMA.required));
  assert.ok(DECISION_SCHEMA.properties.action.enum.includes('halt'));
});
