const { test } = require('node:test');
const assert = require('node:assert/strict');

const { renderMarkdown, buildSiteModel, renderPage } = require('../harness/lib/site');

// ---- renderMarkdown (일일 로그 전용 최소 변환기) ----

test('renderMarkdown: 헤딩 1~3레벨을 h1~h3으로 변환', () => {
  const html = renderMarkdown('# 제목\n## 소제목\n### 소소제목');
  assert.match(html, /<h1>제목<\/h1>/);
  assert.match(html, /<h2>소제목<\/h2>/);
  assert.match(html, /<h3>소소제목<\/h3>/);
});

test('renderMarkdown: 불릿 목록을 ul/li로 변환', () => {
  const html = renderMarkdown('- 하나\n- 둘');
  assert.match(html, /<ul>\s*<li>하나<\/li>\s*<li>둘<\/li>\s*<\/ul>/);
});

test('renderMarkdown: 코드 펜스는 pre/code로, 내용은 이스케이프', () => {
  const html = renderMarkdown('```bash\nnode -e "<x>"\n```');
  assert.match(html, /<pre><code>node -e &quot;&lt;x&gt;&quot;\n<\/code><\/pre>/);
});

test('renderMarkdown: 인라인 코드와 볼드 처리', () => {
  const html = renderMarkdown('이건 `code`와 **bold** 다');
  assert.match(html, /<code>code<\/code>/);
  assert.match(html, /<strong>bold<\/strong>/);
});

test('renderMarkdown: 원문 HTML은 이스케이프된다 (XSS 차단)', () => {
  const html = renderMarkdown('<script>alert(1)</script>');
  assert.ok(!html.includes('<script>'));
  assert.ok(html.includes('&lt;script&gt;'));
});

// ---- buildSiteModel ----

function fixtureState() {
  return {
    project: 'satoshi-zero-to-one',
    iteration: 3,
    goal: {
      description: '테스트 목표',
      target_sats: 600,
      baseline_sats: 100,
      achieved: false,
      achieved_at: null,
      last_checked_at: '2026-07-14T00:00:00.000Z',
      last_balance_sats: 250,
    },
    tasks: [
      { id: 'A1', track: 'A', title: '완료 작업', status: 'done', requires_human: false, depends_on: [], notes: '' },
      { id: 'A2', track: 'A', title: '다음 작업', status: 'pending', requires_human: false, depends_on: ['A1'], notes: '' },
      { id: 'A5', track: 'A', title: '막힌 작업', status: 'pending', requires_human: false, depends_on: ['A3'], notes: '' },
      { id: 'A3', track: 'A', title: '사람 작업', status: 'pending', requires_human: true, depends_on: [], notes: '' },
      { id: 'B1', track: 'B', title: '사람 작업2', status: 'pending', requires_human: true, depends_on: [], notes: '' },
      { id: 'C1', track: 'C', title: 'C 작업', status: 'done', requires_human: false, depends_on: [], notes: '' },
    ],
  };
}

test('buildSiteModel: 전체·트랙별 진행 카운트를 계산한다', () => {
  const m = buildSiteModel(fixtureState(), []);
  assert.equal(m.progress.done, 2);
  assert.equal(m.progress.total, 6);
  assert.deepEqual(m.progress.byTrack.A, { done: 1, total: 4 });
  assert.deepEqual(m.progress.byTrack.C, { done: 1, total: 1 });
});

test('buildSiteModel: 목표 지표 — baseline 제외 수령액과 진행률', () => {
  const m = buildSiteModel(fixtureState(), []);
  assert.equal(m.goal.configured, true);
  assert.equal(m.goal.receivedSats, 150);
  assert.equal(m.goal.targetSats, 600);
  assert.equal(m.goal.progressPct, 25);
});

test('buildSiteModel: 잔액 미조회면 configured=false, 수령액 0', () => {
  const s = fixtureState();
  s.goal.last_balance_sats = null;
  const m = buildSiteModel(s, []);
  assert.equal(m.goal.configured, false);
  assert.equal(m.goal.receivedSats, 0);
});

test('buildSiteModel: 의존성 미충족 작업은 blocked로 표시', () => {
  const m = buildSiteModel(fixtureState(), []);
  const byId = Object.fromEntries(m.tasks.map((t) => [t.id, t]));
  assert.equal(byId.A2.blocked, false);
  assert.equal(byId.A5.blocked, true);
});

test('buildSiteModel: 다음 작업과 사람 작업 목록을 노출', () => {
  const m = buildSiteModel(fixtureState(), []);
  assert.equal(m.nextTaskId, 'A2');
  assert.deepEqual(m.humanActionIds, ['A3', 'B1']);
});

test('buildSiteModel: 로그는 파일명 날짜 기준 최신순 정렬', () => {
  const logs = [
    { name: '2026-07-14.md', content: '# a' },
    { name: '2026-07-16.md', content: '# b' },
    { name: '2026-07-15.md', content: '# c' },
  ];
  const m = buildSiteModel(fixtureState(), logs);
  assert.deepEqual(m.logs.map((l) => l.date), ['2026-07-16', '2026-07-15', '2026-07-14']);
  assert.match(m.logs[0].html, /<h1>b<\/h1>/);
});

// ---- renderPage ----

test('renderPage: 히어로 수치·미터·상태 라벨이 포함된 완결 HTML을 만든다', () => {
  const html = renderPage(buildSiteModel(fixtureState(), []), '2026-07-14T12:00:00Z');
  assert.match(html, /<!doctype html>/i);
  assert.match(html, /150/); // 히어로: 수령 sats
  assert.match(html, /width:\s*25%/); // 미터 진행률
  assert.match(html, /완료/); // 상태 라벨 (색상 단독 금지)
  assert.match(html, /사람 작업/);
});

test('renderPage: 작업 제목의 HTML은 이스케이프된다', () => {
  const s = fixtureState();
  s.tasks[0].title = '<img onerror=x>';
  const html = renderPage(buildSiteModel(s, []), '2026-07-14T12:00:00Z');
  assert.ok(!html.includes('<img onerror'));
});
