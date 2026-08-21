const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const {
  EVENT_KEYS,
  parseUpbitNotices,
  parseBithumbNotices,
  parseRss,
  buildUpbitNoticesUrl,
  buildBithumbNoticesUrl,
  fetchUpbitNotices,
  fetchBithumbNotices,
  fetchRss,
  dedupeNewEvents,
  filterFreshEvents,
  hasUsableTime,
} = require('../src/event-sources');

const FIXTURES = path.join(__dirname, 'fixtures');
const readFixture = (name) => fs.readFileSync(path.join(FIXTURES, name), 'utf8');

const upbitJson = () => JSON.parse(readFixture('upbit-notices.json'));
const bithumbJson = () => JSON.parse(readFixture('bithumb-notices.json'));
const blockmediaXml = () => readFixture('blockmedia-rss.xml');

// 이 모듈이 틀리면 "오래된 공지를 새 재료로 오인해" 매매한다. 그래서 테스트의 절반은
// 시각(epoch ms)이 정확한가, 나머지 절반은 항목이 조용히 사라지지 않는가에 걸려 있다.

// ---- parseUpbitNotices ----

test('parseUpbitNotices: 픽스처의 30건이 하나도 빠짐없이 Event로 나온다', () => {
  const events = parseUpbitNotices(upbitJson());
  // 개수 일치가 "조용히 버리지 않는다"의 유일한 증거다. 파싱이 애매한 항목도
  // 버리는 대신 at: null로 표시해 내보내야 하므로 길이는 항상 입력과 같다.
  assert.equal(events.length, 30);
  for (const e of events) {
    assert.deepEqual(Object.keys(e).sort(), [...EVENT_KEYS].sort());
    assert.equal(e.source, 'upbit');
    assert.match(e.id, /^upbit:\d+$/);
    assert.equal(typeof e.title, 'string');
    assert.ok(e.title.length > 0);
  }
});

test('parseUpbitNotices: listed_at의 +09:00 오프셋이 정확한 epoch ms로 변환된다', () => {
  const events = parseUpbitNotices(upbitJson());
  const nexo = events.find((e) => e.id === 'upbit:6496');
  // 2026-08-21T19:19:25+09:00 — 오프셋이 문자열에 박혀 있으므로 호스트 TZ와 무관하다.
  assert.equal(nexo.at, Date.parse('2026-08-21T19:19:25+09:00'));
  assert.equal(nexo.category, '거래');
  assert.equal(nexo.url, 'https://upbit.com/service_center/notice?id=6496');
});

test('parseUpbitNotices: at은 first_listed_at이다 — 수정으로 끌어올려진 listed_at이 아니다', () => {
  const events = parseUpbitNotices(upbitJson());
  // 픽스처 30건 중 11건이 listed_at != first_listed_at이다. id 6413은 07-26에 처음
  // 올라온 뒤 08-14에 수정으로 목록 위로 올라왔다 — listed_at을 쓰면 19일 묵은
  // 공지가 방금 뜬 재료로 보인다. 그 오인이 곧 손실이다.
  const old = events.find((e) => e.id === 'upbit:6413');
  assert.equal(old.at, Date.parse('2026-07-26T08:30:03+09:00'));
  assert.notEqual(old.at, Date.parse('2026-08-14T15:58:17+09:00'));
  // 수정 시각 자체는 버리지 않고 updatedAt으로 남긴다.
  assert.equal(old.updatedAt, Date.parse('2026-08-14T15:58:17+09:00'));
});

test('parseUpbitNotices: success:false 응답은 빈 배열이 아니라 예외다', () => {
  // 조용한 빈 배열은 "오늘 공지가 없다"와 구분되지 않는다 — 장애를 정상으로 위장한다.
  assert.throws(() => parseUpbitNotices({ success: false, data: null }), /업비트/);
  assert.throws(() => parseUpbitNotices(null), /업비트/);
  assert.throws(() => parseUpbitNotices({ success: true, data: { notices: '30' } }), /배열/);
});

test('parseUpbitNotices: 공지가 0건인 정상 응답은 빈 배열이다', () => {
  assert.deepEqual(parseUpbitNotices({ success: true, data: { notices: [] } }), []);
});

test('parseUpbitNotices: 시각 문자열이 깨져도 항목을 버리지 않고 at: null로 표시한다', () => {
  const events = parseUpbitNotices({
    success: true,
    data: {
      notices: [
        { id: 1, title: '정상', category: '거래', first_listed_at: '2026-08-21T19:00:00+09:00' },
        { id: 2, title: '깨진 시각', category: '거래', first_listed_at: 'yesterday-ish' },
        { id: 3, title: '시각 없음', category: null },
      ],
    },
  });
  assert.equal(events.length, 3);
  assert.equal(events[1].at, null);
  assert.equal(events[2].at, null);
  assert.equal(events[2].category, null);
  assert.equal(hasUsableTime(events[0]), true);
  assert.equal(hasUsableTime(events[1]), false);
});

// ---- parseBithumbNotices ----

test('parseBithumbNotices: 픽스처 5건이 같은 Event 모양으로 정규화된다', () => {
  const events = parseBithumbNotices(bithumbJson());
  assert.equal(events.length, 5);
  for (const e of events) {
    assert.deepEqual(Object.keys(e).sort(), [...EVENT_KEYS].sort());
    assert.equal(e.source, 'bithumb');
  }
  const mega = events.find((e) => e.title.startsWith('메가이더'));
  assert.equal(mega.category, '입출금');
  assert.equal(mega.url, 'https://feed.bithumb.com/notice/1654571');
});

test('parseBithumbNotices: published_at을 KST로 못박아 해석한다', () => {
  const events = parseBithumbNotices(bithumbJson());
  const disclosure = events.find((e) => e.title === '재산상 이익 제공 공시');
  // "2026-08-21 19:00:00"에는 오프셋이 없다. KST로 못박지 않고 new Date()에 그대로
  // 넘기면 호스트 TZ에 따라 값이 달라진다 — 서울 노트북에서는 맞고 UTC 서버에서는
  // 9시간 어긋난다. 오프셋을 붙여 해석한 결과와 같아야 한다.
  assert.equal(disclosure.at, Date.parse('2026-08-21T19:00:00+09:00'));
});

test('parseBithumbNotices: 시각 해석이 호스트 타임존에 의존하지 않는다', () => {
  // 위 테스트는 개발 노트북(Asia/Seoul)에서는 잘못된 구현으로도 통과한다.
  // TZ=UTC 자식 프로세스로 실제 독립성을 확인한다.
  const script =
    "const {parseBithumbNotices}=require('" +
    path.join(__dirname, '..', 'src', 'event-sources').replace(/\\/g, '\\\\') +
    "');" +
    "const j=require('" +
    path.join(FIXTURES, 'bithumb-notices.json').replace(/\\/g, '\\\\') +
    "');" +
    'process.stdout.write(String(parseBithumbNotices(j)[0].at));';
  const out = execFileSync(process.execPath, ['-e', script], {
    env: { ...process.env, TZ: 'UTC' },
    encoding: 'utf8',
  });
  assert.equal(Number(out), Date.parse('2026-08-21T19:00:00+09:00'));
});

test('parseBithumbNotices: 배열과 {data:[...]} 래핑을 모두 받는다', () => {
  const rows = bithumbJson();
  assert.deepEqual(parseBithumbNotices({ data: rows }), parseBithumbNotices(rows));
  assert.throws(() => parseBithumbNotices({ data: 'nope' }), /빗썸/);
});

test('parseBithumbNotices: id는 pc_url의 공지 번호에서 만든다', () => {
  const events = parseBithumbNotices(bithumbJson());
  assert.equal(events.find((e) => e.title === '재산상 이익 제공 공시').id, 'bithumb:1654573');
});

test('parseBithumbNotices: pc_url이 없으면 제목+발행시각 해시로 안정적인 id를 만든다', () => {
  const row = { categories: ['공시'], title: '무링크 공지', published_at: '2026-08-21 19:00:00' };
  const a = parseBithumbNotices([row])[0];
  const b = parseBithumbNotices([{ ...row }])[0];
  // 폴링은 같은 공지를 계속 다시 받는다. id가 호출마다 달라지면 중복 제거가
  // 통째로 무력해져 같은 재료로 반복 진입한다.
  assert.equal(a.id, b.id);
  assert.match(a.id, /^bithumb:h_[0-9a-f]{12}$/);
  assert.notEqual(a.id, parseBithumbNotices([{ ...row, title: '다른 공지' }])[0].id);
  assert.equal(a.url, null);
});

test('parseBithumbNotices: 형식이 깨진 항목도 버리지 않고 at: null로 내보낸다', () => {
  const events = parseBithumbNotices([
    { categories: ['거래유의'], title: '정상', pc_url: 'https://feed.bithumb.com/notice/1', published_at: '2026-08-21 17:00:00' },
    { categories: [], title: '시각 깨짐', pc_url: 'https://feed.bithumb.com/notice/2', published_at: '어제' },
    { title: '시각 없음', pc_url: 'https://feed.bithumb.com/notice/3' },
  ]);
  assert.equal(events.length, 3);
  assert.equal(events[1].at, null);
  assert.equal(events[2].at, null);
  assert.equal(events[1].category, null);
  assert.equal(events.filter(hasUsableTime).length, 1);
});

// ---- parseRss ----

test('parseRss: 블록미디어 픽스처 10건이 같은 Event 모양으로 정규화된다', () => {
  const events = parseRss(blockmediaXml(), 'blockmedia');
  assert.equal(events.length, 10);
  for (const e of events) {
    assert.deepEqual(Object.keys(e).sort(), [...EVENT_KEYS].sort());
    assert.equal(e.source, 'blockmedia');
    assert.ok(e.id.startsWith('blockmedia:'));
    assert.equal(typeof e.at, 'number');
  }
  assert.equal(events[0].at, Date.parse('2026-08-21T21:12:12Z'));
  assert.equal(events[0].category, '마켓');
});

test('parseRss: 채널 제목·링크를 기사로 오인하지 않는다', () => {
  const events = parseRss(blockmediaXml(), 'blockmedia');
  // <channel>과 <image>에도 <title>/<link>가 있다. item 바깥을 긁으면 "블록미디어"라는
  // 유령 기사가 매 폴링마다 새 재료로 뜬다.
  assert.equal(events.filter((e) => e.title === '블록미디어').length, 0);
  assert.equal(events.filter((e) => e.url === 'https://www.blockmedia.co.kr/').length, 0);
});

test('parseRss: pubDate2 같은 유사 태그를 pubDate로 착각하지 않는다', () => {
  // 블록미디어 피드는 <pubDate>(UTC 오프셋 명시) 뒤에 <pubDate2>(KST, 오프셋 없음)를
  // 함께 싣는다. 느슨한 정규식은 뒤엣것을 집어 9시간 어긋난 시각을 만든다.
  const xml = `<rss><channel><item>
    <title>오프셋 없는 시각만 있는 기사</title>
    <link>https://x.test/1</link>
    <pubDate2>2026-08-22 06:12:12</pubDate2>
  </item></channel></rss>`;
  const [e] = parseRss(xml, 'blockmedia');
  assert.equal(e.at, null, 'pubDate가 없으므로 시각을 지어내면 안 된다');
  assert.equal(e.title, '오프셋 없는 시각만 있는 기사');
});

test('parseRss: CDATA와 HTML 엔티티를 디코딩한다', () => {
  const events = parseRss(blockmediaXml(), 'blockmedia');
  const dalio = events.find((e) => e.title.startsWith('레이 달리오'));
  assert.equal(dalio.title, '레이 달리오 “정부 못 만드는 금·비트코인 사라”');
  // 링크의 &amp;도 풀어야 실제로 열리는 URL이 된다.
  assert.equal(events[0].url, 'https://www.blockmedia.co.kr/archives/1130680?utm_source=general&utm_medium=rss');

  const cdata = `<rss><channel><item>
    <title><![CDATA[토큰포스트 & <속보>]]></title>
    <link><![CDATA[https://www.tokenpost.kr/article-1?a=1&b=2]]></link>
    <pubDate>Fri, 21 Aug 2026 21:12:12 +0900</pubDate>
  </item></channel></rss>`;
  const [tp] = parseRss(cdata, 'tokenpost');
  assert.equal(tp.title, '토큰포스트 & <속보>');
  assert.equal(tp.source, 'tokenpost');
  assert.equal(tp.at, Date.parse('2026-08-21T21:12:12+09:00'));
});

test('parseRss: guid가 있으면 id로 쓰고 없으면 link로 대체한다', () => {
  const events = parseRss(blockmediaXml(), 'blockmedia');
  // link에는 utm_* 추적 파라미터가 붙어 폴링마다 달라질 수 있다. guid가 더 안정적이다.
  assert.equal(events[0].id, 'blockmedia:https://www.blockmedia.co.kr/?p=1130680');

  const noGuid = `<rss><channel><item><title>제목</title><link>https://x.test/a</link>
    <pubDate>Fri, 21 Aug 2026 21:12:12 +0000</pubDate></item></channel></rss>`;
  assert.equal(parseRss(noGuid, 'tokenpost')[0].id, 'tokenpost:https://x.test/a');

  const bare = `<rss><channel><item><title>링크도 없음</title>
    <pubDate>Fri, 21 Aug 2026 21:12:12 +0000</pubDate></item></channel></rss>`;
  assert.match(parseRss(bare, 'tokenpost')[0].id, /^tokenpost:h_[0-9a-f]{12}$/);
});

test('parseRss: source가 없으면 예외 — id 접두어가 비면 소스 간 id가 충돌한다', () => {
  assert.throws(() => parseRss(blockmediaXml()), /source/);
  assert.throws(() => parseRss(blockmediaXml(), ''), /source/);
  assert.throws(() => parseRss(123, 'blockmedia'), /문자열/);
});

test('parseRss: 빈 응답·item 없는 XML은 빈 배열이다', () => {
  assert.deepEqual(parseRss('', 'blockmedia'), []);
  assert.deepEqual(parseRss('<rss><channel><title>비어 있음</title></channel></rss>', 'blockmedia'), []);
  // 닫히지 않은 item은 항목으로 세지 않는다 — 반쯤 받은 응답을 기사로 만들지 않는다.
  assert.deepEqual(parseRss('<rss><channel><item><title>잘린 응답', 'blockmedia'), []);
});

test('parseRss: 제목이 없는 항목도 버리지 않고 빈 제목으로 내보낸다', () => {
  const xml = `<rss><channel>
    <item><title>정상</title><pubDate>Fri, 21 Aug 2026 21:12:12 +0000</pubDate></item>
    <item><link>https://x.test/b</link><pubDate>Fri, 21 Aug 2026 21:12:12 +0000</pubDate></item>
  </channel></rss>`;
  const events = parseRss(xml, 'tokenpost');
  assert.equal(events.length, 2);
  assert.equal(events[1].title, '');
});

// ---- 세 소스의 정규화 일치 ----

test('세 소스가 완전히 같은 키 집합의 Event를 낸다', () => {
  const all = [
    parseUpbitNotices(upbitJson())[0],
    parseBithumbNotices(bithumbJson())[0],
    parseRss(blockmediaXml(), 'blockmedia')[0],
  ];
  const keys = Object.keys(all[0]).sort();
  for (const e of all) {
    assert.deepEqual(Object.keys(e).sort(), keys);
    assert.equal(typeof e.id, 'string');
    assert.equal(e.id.split(':')[0], e.source);
    assert.equal(typeof e.at, 'number');
    assert.ok(e.at > Date.parse('2020-01-01T00:00:00Z'));
  }
  assert.deepEqual(keys, [...EVENT_KEYS].sort());
});

test('소스가 달라도 id는 충돌하지 않는다', () => {
  const ids = [
    ...parseUpbitNotices(upbitJson()),
    ...parseBithumbNotices(bithumbJson()),
    ...parseRss(blockmediaXml(), 'blockmedia'),
  ].map((e) => e.id);
  assert.equal(new Set(ids).size, ids.length);
});

// ---- dedupeNewEvents ----

test('dedupeNewEvents: 첫 폴링은 전부 새 것, 같은 응답을 다시 받으면 하나도 새롭지 않다', () => {
  const events = parseUpbitNotices(upbitJson());
  const first = dedupeNewEvents(events, new Set());
  assert.equal(first.fresh.length, 30);
  const second = dedupeNewEvents(events, first.seenIds);
  assert.equal(second.fresh.length, 0);
  assert.equal(second.seenIds.size, 30);
});

test('dedupeNewEvents: 한 배치 안의 중복도 제거하고 앞의 것을 남긴다', () => {
  const dup = [
    { id: 'upbit:1', source: 'upbit', at: 1, title: '먼저', category: null, url: null, updatedAt: null },
    { id: 'upbit:1', source: 'upbit', at: 2, title: '나중', category: null, url: null, updatedAt: null },
    { id: 'upbit:2', source: 'upbit', at: 3, title: '다른 것', category: null, url: null, updatedAt: null },
  ];
  const { fresh } = dedupeNewEvents(dup, new Set());
  assert.equal(fresh.length, 2);
  assert.equal(fresh[0].title, '먼저');
});

test('dedupeNewEvents: 입력 seenIds를 변경하지 않는다 (실패 시 롤백 가능하도록)', () => {
  const seen = new Set(['upbit:1']);
  const events = [{ id: 'upbit:2', source: 'upbit', at: 1, title: 'x', category: null, url: null, updatedAt: null }];
  const out = dedupeNewEvents(events, seen);
  assert.equal(seen.size, 1, '원본 Set은 그대로여야 한다');
  assert.equal(out.seenIds.size, 2);
  assert.notEqual(out.seenIds, seen);
  // 배열이나 생략도 받는다 — 첫 실행에는 저장된 seen이 없다.
  assert.equal(dedupeNewEvents(events, ['upbit:2']).fresh.length, 0);
  assert.equal(dedupeNewEvents(events).fresh.length, 1);
});

test('dedupeNewEvents: seenIds가 maxSeen에서 잘려 무한히 자라지 않는다', () => {
  // 상시 폴링 데몬에서 Set이 무한히 커지는 것을 막는다. 오래된 id부터 버린다.
  const mk = (i) => ({ id: `upbit:${i}`, source: 'upbit', at: i, title: `t${i}`, category: null, url: null, updatedAt: null });
  let seen = new Set();
  for (let i = 0; i < 10; i += 1) seen = dedupeNewEvents([mk(i)], seen, { maxSeen: 4 }).seenIds;
  assert.equal(seen.size, 4);
  assert.deepEqual([...seen], ['upbit:6', 'upbit:7', 'upbit:8', 'upbit:9']);
});

test('dedupeNewEvents: id가 없는 항목은 통과시키지 않고 예외로 알린다', () => {
  // id 없는 항목을 그냥 흘려보내면 매 폴링마다 같은 재료가 새 것으로 되살아난다.
  assert.throws(() => dedupeNewEvents([{ source: 'upbit', title: 'x' }], new Set()), /id/);
  assert.throws(() => dedupeNewEvents('배열 아님', new Set()), /배열/);
});

// ---- 네트워크 래퍼 (fetch 주입) ----

test('buildUpbitNoticesUrl / buildBithumbNoticesUrl: limit이 쿼리에 반영된다', () => {
  assert.equal(
    buildUpbitNoticesUrl({ limit: 30 }),
    'https://api-manager.upbit.com/api/v1/announcements?os=web&page=1&per_page=30&category=all'
  );
  assert.equal(buildBithumbNoticesUrl({ limit: 10 }), 'https://api.bithumb.com/v1/notices?count=10');
  assert.throws(() => buildUpbitNoticesUrl({ limit: 0 }), /limit/);
  assert.throws(() => buildBithumbNoticesUrl({ limit: 1.5 }), /limit/);
});

test('fetch 래퍼는 주입된 fetch로 파서를 그대로 태운다', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    return { ok: true, status: 200, json: async () => upbitJson(), text: async () => blockmediaXml() };
  };
  const events = await fetchUpbitNotices({ limit: 30, fetchImpl });
  assert.equal(events.length, 30);
  assert.equal(calls[0], buildUpbitNoticesUrl({ limit: 30 }));

  const bh = await fetchBithumbNotices({
    limit: 5,
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => bithumbJson() }),
  });
  assert.equal(bh.length, 5);
  assert.equal(bh[0].source, 'bithumb');

  const rss = await fetchRss({ url: 'https://www.blockmedia.co.kr/feed', source: 'blockmedia', fetchImpl });
  assert.equal(rss.length, 10);
  assert.equal(rss[0].source, 'blockmedia');
});

test('fetch 래퍼는 HTTP 오류를 빈 배열로 삼키지 않는다', async () => {
  const fetchImpl = async () => ({ ok: false, status: 503, json: async () => ({}), text: async () => '' });
  await assert.rejects(() => fetchUpbitNotices({ fetchImpl }), /503/);
  await assert.rejects(() => fetchBithumbNotices({ fetchImpl }), /503/);
  await assert.rejects(() => fetchRss({ url: 'https://x.test/feed', source: 'tokenpost', fetchImpl }), /503/);
  await assert.rejects(() => fetchRss({ source: 'tokenpost', fetchImpl }), /url/);
});

// ---- 신선도 필터 ----
//
// 실제로 있었던 사고(2026-08-21): 감시 모드를 켜자마자 27일 전(646시간) 공지까지
// 전부 "새 재료"로 수집됐다. 폴링 첫 회에는 seenIds가 비어 있어 응답 전체가 신규로
// 잡히기 때문이다. 이 상태로 실거래를 켰다면 **이미 다 반영된 옛 뉴스를 재료로 믿고
// 정확히 고점을 샀을 것이다.**
//
// 유목민식 매매의 전제는 "아직 시장에 퍼지지 않은 재료"다. 나이 제한이 없으면
// 그 전제가 무너진다. 중복 제거만으로는 막을 수 없다 — 처음 보는 것은 맞기 때문이다.

test('filterFreshEvents: 기준보다 오래된 재료를 걸러낸다', () => {
  const now = 1_000_000_000;
  const { fresh, stale } = filterFreshEvents(
    [
      { id: 'a', at: now - 60_000 },        // 1분 전
      { id: 'b', at: now - 20 * 60_000 },   // 20분 전
    ],
    { maxAgeMs: 10 * 60_000, now }
  );
  assert.deepEqual(fresh.map((e) => e.id), ['a']);
  assert.deepEqual(stale.map((e) => e.id), ['b'], '버리지 않고 돌려준다 — 화면에는 보여야 한다');
});

test('filterFreshEvents: 경계값은 포함한다', () => {
  const now = 1_000_000_000;
  const { fresh } = filterFreshEvents([{ id: 'a', at: now - 10 * 60_000 }], { maxAgeMs: 10 * 60_000, now });
  assert.equal(fresh.length, 1);
});

test('filterFreshEvents: 미래 시각도 신선한 것으로 본다', () => {
  // 거래소 서버와 시계가 몇 초 어긋날 수 있다. 미래라고 버리면 방금 나온 공지를 놓친다.
  const now = 1_000_000_000;
  const { fresh } = filterFreshEvents([{ id: 'a', at: now + 5_000 }], { maxAgeMs: 60_000, now });
  assert.equal(fresh.length, 1);
});

test('filterFreshEvents: 시각을 모르는 재료는 신선하지 않은 쪽으로 본다', () => {
  // 시각 파싱에 실패한 항목을 매매에 쓰면 언제 나온 재료인지 모른 채 진입하게 된다.
  const now = 1_000_000_000;
  const { fresh, stale } = filterFreshEvents([{ id: 'a', at: null }], { maxAgeMs: 60_000, now });
  assert.equal(fresh.length, 0);
  assert.equal(stale.length, 1);
});

test('filterFreshEvents: 빈 배열과 잘못된 입력을 안전하게 처리한다', () => {
  const now = 1_000_000_000;
  assert.deepEqual(filterFreshEvents([], { maxAgeMs: 1000, now }).fresh, []);
  assert.throws(() => filterFreshEvents(null, { maxAgeMs: 1000, now }), /배열/);
});

test('filterFreshEvents: maxAgeMs가 양수가 아니면 거부한다', () => {
  assert.throws(() => filterFreshEvents([], { maxAgeMs: 0, now: 1 }), /maxAgeMs/);
  assert.throws(() => filterFreshEvents([], { maxAgeMs: -1, now: 1 }), /maxAgeMs/);
});
