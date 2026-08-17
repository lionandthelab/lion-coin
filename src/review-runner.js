'use strict';

// 복기 실행 — 클로드 호출과 파일 쓰기만 담당하는 얇은 층.
// 판단 로직은 전부 review.js / review-agent.js에 있고 여기엔 없다.
//
// 에이전트 호출이 실패해도 매매가 멈추면 안 된다. 네트워크 오류나 키 미설정으로
// 복기가 안 되는 것과, 전략이 무너져서 멈춰야 하는 것은 완전히 다른 상황이다.
// 그래서 실패는 규칙 기반 복기(review.js) 결과로 조용히 되돌아간다.

const fs = require('node:fs');
const path = require('node:path');

const { buildReviewRequest, parseDecision, gateDecision } = require('./review-agent');

const PROPOSAL_DIR = path.join(process.cwd(), 'proposals');

// 코드 제안은 적용하지 않고 파일로 남긴다. 사람이 읽고 판단할 대상이다.
function writeProposals(proposals, stamp) {
  if (!proposals.length) return [];
  fs.mkdirSync(PROPOSAL_DIR, { recursive: true });
  return proposals.map((p, i) => {
    const safe = String(p.file).replace(/[^a-zA-Z0-9._-]/g, '_');
    const file = path.join(PROPOSAL_DIR, `${stamp}-${i}-${safe}.md`);
    fs.writeFileSync(
      file,
      [
        `# 코드 개선 제안 — ${p.file}`,
        '',
        `생성: ${stamp}`,
        '',
        '## 근거',
        p.rationale,
        '',
        '## 제안',
        '```diff',
        p.diff,
        '```',
        '',
        '---',
        '이 제안은 **자동 적용되지 않았습니다.** 실주문이 나가는 경로라 검토 없이',
        '반영하지 않습니다. 적용하려면 내용을 확인한 뒤 직접 반영하고 테스트를 돌리십시오.',
      ].join('\n'),
      'utf8'
    );
    return file;
  });
}

async function callAgent(request) {
  // 지연 로딩 — 키가 없거나 SDK가 없는 환경에서도 나머지가 동작해야 한다.
  const Anthropic = require('@anthropic-ai/sdk');
  const client = new Anthropic();
  const response = await client.messages.create(request);

  // 안전 분류기가 거절하면 content가 비거나 부분적이다. 먼저 확인한다.
  if (response.stop_reason === 'refusal') {
    throw new Error('모델이 요청을 거절했습니다 (stop_reason=refusal)');
  }
  const text = response.content.find((b) => b.type === 'text');
  if (!text) throw new Error('응답에 텍스트 블록이 없습니다');
  return JSON.parse(text.text);
}

// review: reviewTrades() 결과 / config: 현재 설정 / trades: 최근 거래
async function runAgentReview({ review, config, trades, history, source, now = new Date() } = {}) {
  const stamp = now.toISOString().replace(/[:.]/g, '-');

  if (!process.env.ANTHROPIC_API_KEY) {
    return { ok: false, reason: 'ANTHROPIC_API_KEY 미설정 — 규칙 기반 복기만 적용됩니다', at: stamp };
  }

  let raw;
  try {
    raw = await callAgent(buildReviewRequest({ review, config, trades, history, source }));
  } catch (err) {
    // 복기 실패가 매매 중단으로 번지면 안 된다.
    return { ok: false, reason: `에이전트 호출 실패: ${err.message}`, at: stamp };
  }

  const parsed = parseDecision(raw);
  if (!parsed.ok) {
    return { ok: false, reason: `응답 형식 오류: ${parsed.errors.join('; ')}`, at: stamp, raw };
  }

  const gate = gateDecision(parsed.decision, config);
  const files = writeProposals(gate.proposals, stamp);

  return {
    ok: true,
    at: stamp,
    action: parsed.decision.action,
    reasoning: parsed.decision.reasoning,
    confidence: parsed.decision.confidence,
    halt: gate.halt,
    autoApplied: gate.autoApplied,
    blocked: gate.blocked,
    proposalFiles: files,
    needsHumanReview: gate.needsHumanReview,
  };
}

module.exports = { PROPOSAL_DIR, runAgentReview, writeProposals };
