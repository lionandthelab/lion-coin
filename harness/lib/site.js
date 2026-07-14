'use strict';

// 경과 대시보드(GitHub Pages) 생성 — 순수 함수만. 파일 I/O는 scripts/build-site.js 책임.

const { pickNextTask } = require('./core');

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (ch) => ESCAPES[ch]);
}

function inline(s) {
  return escapeHtml(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
}

// 일일 로그 전용 최소 마크다운 변환기. 하네스가 쓰는 형식(헤딩·불릿·펜스·인라인)만 지원한다.
function renderMarkdown(md) {
  const out = [];
  let inFence = false;
  let fenceBuf = [];
  let listOpen = false;
  const closeList = () => {
    if (listOpen) {
      out.push('</ul>');
      listOpen = false;
    }
  };
  const flushFence = () => {
    out.push(`<pre><code>${escapeHtml(fenceBuf.join('\n'))}\n</code></pre>`);
    fenceBuf = [];
  };

  for (const line of String(md).split('\n')) {
    if (line.startsWith('```')) {
      if (inFence) {
        flushFence();
        inFence = false;
      } else {
        closeList();
        inFence = true;
      }
      continue;
    }
    if (inFence) {
      fenceBuf.push(line);
      continue;
    }
    const h = line.match(/^(#{1,3})\s+(.*)$/);
    if (h) {
      closeList();
      out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`);
      continue;
    }
    const li = line.match(/^-\s+(.*)$/);
    if (li) {
      if (!listOpen) {
        out.push('<ul>');
        listOpen = true;
      }
      out.push(`<li>${inline(li[1])}</li>`);
      continue;
    }
    if (line.trim() === '') {
      closeList();
      continue;
    }
    closeList();
    out.push(`<p>${inline(line)}</p>`);
  }
  if (inFence) flushFence();
  closeList();
  return out.join('\n');
}

function buildSiteModel(state, logFiles) {
  const byId = Object.fromEntries(state.tasks.map((t) => [t.id, t]));
  const depsDone = (t) =>
    (t.depends_on || []).every((id) => byId[id] && byId[id].status === 'done');

  const tasks = state.tasks.map((t) => ({
    id: t.id,
    track: t.track,
    title: t.title,
    status: t.status,
    requiresHuman: !!t.requires_human,
    blocked: t.status !== 'done' && !depsDone(t),
    notes: t.notes || '',
  }));

  const byTrack = {};
  for (const t of state.tasks) {
    const bucket = (byTrack[t.track] ||= { done: 0, total: 0 });
    bucket.total += 1;
    if (t.status === 'done') bucket.done += 1;
  }
  const done = state.tasks.filter((t) => t.status === 'done').length;

  const { task, humanActions } = pickNextTask(state);

  const g = state.goal;
  const configured = g.last_balance_sats != null;
  const receivedSats = configured ? Math.max(0, g.last_balance_sats - g.baseline_sats) : 0;
  const progressPct = Math.min(100, Math.round((receivedSats / g.target_sats) * 100));

  const logs = logFiles
    .map((f) => ({ date: f.name.replace(/\.md$/, ''), html: renderMarkdown(f.content) }))
    .sort((a, b) => (a.date < b.date ? 1 : -1));

  return {
    project: state.project,
    iteration: state.iteration,
    goal: {
      description: g.description,
      configured,
      achieved: !!g.achieved,
      achievedAt: g.achieved_at,
      receivedSats,
      targetSats: g.target_sats,
      lastBalanceSats: g.last_balance_sats,
      lastCheckedAt: g.last_checked_at,
      progressPct,
    },
    progress: { done, total: state.tasks.length, byTrack },
    tasks,
    nextTaskId: task ? task.id : null,
    humanActionIds: humanActions.map((t) => t.id),
    logs,
  };
}

const TRACK_NAMES = { A: '트랙 A — 지갑 개발 학습', B: '트랙 B — 라이트닝 수익', C: '트랙 C — 상품·콘텐츠' };

function statusBadge(t) {
  if (t.status === 'done') return '<span class="badge done">✓ 완료</span>';
  if (t.status === 'in_progress') return '<span class="badge active">▸ 진행 중</span>';
  if (t.requiresHuman) return '<span class="badge human">⚠ 사람 작업</span>';
  if (t.blocked) return '<span class="badge blocked">◌ 선행 대기</span>';
  return '<span class="badge pending">○ 대기</span>';
}

function renderPage(model, generatedAtIso) {
  const g = model.goal;
  const heroValue = g.achieved
    ? `🎉 ${g.receivedSats}`
    : String(g.receivedSats);
  const walletLine = g.configured
    ? `지갑 잔액 ${g.lastBalanceSats} sats · 마지막 확인 ${escapeHtml(g.lastCheckedAt || '-')}`
    : '<span class="badge human">⚠ 지갑 연동 대기</span> Blink 지갑 개설(B1) 후 API 키 설정(B2)이 되면 매일 자동 판정됩니다';

  const tiles = [
    { label: '실행 회차', value: String(model.iteration) },
    { label: '작업 진행', value: `${model.progress.done}/${model.progress.total}` },
    ...Object.entries(model.progress.byTrack).map(([track, b]) => ({
      label: TRACK_NAMES[track] || `트랙 ${track}`,
      value: `${b.done}/${b.total}`,
    })),
  ]
    .map(
      (t) => `<div class="tile"><div class="tile-label">${escapeHtml(t.label)}</div><div class="tile-value">${escapeHtml(t.value)}</div></div>`
    )
    .join('\n');

  const taskRows = model.tasks
    .map(
      (t) => `<tr class="${t.id === model.nextTaskId ? 'next' : ''}">
<td class="tid">${escapeHtml(t.id)}</td>
<td>${escapeHtml(t.title)}${t.id === model.nextTaskId ? ' <span class="badge active">다음 회차</span>' : ''}${t.notes ? `<div class="notes">${escapeHtml(t.notes)}</div>` : ''}</td>
<td>${statusBadge(t)}</td>
</tr>`
    )
    .join('\n');

  const logSections = model.logs
    .map(
      (l, i) => `<details${i === 0 ? ' open' : ''}><summary>${escapeHtml(l.date)}</summary><div class="log-body">${l.html}</div></details>`
    )
    .join('\n');

  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Satoshi Zero-to-One — 자율 하네스 경과</title>
<style>
:root {
  color-scheme: light;
  --plane: #f9f9f7; --surface: #fcfcfb;
  --ink: #0b0b0b; --ink-2: #52514e; --muted: #898781;
  --hairline: rgba(11,11,11,0.10); --grid: #e1e0d9;
  --accent: #2a78d6; --meter-track: #cde2fb;
  --good: #0ca30c; --good-text: #006300; --warning: #fab219;
}
@media (prefers-color-scheme: dark) {
  :root {
    color-scheme: dark;
    --plane: #0d0d0d; --surface: #1a1a19;
    --ink: #ffffff; --ink-2: #c3c2b7; --muted: #898781;
    --hairline: rgba(255,255,255,0.10); --grid: #2c2c2a;
    --accent: #3987e5; --meter-track: #104281;
    --good: #0ca30c; --good-text: #0ca30c; --warning: #fab219;
  }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--plane); color: var(--ink);
  font: 15px/1.6 system-ui, -apple-system, "Segoe UI", sans-serif; }
main { max-width: 880px; margin: 0 auto; padding: 32px 20px 64px; }
h1 { font-size: 24px; margin: 0 0 4px; }
.subtitle { color: var(--ink-2); margin: 0 0 28px; }
.subtitle a { color: var(--accent); text-decoration: none; }
.card { background: var(--surface); border: 1px solid var(--hairline);
  border-radius: 10px; padding: 20px; margin-bottom: 16px; }
.hero-label { color: var(--ink-2); font-size: 14px; }
.hero-value { font-size: 52px; font-weight: 600; line-height: 1.15; }
.hero-value .unit { font-size: 20px; font-weight: 400; color: var(--ink-2); }
.meter { height: 10px; border-radius: 5px; background: var(--meter-track);
  overflow: hidden; margin: 14px 0 8px; }
.meter > div { height: 100%; border-radius: 5px 0 0 5px; background: var(--accent); }
.meter.full > div { background: var(--good); border-radius: 5px; }
.wallet-line { color: var(--ink-2); font-size: 13px; }
.tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  gap: 12px; margin-bottom: 16px; }
.tile { background: var(--surface); border: 1px solid var(--hairline);
  border-radius: 10px; padding: 14px 16px; }
.tile-label { color: var(--ink-2); font-size: 12.5px; }
.tile-value { font-size: 26px; font-weight: 600; margin-top: 2px; }
h2 { font-size: 17px; margin: 28px 0 10px; }
table { width: 100%; border-collapse: collapse; font-size: 14px; }
th { text-align: left; color: var(--muted); font-weight: 500; font-size: 12.5px;
  border-bottom: 1px solid var(--grid); padding: 6px 8px; }
td { border-bottom: 1px solid var(--grid); padding: 8px; vertical-align: top; }
tr:last-child td { border-bottom: none; }
tr.next td { background: color-mix(in srgb, var(--accent) 7%, transparent); }
.tid { color: var(--muted); font-family: ui-monospace, monospace; white-space: nowrap; }
.notes { color: var(--muted); font-size: 12.5px; margin-top: 2px; }
.badge { display: inline-block; font-size: 12px; border-radius: 999px;
  padding: 1px 9px; border: 1px solid var(--hairline); white-space: nowrap; color: var(--ink-2); }
.badge.done { color: var(--good-text); border-color: var(--good); }
.badge.active { color: var(--accent); border-color: var(--accent); }
.badge.human { color: var(--ink); border-color: var(--warning);
  background: color-mix(in srgb, var(--warning) 18%, transparent); }
.badge.blocked, .badge.pending { color: var(--muted); }
details { background: var(--surface); border: 1px solid var(--hairline);
  border-radius: 10px; padding: 12px 16px; margin-bottom: 10px; }
summary { cursor: pointer; font-weight: 600; }
.log-body { border-top: 1px solid var(--grid); margin-top: 10px; padding-top: 4px; }
.log-body h1 { font-size: 16px; } .log-body h2 { font-size: 14.5px; margin: 14px 0 6px; }
.log-body pre { background: var(--plane); border: 1px solid var(--grid);
  border-radius: 8px; padding: 10px 12px; overflow-x: auto; font-size: 12.5px; }
code { font-family: ui-monospace, SFMono-Regular, monospace; font-size: 0.92em; }
footer { color: var(--muted); font-size: 12.5px; margin-top: 32px; }
footer a { color: var(--accent); text-decoration: none; }
</style>
</head>
<body>
<main>
<h1>Satoshi Zero-to-One</h1>
<p class="subtitle">외부 구매 없이, 직접 만든 제품을 팔아 라이트닝으로 첫 1,000원어치 비트코인을 수령할 때까지 —
매일 스스로 한 회차씩 전진하는 자율 하네스. <a href="https://github.com/lionandthelab/lion-coin">GitHub 저장소</a></p>

<section class="card">
<div class="hero-label">${g.achieved ? '목표 달성 — 실수령 sats' : '실수령 sats (자가 입금 제외)'}</div>
<div class="hero-value">${heroValue}<span class="unit"> / ${g.targetSats} sats</span></div>
<div class="meter${g.achieved ? ' full' : ''}"><div style="width: ${g.progressPct}%"></div></div>
<div class="wallet-line">${walletLine}</div>
</section>

<div class="tiles">
${tiles}
</div>

<h2>작동 방식</h2>
<section class="card">
<p>launchd가 매일 09:37 KST에 하네스를 깨우면, 에이전트가 <strong>목표 판정 → 다음 작업 선택 → TDD 수행 → 일일 로그 → 커밋·푸시</strong>의
한 회차를 자율 수행합니다. 목표(600 sats 실수령)가 달성되면 스케줄을 스스로 해제하고 종료합니다.
전체 전략은 저장소의 제안서(<code>비트코인_획득_전략_및_개발제안서.md</code>) 참고.</p>
</section>

<h2>작업 보드 (${model.progress.done}/${model.progress.total} 완료)</h2>
<section class="card">
<table>
<thead><tr><th>ID</th><th>작업</th><th>상태</th></tr></thead>
<tbody>
${taskRows}
</tbody>
</table>
</section>

<h2>일일 로그</h2>
${logSections || '<p class="subtitle">아직 로그가 없습니다.</p>'}

<footer>마지막 빌드: ${escapeHtml(generatedAtIso)} ·
<a href="https://github.com/lionandthelab/lion-coin/tree/main/logs">로그 원본</a> ·
<a href="https://github.com/lionandthelab/lion-coin/blob/main/harness/state.json">상태 머신</a></footer>
</main>
</body>
</html>
`;
}

module.exports = { renderMarkdown, buildSiteModel, renderPage, escapeHtml };
