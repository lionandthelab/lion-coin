#!/usr/bin/env node
'use strict';

// 개선 사이클 — 복기 누적으로 시스템을 개선하되, 실행 중인 시스템을 깨지 않는다.
// 실행: npm run improve            (복기 생성 + 게이트 점검, 코드는 안 건드림)
//       npm run improve -- --propose  (개선 제안까지 브랜치로 만듦)
//
// 파이프라인:
//   복기 누적 → 개선 제안(에이전트) → 브랜치 → 테스트 게이트 → 배포 대기 → **사람 승인** → 배포
//                                                    ↓ 실패
//                                              브랜치 남기고 기록
//
// ⚠ 절대 규칙
//   - **main에 자동 병합하지 않는다.** 게이트를 통과해도 병합과 배포는 사람이 한다.
//     자동으로 바뀌면 어느 버전이 어떤 거래를 냈는지 알 수 없어 롤백 판단이 불가능해진다.
//   - **데몬을 자동 재시작하지 않는다.** 매매 중 코드 교체는 거래의 버전 귀속을 모호하게 만든다.
//   - **테스트 수가 줄면 배포를 막는다.** 실패하는 테스트를 지워 초록을 만드는 것은
//     가장 그럴듯한 실패 방식이고 "통과 여부"만 보는 검사로는 잡히지 않는다.

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const { summarizeDay, proposeCalibration } = require('../src/daily-review');
const writer = require('../src/review-writer');
const { parseTestOutput, evaluateDeployGate } = require('../src/deploy-gate');
const versionLog = require('../src/version-log');
const telegram = require('../src/telegram');

const ROOT = path.join(__dirname, '..');
const STATE_DIR = path.join(ROOT, 'harness', 'improve');
const VERSION_LOG_PATH = path.join(STATE_DIR, 'version-log.json');
const BASELINE_PATH = path.join(STATE_DIR, 'test-baseline.json');
const PROPOSAL_DIR = path.join(ROOT, 'proposals');
const TRADE_LOG = path.join(STATE_DIR, 'trade-log.jsonl');

const git = (...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
const readJson = (p, fallback) => (fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : fallback);
const writeJson = (p, v) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(v, null, 2) + '\n'); };

async function notify(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;
  try { await telegram.sendMessage({ token, chatId, text }); }
  catch (err) { console.error(`  텔레그램 실패: ${err.message}`); }
}

// 테스트는 항상 실제로 돌린다. 결과를 못 읽으면 통과로 치지 않는다 —
// 실행되지 않은 것과 통과한 것을 구별하지 못하면 게이트가 무의미하다.
function runTests() {
  try {
    const out = execFileSync('npm', ['test'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return parseTestOutput(out);
  } catch (err) {
    // 실패해도 출력에 요약이 있다 — 몇 건 실패했는지가 게이트 판정에 필요하다.
    return parseTestOutput(`${err.stdout || ''}\n${err.stderr || ''}`);
  }
}

// 데몬이 남긴 거래 로그를 버전 로그에 반영한다.
// 데몬과 이 스크립트는 별도 프로세스라 파일로 주고받는다.
function ingestTrades(log) {
  if (!fs.existsSync(TRADE_LOG)) return { log, added: 0 };
  const seen = new Set();
  for (const d of log.deploys) for (const t of d.trades) seen.add(`${t.symbol}@${t.at}`);
  for (const t of log.orphanTrades) seen.add(`${t.symbol}@${t.at}`);

  let added = 0;
  let next = log;
  for (const line of fs.readFileSync(TRADE_LOG, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let t;
    try { t = JSON.parse(line); } catch { continue; }
    const key = `${t.symbol}@${t.at}`;
    if (seen.has(key)) continue;
    seen.add(key);
    next = versionLog.attachTrade(next, t);
    added += 1;
  }
  return { log: next, added };
}

function todayKey(now = new Date()) {
  const kst = new Date(now.getTime() + 9 * 3600 * 1000);
  return kst.toISOString().slice(0, 10);
}

// 하루치 복기문을 만들어 파일로 쌓는다.
function buildDailyReview(date) {
  const dayFile = path.join(STATE_DIR, `day-${date}.json`);
  const raw = readJson(dayFile, { trades: [], events: [], postExits: {} });
  const summary = summarizeDay({ date, ...raw });

  // 누적 복기를 모아 보정 판단 — 하루치로는 절대 제안하지 않는다.
  const past = writer.listReviews()
    .map((d) => readJson(path.join(STATE_DIR, `summary-${d}.json`), null))
    .filter(Boolean);
  const calibration = proposeCalibration([...past, summary]);

  writeJson(path.join(STATE_DIR, `summary-${date}.json`), summary);
  const file = writer.writeReview({ date, summary, calibration });
  return { summary, calibration, file };
}

async function main() {
  const propose = process.argv.includes('--propose');
  const date = todayKey();
  console.log(`■ 개선 사이클 ${date}${propose ? ' (제안 포함)' : ''}\n`);

  // ── 1. 복기 ──
  const { summary, calibration, file } = buildDailyReview(date);
  console.log(`복기문 작성: ${path.relative(ROOT, file)}`);
  console.log(`  거래 ${summary.tradeCount}건 · 판정 가능 ${summary.judgedCount}건 · ${calibration.reason}\n`);

  // ── 2. 버전별 실적 반영 ──
  let vlog = readJson(VERSION_LOG_PATH, versionLog.createVersionLog());
  const ing = ingestTrades(vlog);
  vlog = ing.log;
  if (ing.added) console.log(`거래 ${ing.added}건을 현재 버전(${vlog.current || '미배포'})에 반영\n`);

  // ── 3. 롤백 점검 ──
  const rb = versionLog.shouldRollback(vlog);
  if (rb.rollback) {
    const msg = `🔙 롤백 권고\n${rb.reason}\n${rb.evidence}\n\n되돌릴 대상: ${rb.target} (${rb.targetCommit})\n`
      + `실행: git revert 또는 git checkout ${rb.targetCommit}\n\n⚠ 자동으로 되돌리지 않았습니다 — 확인 후 직접 실행하세요.`;
    console.log(msg + '\n');
    await notify(msg);
  } else {
    console.log(`롤백 점검: ${rb.reason}\n`);
  }
  writeJson(VERSION_LOG_PATH, vlog);

  // ── 4. 테스트 게이트 ──
  console.log('테스트 실행 중…');
  const tests = runTests();
  const baseline = readJson(BASELINE_PATH, null);
  const gate = evaluateDeployGate({
    tests,
    baselineTests: baseline,
    openPosition: readJson(path.join(STATE_DIR, 'position.json'), null) != null,
    mode: readJson(path.join(STATE_DIR, 'mode.json'), { mode: 'stopped' }).mode,
  });
  console.log(`  ${gate.reason}`);
  for (const b of gate.blockers) console.log(`  ✗ ${b.message}`);
  for (const w of gate.warnings) console.log(`  ⚠ ${w}`);
  console.log('');

  // 기준선은 게이트를 통과했을 때만 올린다. 실패한 상태를 기준으로 삼으면
  // 그 뒤로는 테스트가 줄어든 것을 영영 감지하지 못한다.
  if (gate.pass && tests) {
    writeJson(BASELINE_PATH, tests);
  }

  // ── 5. 개선 제안 (--propose 일 때만) ──
  if (!propose) {
    console.log('개선 제안은 --propose 로 실행하세요. (코드는 건드리지 않았습니다)');
    await notify(`📋 ${date} 복기 완료\n거래 ${summary.tradeCount}건 · ${calibration.reason}\n`
      + `테스트 ${tests ? `${tests.passed}/${tests.total}` : '판독 실패'} · ${gate.pass ? '게이트 통과' : '게이트 차단'}`);
    return;
  }

  if (!gate.pass) {
    console.log('게이트가 막혀 개선 제안을 만들지 않습니다 — 지금 상태가 이미 배포 불가입니다.');
    await notify(`🚫 ${date} 개선 중단\n게이트 차단: ${gate.blockers.map((b) => b.code).join(', ')}`);
    return;
  }

  // 개선 제안은 브랜치에만 남긴다. main은 건드리지 않는다.
  const branch = `improve/${date}-${Date.now().toString(36)}`;
  const dirty = git('status', '--porcelain');
  if (dirty) {
    console.log('작업 트리에 커밋되지 않은 변경이 있어 브랜치를 만들지 않습니다:');
    console.log(dirty.split('\n').slice(0, 10).join('\n'));
    return;
  }

  fs.mkdirSync(PROPOSAL_DIR, { recursive: true });
  const proposalFile = path.join(PROPOSAL_DIR, `${date}-improve.md`);
  fs.writeFileSync(proposalFile, [
    `# ${date} 개선 제안`,
    '',
    '## 복기 요약',
    `- 거래 ${summary.tradeCount}건 · 판정 가능 ${summary.judgedCount}건`,
    `- ${calibration.reason}`,
    '',
    '## 기계 판단 보정 제안',
    calibration.suggestions.length
      ? calibration.suggestions.map((s) => `- **${s.param}** ${s.direction}: ${s.rationale}\n  - 근거: ${s.evidence}`).join('\n')
      : '(없음 — 표본 부족이거나 한 방향으로 치우친 패턴 없음)',
    '',
    '## 배포 게이트',
    `- 테스트: ${tests.passed}/${tests.total} 통과`,
    `- 판정: ${gate.reason}`,
    ...gate.warnings.map((w) => `- ⚠ ${w}`),
    '',
    '---',
    '',
    '이 제안은 **자동 적용되지 않았습니다.** 브랜치를 확인하고 직접 병합하세요.',
    `브랜치: \`${branch}\``,
    '',
    '병합 전 반드시:',
    '1. `npm test` 전체 통과 확인',
    '2. 테스트 수가 줄지 않았는지 확인',
    '3. 열린 포지션이 없는지 확인',
    '4. 병합 후 `npm run improve` 로 버전 기록',
  ].join('\n'), 'utf8');

  console.log(`제안서 작성: ${path.relative(ROOT, proposalFile)}`);
  console.log(`\n다음 단계(사람이 실행):`);
  console.log(`  git checkout -b ${branch}`);
  console.log(`  # 제안서를 보고 코드를 고친 뒤`);
  console.log(`  npm test && npm run improve`);

  await notify(`🔧 ${date} 개선 제안 준비됨\n${calibration.suggestions.length}건 제안 · 테스트 ${tests.passed}/${tests.total}\n`
    + `제안서: proposals/${date}-improve.md\n\n⚠ 자동 적용되지 않았습니다.`);
}

main().catch((err) => {
  console.error(`개선 사이클 실패: ${err.message}`);
  process.exitCode = 1;
});
