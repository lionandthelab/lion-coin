'use strict';

// 복기문 생성 — 하루치 집계를 사람이 읽는 문서로 만든다.
//
// 두 층으로 나눈다:
//   1) `renderFallback` — 수치만으로 만드는 결정론적 복기문. 항상 나온다.
//   2) 클로드 에이전트의 서술형 원인 분석 — 있으면 얹고, 없으면 1)만 남는다.
//
// **왜 폴백이 먼저인가:** API 키가 없거나 호출이 실패하는 날에도 복기는 남아야 한다.
// 복기가 "가끔 비는 기록"이 되면 누적 표본이 끊겨 보정 판단 자체가 불가능해진다.
// 에이전트는 있으면 좋은 층이지 복기의 전제가 아니다.

const path = require('node:path');
const fs = require('node:fs');

const { summarizeDay, proposeCalibration } = require('./daily-review');

const MODEL = 'claude-opus-5';
const REVIEW_DIR = path.join(__dirname, '..', 'reviews');

const bps = (n) => (n == null ? '—' : `${n >= 0 ? '+' : ''}${n.toFixed(0)}bps`);
const won = (n) => (n == null ? '—' : `${Math.round(n).toLocaleString('ko-KR')}원`);

const VERDICT_LABEL = {
  good_exit: '적절한 청산',
  tp_too_tight: '익절이 좁았음',
  sl_too_tight: '손절이 좁았음',
  sl_correct: '손절이 손실을 막음',
  hold_too_short: '보유시간이 짧았음',
  unknown: '판정 불가(사후 기록 없음)',
};

// 수치만으로 만드는 복기문. 에이전트 없이도 이것만으로 되돌아볼 수 있어야 한다.
function renderFallback({ summary, calibration }) {
  const s = summary;
  const L = [];
  L.push(`# ${s.date} 복기`, '');

  L.push('## 실적', '');
  if (!s.tradeCount) {
    L.push('매매 없음.', '');
  } else {
    L.push(`- 거래 ${s.tradeCount}건 · 승 ${s.wins} / 패 ${s.losses}`);
    L.push(`- 순손익 ${bps(s.netBps)} · ${won(s.netKrw)}`);
    L.push(`- 청산 사유: ${Object.entries(s.byOutcome).map(([k, v]) => `${k} ${v}`).join(' · ')}`);
    L.push('');
    L.push('| 등급 | 거래 | 승 | 순손익 |');
    L.push('|---|---|---|---|');
    for (const [g, v] of Object.entries(s.byGrade)) {
      L.push(`| ${g} | ${v.count} | ${v.wins} | ${bps(v.netBps)} / ${won(v.netKrw)} |`);
    }
    L.push('');
  }

  L.push('## 익절·손절 설정이 옳았는가', '');
  if (!s.judgedCount) {
    L.push('청산 후 가격 기록이 없어 판정할 수 없습니다.', '');
  } else {
    L.push(`판정 가능 ${s.judgedCount}건 / 전체 ${s.tradeCount}건`, '');
    L.push('| 판정 | 건수 |');
    L.push('|---|---|');
    for (const [k, v] of Object.entries(s.verdicts)) {
      if (v > 0) L.push(`| ${VERDICT_LABEL[k] || k} | ${v} |`);
    }
    L.push('');
    const notable = s.details.filter((d) => d.verdict !== 'good_exit' && d.verdict !== 'unknown');
    if (notable.length) {
      L.push('### 되짚을 거래', '');
      for (const d of notable) {
        L.push(`- **${d.symbol}** (${d.grade}급, ${d.outcome}, ${bps(d.returnBps)}) — ${VERDICT_LABEL[d.verdict]}`);
        L.push(`  - ${d.detail}`);
      }
      L.push('');
    }
  }

  L.push('## 재료', '');
  L.push(`포착 ${s.materials.total}건 · 등급 부여 ${s.materials.graded}건 · 매매 ${s.materials.traded}건`, '');
  const skipped = Object.entries(s.materials.skipped).sort((a, b) => b[1] - a[1]);
  if (skipped.length) {
    L.push('### 매매하지 않은 사유', '');
    for (const [why, n] of skipped) L.push(`- ${n}건 · ${why}`);
    L.push('');
  }

  L.push('## 보정 판단', '');
  L.push(calibration.reason, '');
  if (calibration.suggestions.length) {
    for (const g of calibration.suggestions) {
      L.push(`- **${g.param}** ${g.direction === 'increase' ? '확대' : '축소'} 검토`);
      L.push(`  - ${g.rationale}`);
      L.push(`  - 근거: ${g.evidence}`);
    }
    L.push('');
    L.push('> 제안일 뿐 자동 적용되지 않습니다. 사람이 확인하고 반영합니다.', '');
  }

  if (s.sampleWarning) {
    L.push('## ⚠ 표본에 대하여', '', s.sampleWarning, '');
  }
  return L.join('\n');
}

// 에이전트에게 넘길 요청. 수치는 이미 집계됐으니 에이전트는 **원인 분석**만 한다.
function buildReviewRequest({ summary, calibration, recentDays = [] }) {
  const system = `당신은 유목민식 이벤트 단타의 복기 담당자입니다.
유목민식이란 아직 시장에 퍼지지 않은 재료(공시·속보)를 포착해 등급을 분별하고,
기대감과 시황으로 손절·익절을 정해 짧게 기계적으로 실현하는 매매법입니다.

당신의 임무는 수치를 다시 나열하는 것이 아니라 **왜 그랬는지**를 설명하는 것입니다.
집계는 이미 끝나 있습니다. 당신은 다음 세 가지만 쓰십시오:

1. **재료 분별이 맞았는가** — 등급을 매긴 근거가 실제 가격 반응과 맞았는지.
   S급이라 판단한 재료가 실제로 크게 움직였는지, 안 움직였다면 무엇이 달랐는지.
2. **익절·손절 설정의 원인 분석** — 좁았다면 왜 좁았는지, 재료의 성질 때문인지
   시황 때문인지 우연인지. **한두 건이면 우연일 가능성을 반드시 먼저 말하십시오.**
3. **다음을 향한 보정** — 구체적으로. 다만 표본이 부족하면 "표본을 더 쌓아야 한다"고
   쓰는 것이 정직한 결론입니다. 억지로 조언을 만들지 마십시오.

**이 프로젝트의 이력을 반드시 감안하십시오:** 68~114일 표본에서 유의해 보이던 우위가
455일 재검증에서 사라진 적이 있습니다. 하루는 거래가 0~3건입니다. 그 표본으로
파라미터를 바꾸자고 하면 다음 날 반대로 흔들립니다. **적은 표본에서 확신하는 것이
이 프로젝트에서 반복된 가장 큰 실수입니다.**

한국어로, 마크다운으로, 간결하게 쓰십시오. 표는 이미 있으니 다시 만들지 마십시오.`;

  const facts = [
    `## ${summary.date} 집계`,
    `거래 ${summary.tradeCount}건 (승 ${summary.wins}/패 ${summary.losses}) · 순손익 ${bps(summary.netBps)} ${won(summary.netKrw)}`,
    `청산 사유: ${JSON.stringify(summary.byOutcome)}`,
    `등급별: ${JSON.stringify(summary.byGrade)}`,
    `사후 판정: ${JSON.stringify(summary.verdicts)} (판정 가능 ${summary.judgedCount}건)`,
    '',
    '### 개별 거래 판정',
    ...summary.details.map((d) =>
      `- ${d.symbol} ${d.grade}급 ${d.outcome} ${bps(d.returnBps)} → ${VERDICT_LABEL[d.verdict]}: ${d.detail}`),
    '',
    '### 재료',
    `포착 ${summary.materials.total} · 등급 부여 ${summary.materials.graded} · 매매 ${summary.materials.traded}`,
    `매매하지 않은 사유: ${JSON.stringify(summary.materials.skipped)}`,
    '',
    '### 누적 보정 판단(기계)',
    calibration.reason,
    calibration.suggestions.length ? JSON.stringify(calibration.suggestions, null, 1) : '(제안 없음)',
  ];

  if (recentDays.length) {
    facts.push('', '### 최근 며칠 추이');
    for (const d of recentDays) {
      facts.push(`- ${d.date}: ${d.tradeCount}건 ${bps(d.netBps)} · 판정 ${JSON.stringify(d.verdicts)}`);
    }
  }
  if (summary.sampleWarning) facts.push('', `### 표본 경고`, summary.sampleWarning);

  return {
    model: MODEL,
    max_tokens: 4000,
    system,
    messages: [{ role: 'user', content: facts.join('\n') }],
  };
}

function reviewPath(date, dir = REVIEW_DIR) {
  return path.join(dir, `${date}.md`);
}

// 복기문을 파일로 쌓는다. 에이전트 서술이 있으면 폴백 위에 얹는다.
function writeReview({ date, summary, calibration, narrative = null, dir = REVIEW_DIR }) {
  fs.mkdirSync(dir, { recursive: true });
  const body = renderFallback({ summary, calibration });
  const doc = narrative
    ? `${body}\n---\n\n## 원인 분석과 보정 제안\n\n${narrative}\n`
    : `${body}\n---\n\n_이 복기문은 수치 집계만으로 작성됐습니다 (서술형 분석 없음)._\n`;
  const file = reviewPath(date, dir);
  fs.writeFileSync(file, doc, 'utf8');
  return file;
}

function listReviews(dir = REVIEW_DIR) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f))
    .map((f) => f.replace(/\.md$/, ''))
    .sort()
    .reverse();
}

function readReview(date, dir = REVIEW_DIR) {
  const file = reviewPath(date, dir);
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
}

module.exports = {
  MODEL,
  REVIEW_DIR,
  VERDICT_LABEL,
  renderFallback,
  buildReviewRequest,
  reviewPath,
  writeReview,
  listReviews,
  readReview,
  summarizeDay,
  proposeCalibration,
};
