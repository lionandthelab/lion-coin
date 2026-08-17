'use strict';

// 10거래 복기를 클로드 전문가 에이전트에게 맡긴다 — 요청 조립·응답 검증·게이트는 순수 함수.
//
// **왜 규칙 기반 복기(review.js)로 충분하지 않은가:** 규칙은 "승률이 손익분기 아래인가"
// 같은 사전에 정한 질문에만 답한다. 정작 이 프로젝트를 망친 실수들 — 짧은 표본의
// 우위를 진짜로 믿은 것, 심볼 분할을 독립 검증으로 착각한 것 — 은 사전에 질문으로
// 만들어 두지 못한 종류였다. 그런 판단은 규칙이 아니라 검토자가 해야 한다.
//
// **그래서 더더욱 게이트가 필요하다.** 모델은 제안만 하고, 무엇이 자동 적용되는지는
// 코드가 정한다:
//   - 중단(halt)      → 항상 적용. 멈추는 방향은 손실을 늘리지 않는다.
//   - 파라미터 조정   → 설정 검증 + 허용 목록을 통과해야 적용.
//   - 코드 구조 변경  → **절대 자동 적용하지 않는다.** 제안 파일로 남긴다.
//
// 마지막 항목이 핵심이다. 이 코드는 실주문이 나가는 경로다. 검토 없는 코드가
// 여기에 들어가면 안 되고, 모델이 아무리 확신해도 그 경계는 코드가 지킨다.

const { validateConfigPatch } = require('./trading-config');

const MODEL = 'claude-opus-5';

// 자유 텍스트를 파싱하면 형식이 흔들릴 때마다 복기가 조용히 실패한다.
// 구조화 출력으로 형태를 API 단에서 강제한다.
const DECISION_SCHEMA = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: ['hold', 'adjust', 'halt', 'propose_code'],
      description:
        'hold=설정 유지, adjust=파라미터 조정, halt=매매 중단, propose_code=코드 구조 개선 제안',
    },
    reasoning: {
      type: 'string',
      description: '이 판단의 근거. 어떤 수치를 보고 그렇게 판단했는지 구체적으로.',
    },
    confidence: {
      type: 'number',
      description: '0~1. 10거래는 작은 표본이므로 확신이 낮은 것이 정상이다.',
    },
    configPatch: {
      type: 'object',
      description: 'action=adjust일 때 바꿀 설정. 바꿀 항목만 넣는다.',
      properties: {
        takeProfitBps: { type: 'number' },
        stopLossBps: { type: 'number' },
        maxHoldBars: { type: 'integer' },
        lookback: { type: 'integer' },
        volMult: { type: 'number' },
        maxSpreadBps: { type: 'number' },
        scanIntervalSec: { type: 'integer' },
        minTradeValue24h: { type: 'number' },
      },
      additionalProperties: false,
    },
    codeProposals: {
      type: 'array',
      description: '코드 구조 개선 제안. 사람이 검토한 뒤에만 적용된다.',
      items: {
        type: 'object',
        properties: {
          file: { type: 'string' },
          rationale: { type: 'string' },
          diff: { type: 'string' },
        },
        required: ['file', 'rationale', 'diff'],
        additionalProperties: false,
      },
    },
  },
  required: ['action', 'reasoning', 'confidence'],
  additionalProperties: false,
};

// 모델이 바꿀 수 있는 설정. 자본과 위험 비중은 **주문 금액을 직접 정하므로**
// 검증을 통과하더라도 자동 적용 대상에서 뺀다. 전략 자체(strategy)도 마찬가지다 —
// 전략 교체는 재검증이 필요한 결정이지 복기 한 번으로 할 일이 아니다.
const AUTO_APPLICABLE = new Set([
  'takeProfitBps',
  'stopLossBps',
  'maxHoldBars',
  'lookback',
  'volMult',
  'maxSpreadBps',
  'scanIntervalSec',
  'minTradeValue24h',
]);

const SYSTEM = `당신은 알고리즘 매매 시스템의 복기 담당자입니다. 최근 거래 실적을 보고
설정을 유지할지, 조정할지, 멈출지, 코드 구조를 고칠지 판단합니다.

**표본 크기를 항상 먼저 생각하십시오.** 10거래는 승률을 추정하기에 몇 자릿수 부족한
표본입니다. 익절 500bps / 손절 200bps 구조에서 진짜 승률이 40%여도 10거래에서 20%가
나올 확률은 우연만으로 상당합니다. 한 번의 부진을 근거로 파라미터를 바꾸면 다음
10거래에서 반대로 흔들리고, 결국 전략이 아니라 최근 잡음을 쫓게 됩니다.

이 프로젝트는 실제로 그 실수를 했습니다. 68~114일 표본에서 유의해 보이던 신호 우위가
455일 표본에서 사라졌습니다. 짧은 표본의 우위를 믿지 마십시오.

판단 기준을 비대칭으로 잡으십시오:
- **멈추는 데는 민감하게.** 손실은 되돌릴 수 없습니다. 의심스러우면 멈추십시오.
- **바꾸는 데는 둔감하게.** 연속으로 나쁜 복기가 쌓여야 파라미터를 건드립니다.

코드 구조 문제가 보이면 propose_code로 제안하십시오. 다만 제안은 사람이 검토한 뒤에만
적용되므로, 무엇이 왜 문제인지 rationale에 명확히 쓰십시오.

확신이 없으면 confidence를 낮게 주십시오. 낮은 확신은 감점이 아닙니다 — 작은 표본에서
확신하는 것이 오히려 문제입니다.`;

function buildReviewRequest({ review, config, trades = [], history = null, source = null } = {}) {
  const parts = [
    `## 최근 ${review.count}거래 실적`,
    `- 승률: ${review.winRate == null ? '없음' : `${(review.winRate * 100).toFixed(1)}% (${review.wins}/${review.count})`}`,
    `- 손익분기 승률: ${review.breakevenWinRate == null ? '없음' : `${(review.breakevenWinRate * 100).toFixed(1)}%`}`,
    `- 거래당 기대값: ${review.expectancyBps == null ? '없음' : `${review.expectancyBps.toFixed(1)}bps`}`,
    `- 누적: ${review.totalBps.toFixed(0)}bps · 최대 연속 손실 ${review.maxLossStreak}회`,
    `- 청산 사유: ${JSON.stringify(review.byOutcome)}`,
    '',
    '## 개별 거래',
    ...trades.map(
      (t) => `- ${t.at} ${t.symbol} ${t.outcome} ${t.returnBps.toFixed(0)}bps`
    ),
    '',
    '## 현재 설정',
    '```json',
    JSON.stringify(config, null, 2),
    '```',
  ];

  if (history) {
    parts.push('', '## 검증 이력 (반드시 감안할 것)', history);
  }
  if (source) {
    parts.push('', '## 관련 코드', '```js', source, '```');
  }

  return {
    model: MODEL,
    max_tokens: 16000,
    system: SYSTEM,
    output_config: { format: { type: 'json_schema', schema: DECISION_SCHEMA } },
    messages: [{ role: 'user', content: parts.join('\n') }],
  };
}

const ACTIONS = new Set(['hold', 'adjust', 'halt', 'propose_code']);

function parseDecision(raw) {
  const errors = [];

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, decision: null, errors: ['응답이 객체가 아닙니다'] };
  }
  if (!ACTIONS.has(raw.action)) {
    errors.push(`알 수 없는 action입니다: ${JSON.stringify(raw.action)}`);
  }
  // 근거 없이 설정이 바뀌면 나중에 왜 바뀌었는지 되짚을 수 없다.
  if (typeof raw.reasoning !== 'string' || raw.reasoning.trim().length < 2) {
    errors.push('근거(reasoning)가 비어 있습니다');
  }
  if (typeof raw.confidence !== 'number' || raw.confidence < 0 || raw.confidence > 1) {
    errors.push(`confidence는 0~1 사이 숫자여야 합니다: ${raw.confidence}`);
  }

  return errors.length
    ? { ok: false, decision: null, errors }
    : { ok: true, decision: raw, errors: [] };
}

// 결정 → 실제로 무엇을 할지. **모델은 이 경계를 넘을 수 없다.**
function gateDecision(decision, config) {
  const blocked = [];
  const proposals = Array.isArray(decision.codeProposals) ? decision.codeProposals : [];

  // 코드 변경은 어떤 action이든 자동 적용하지 않는다. 실주문 경로이기 때문이다.
  const needsHumanReview = proposals.length
    ? `코드 제안 ${proposals.length}건은 사람 검토 후에만 적용됩니다`
    : null;

  if (decision.action === 'halt') {
    return { halt: true, autoApplied: null, proposals, blocked, needsHumanReview };
  }

  const patch = decision.configPatch;
  if (!patch || typeof patch !== 'object' || Object.keys(patch).length === 0) {
    return { halt: false, autoApplied: null, proposals, blocked, needsHumanReview };
  }

  // 1) 허용 목록 — 자본·위험 비중·전략은 검증을 통과해도 모델이 못 바꾼다.
  const allowed = {};
  for (const [key, value] of Object.entries(patch)) {
    if (AUTO_APPLICABLE.has(key)) allowed[key] = value;
    else blocked.push(`${key}: 자동 조정 대상이 아닙니다 (사람이 직접 바꿔야 합니다)`);
  }
  if (Object.keys(allowed).length === 0) {
    return { halt: false, autoApplied: null, proposals, blocked, needsHumanReview };
  }

  // 2) 설정 검증 — 모델이 손익분기 100%를 넘는 조합을 제안해도 여기서 막힌다.
  const result = validateConfigPatch(allowed, config);
  if (!result.ok) {
    blocked.push(...result.errors);
    return { halt: false, autoApplied: null, proposals, blocked, needsHumanReview };
  }

  return { halt: false, autoApplied: allowed, proposals, blocked, needsHumanReview };
}

module.exports = {
  MODEL,
  DECISION_SCHEMA,
  AUTO_APPLICABLE,
  SYSTEM,
  buildReviewRequest,
  parseDecision,
  gateDecision,
};
