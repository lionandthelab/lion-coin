'use strict';

// 이벤트 소스 어댑터 — 거래소 공지·뉴스를 하나의 Event 모양으로 정규화한다.
// 파싱은 순수 함수, fetch는 얇은 래퍼. 실제 페이로드 픽스처로 파싱만 따로 검증하기 위해서다.
//
// **이 모듈의 유일한 실패 모드는 "오래된 공지를 새 재료로 오인하는 것"이다.**
// 재료 매매는 아직 시장에 퍼지지 않은 정보에서만 우위가 나온다. 이미 반영된
// 공지를 방금 뜬 것으로 읽으면 우위가 0인 정도가 아니라, 이미 급등한 자리에서
// 사는 것이라 기대값이 음수다. 그래서 이 파일의 판단은 전부 시각과 중복 제거에 쏠려 있다.
//
// 세 가지 시각 함정이 실제 페이로드에 들어 있다:
//   1) 업비트는 listed_at(목록 노출)과 first_listed_at(최초 게시)을 따로 준다.
//      픽스처 30건 중 11건이 서로 다르고, 최대 19일 차이가 난다.
//   2) 빗썸 published_at에는 타임존이 없다. 호스트 TZ에 맡기면 서울 노트북에서만 맞다.
//   3) 블록미디어 RSS는 <pubDate>(오프셋 있음) 뒤에 <pubDate2>(KST, 오프셋 없음)를
//      함께 싣는다. 태그 이름을 느슨하게 매칭하면 뒤엣것을 집는다.

const crypto = require('node:crypto');

const UPBIT_BASE = 'https://api-manager.upbit.com';
const BITHUMB_BASE = 'https://api.bithumb.com';

// 빗썸이 오프셋 없이 주는 시각의 해석 기준. 빗썸은 국내 거래소이고 공지 시각은 KST다.
// 픽스처로 교차 확인했다: 빗썸 "메가이더(MEGA) 입출금 일시 중지"가 2026-08-21 18:40:00,
// 업비트의 동일 사건 공지가 2026-08-21T19:05:08+09:00이다. UTC로 읽었다면 9시간
// 벌어졌을 것이므로 KST가 맞다.
const KST_OFFSET = '+09:00';

// 모든 소스가 정확히 이 키만 가진다. 소스별로 키가 다르면 하위 로직이
// 소스마다 분기하게 되고, 새 소스를 붙일 때마다 그 분기를 빠뜨린다.
const EVENT_KEYS = Object.freeze([
  'id',
  'source',
  'at',
  'title',
  'category',
  'url',
  'updatedAt',
]);

// 폴링 데몬은 몇 초마다 돌기 때문에 seenIds가 무한히 자란다. 상한을 둔다.
const DEFAULT_MAX_SEEN = 5000;

// ---- 공용 도우미 ----

function shortHash(...parts) {
  return crypto.createHash('sha1').update(parts.join('|')).digest('hex').slice(0, 12);
}

// 시각은 "모르면 null". 0이나 Date.now()로 위장하면 그 항목이 1970년의 낡은 공지이거나
// 방금 뜬 재료인 것처럼 보인다 — 둘 다 잘못된 매매로 이어진다.
function toEpochMs(value) {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const ms = Date.parse(value.trim());
  return Number.isFinite(ms) ? ms : null;
}

// 오프셋이 없는 "YYYY-MM-DD HH:mm:ss" 형태에만 KST를 붙인다.
// 이미 오프셋(Z, +09:00)이 있으면 그 값을 존중한다 — 임의로 덧씌우면 실제로 UTC로
// 주는 날 9시간이 어긋난다.
function toEpochMsKst(value) {
  if (typeof value !== 'string') return null;
  const s = value.trim();
  if (s === '') return null;
  if (/[zZ]$|[+-]\d{2}:?\d{2}$/.test(s)) return toEpochMs(s);
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (!m) return null;
  const [, y, mo, d, h, mi, sec = '00'] = m;
  return toEpochMs(`${y}-${mo}-${d}T${h}:${mi}:${sec}${KST_OFFSET}`);
}

function normalizeCategory(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

// ---- 업비트 ----

// 업비트 공지는 API가 상세 URL을 주지 않는다. 공지 번호로 조립한다.
function upbitNoticeUrl(id) {
  return `https://upbit.com/service_center/notice?id=${id}`;
}

function parseUpbitNotices(json) {
  if (!json || typeof json !== 'object' || Array.isArray(json)) {
    throw new TypeError('업비트 공지 응답이 객체가 아닙니다');
  }
  // success:false를 빈 배열로 바꾸면 "장애"와 "공지 없음"이 구별되지 않는다.
  // 감시 대상이 조용히 멈춰 있는 것이 이 시스템에서 가장 비싼 실패다.
  if (json.success !== true) {
    throw new Error('업비트 공지 응답 실패: success !== true');
  }
  const notices = json.data && json.data.notices;
  if (!Array.isArray(notices)) {
    throw new TypeError('업비트 공지 응답의 data.notices가 배열이 아닙니다');
  }

  return notices.map((n, i) => {
    if (!n || typeof n !== 'object') {
      throw new TypeError(`업비트 공지[${i}]가 객체가 아닙니다`);
    }
    // at은 최초 게시 시각이다. listed_at은 수정하면 갱신되므로, 그것을 쓰면
    // 오래된 공지가 수정될 때마다 새 재료로 되살아난다(픽스처 30건 중 11건이 해당).
    // 최초 게시가 없을 때만 listed_at으로 물러선다.
    const first = toEpochMsKst(n.first_listed_at);
    const listed = toEpochMsKst(n.listed_at);
    return {
      id: `upbit:${n.id}`,
      source: 'upbit',
      at: first !== null ? first : listed,
      title: typeof n.title === 'string' ? n.title : '',
      category: normalizeCategory(n.category),
      url: n.id === undefined || n.id === null ? null : upbitNoticeUrl(n.id),
      updatedAt: listed,
    };
  });
}

// ---- 빗썸 ----

function parseBithumbNotices(json) {
  const rows = Array.isArray(json) ? json : json && typeof json === 'object' ? json.data : null;
  if (!Array.isArray(rows)) {
    throw new TypeError('빗썸 공지 응답이 배열도 {data:[...]}도 아닙니다');
  }

  return rows.map((n, i) => {
    if (!n || typeof n !== 'object') {
      throw new TypeError(`빗썸 공지[${i}]가 객체가 아닙니다`);
    }
    // 빗썸 응답에는 안정적인 숫자 id 필드가 없다. pc_url 끝의 공지 번호가 사실상의
    // 고유 키이므로 그것을 쓰고, 없을 때만 제목+발행시각 해시로 물러선다.
    // 해시를 쓰는 이유는 id가 호출마다 달라지면(예: 배열 인덱스나 난수) 중복 제거가
    // 통째로 무력해져 같은 공지로 매 폴링마다 다시 진입하기 때문이다.
    const num = typeof n.pc_url === 'string' ? n.pc_url.match(/\/(\d+)\/?$/) : null;
    const id = num ? `bithumb:${num[1]}` : `bithumb:h_${shortHash(n.title || '', n.published_at || '')}`;
    return {
      id,
      source: 'bithumb',
      // published_at은 오프셋이 없다 — KST로 못박는다(위 KST_OFFSET 주석 참고).
      at: toEpochMsKst(n.published_at),
      title: typeof n.title === 'string' ? n.title : '',
      category: normalizeCategory(Array.isArray(n.categories) ? n.categories[0] : n.categories),
      url: typeof n.pc_url === 'string' && n.pc_url !== '' ? n.pc_url : null,
      updatedAt: toEpochMsKst(n.modified_at),
    };
  });
}

// ---- RSS ----

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function decodeEntities(s) {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    // 한 번만 푼다. &amp;amp; 같은 이중 인코딩을 끝까지 벗기면 원문에 실제로 들어 있던
    // "&amp;"까지 바꿔버려, 제목이 원문과 달라진다.
    .replace(/&(amp|lt|gt|quot|apos|nbsp);/gi, (_, name) => ENTITIES[name.toLowerCase()]);
}

function unwrapCdata(s) {
  const m = s.match(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/);
  return m ? m[1] : s;
}

// 태그 이름 뒤에 반드시 공백이나 '>'가 오도록 강제한다. 이 경계가 없으면
// <pubDate>를 찾는 정규식이 <pubDate2>도 집어 9시간 어긋난 시각을 만든다.
function tagText(block, name) {
  const re = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}\\s*>`, 'i');
  const m = block.match(re);
  if (!m) return null;
  const raw = unwrapCdata(m[1]);
  const text = decodeEntities(raw).trim();
  return text === '' ? null : text;
}

function parseRss(xml, source) {
  if (typeof source !== 'string' || source.trim() === '') {
    // source가 비면 id가 'undefined:...'가 되어 서로 다른 피드의 기사끼리 충돌한다.
    // 한쪽 피드의 기사가 다른 쪽에서 "이미 본 것"으로 지워질 수 있다.
    throw new TypeError('parseRss에는 source(피드 이름)가 필요합니다');
  }
  if (typeof xml !== 'string') {
    throw new TypeError('parseRss의 xml은 문자열이어야 합니다');
  }
  const src = source.trim();

  // <item>...</item>으로 닫힌 것만 항목으로 센다. 열린 채 잘린 응답을 기사로 만들지 않는다.
  // 동시에 <channel>·<image>의 <title>/<link>를 기사로 오인하는 것도 이 경계가 막는다.
  const blocks = xml.match(/<item(?:\s[^>]*)?>[\s\S]*?<\/item\s*>/gi) || [];

  return blocks.map((block) => {
    const title = tagText(block, 'title');
    const link = tagText(block, 'link');
    const guid = tagText(block, 'guid');
    // pubDate는 RFC-822라 오프셋이 문자열에 들어 있다. 오프셋이 없는 변종만 KST로 본다.
    const at = toEpochMsKst(tagText(block, 'pubDate'));

    // guid를 우선한다. link에는 utm_* 추적 파라미터가 붙어 재발행 시 달라질 수 있고,
    // 그러면 같은 기사가 새 기사로 되살아난다.
    const key = guid || link || `h_${shortHash(src, title || '', String(at))}`;

    return {
      id: `${src}:${key}`,
      source: src,
      at,
      title: title === null ? '' : title,
      category: tagText(block, 'category'),
      url: link,
      updatedAt: null,
    };
  });
}

// ---- 중복 제거 ----

// 폴링은 같은 공지를 계속 다시 받는다. 새 것만 골라내되, 입력 Set은 건드리지 않는다.
// 하위 처리가 중간에 실패했을 때 seenIds를 되돌릴 수 있어야 재시도가 가능하다.
function dedupeNewEvents(events, seenIds, { maxSeen = DEFAULT_MAX_SEEN } = {}) {
  if (!Array.isArray(events)) {
    throw new TypeError('dedupeNewEvents의 events는 배열이어야 합니다');
  }
  const seen = new Set(seenIds || []);
  const fresh = [];

  for (const e of events) {
    if (!e || typeof e.id !== 'string' || e.id === '') {
      // id 없는 항목을 그냥 흘려보내면 매 폴링마다 같은 재료가 새 것으로 되살아난다.
      throw new TypeError(`이벤트에 id가 없습니다: ${JSON.stringify(e)}`);
    }
    if (seen.has(e.id)) continue;
    seen.add(e.id);
    fresh.push(e);
  }

  // Set은 삽입 순서를 지키므로 앞쪽(오래된 id)부터 버린다.
  if (Number.isFinite(maxSeen) && maxSeen > 0 && seen.size > maxSeen) {
    const keep = [...seen].slice(seen.size - maxSeen);
    return { fresh, seenIds: new Set(keep) };
  }
  return { fresh, seenIds: seen };
}

// 시각을 못 읽은 이벤트를 신선도 판정에 넣으면 안 된다. null을 숫자와 비교하면
// 0으로 취급되어 조용히 "아주 오래된 것"이 되므로, 판정 전에 명시적으로 걸러야 한다.
function hasUsableTime(event) {
  return !!event && typeof event.at === 'number' && Number.isFinite(event.at);
}

// ---- 네트워크 래퍼 ----

function assertLimit(limit) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new RangeError(`limit은 1~100 사이 정수여야 합니다: ${limit}`);
  }
  return limit;
}

function buildUpbitNoticesUrl({ limit = 30, baseUrl = UPBIT_BASE } = {}) {
  assertLimit(limit);
  return `${baseUrl.replace(/\/+$/, '')}/api/v1/announcements?os=web&page=1&per_page=${limit}&category=all`;
}

function buildBithumbNoticesUrl({ limit = 30, baseUrl = BITHUMB_BASE } = {}) {
  assertLimit(limit);
  return `${baseUrl.replace(/\/+$/, '')}/v1/notices?count=${limit}`;
}

// HTTP 오류를 빈 배열로 삼키지 않는다. 소스가 죽은 것과 재료가 없는 것은 다르며,
// 전자를 후자로 위장하면 감시가 멈춘 줄 모르고 계속 돌게 된다.
async function fetchOk(url, fetchImpl, label) {
  const res = await (fetchImpl || fetch)(url);
  if (!res || !res.ok) {
    throw new Error(`${label} 응답 오류: HTTP ${res ? res.status : '응답 없음'}`);
  }
  return res;
}

async function fetchUpbitNotices({ limit = 30, baseUrl = UPBIT_BASE, fetchImpl } = {}) {
  const res = await fetchOk(buildUpbitNoticesUrl({ limit, baseUrl }), fetchImpl, '업비트 공지');
  return parseUpbitNotices(await res.json());
}

async function fetchBithumbNotices({ limit = 30, baseUrl = BITHUMB_BASE, fetchImpl } = {}) {
  const res = await fetchOk(buildBithumbNoticesUrl({ limit, baseUrl }), fetchImpl, '빗썸 공지');
  return parseBithumbNotices(await res.json());
}

async function fetchRss({ url, source, fetchImpl } = {}) {
  if (typeof url !== 'string' || url.trim() === '') {
    throw new TypeError('fetchRss에는 url이 필요합니다');
  }
  const res = await fetchOk(url, fetchImpl, `RSS(${source})`);
  return parseRss(await res.text(), source);
}

module.exports = {
  EVENT_KEYS,
  KST_OFFSET,
  DEFAULT_MAX_SEEN,
  parseUpbitNotices,
  parseBithumbNotices,
  parseRss,
  buildUpbitNoticesUrl,
  buildBithumbNoticesUrl,
  fetchUpbitNotices,
  fetchBithumbNotices,
  fetchRss,
  dedupeNewEvents,
  hasUsableTime,
};
