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
//      함께 싣는다. 태그 이름을 느슨하게 매칭하면 뒤엣것을 집는다. 두 값은 같은
//      순간을 가리키지만, 느슨한 매칭은 닫는 태그까지 어긋나 시각을 통째로 잃는다.

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

// RFC-822/1123은 숫자 오프셋 대신 GMT·UTC 같은 문자 표기도 허용한다. 이것을
// "오프셋 없음"으로 보면 KST 분기의 날짜 형식과도 맞지 않아 null이 되고, 그런 피드는
// 전 항목이 at: null이 되어 신선도 필터에서 통째로 버려진다 — 소스 하나가 조용히 죽는다.
// Date.parse가 이 표기를 정확히 읽으므로 그대로 넘긴다.
// 목록은 좁게 유지한다. KST처럼 Date.parse가 모르는 표기를 임의로 +09:00이라고
// 단정하면, 이 모듈이 가장 피하려는 "9시간 어긋난 시각"을 스스로 만들어낸다.
//
// **CST·CDT는 제외한다 — 뜻이 둘이다.** 미 중부(-0600)이자 중국 표준시(+0800)이고,
// V8은 -0600으로 읽는다. 중화권 피드가 CST를 쓰면 시각이 14시간 늦게 찍히는데,
// 그 방향이 하필 "오래된 공지가 방금 뜬 것처럼 보이는" 쪽이다. 신선도 필터를
// 그대로 통과해 이미 시장에 퍼진 재료로 진입하게 된다.
// E/M/P는 뜻이 하나뿐이라 남긴다 — 전부 빼면 그 피드가 통째로 사라진다.
const NAMED_UTC_ZONE = /\s(?:UT|GMT|UTC|[EMP][SD]T)$/i;

// 오프셋이 없는 "YYYY-MM-DD HH:mm:ss" 형태에만 KST를 붙인다.
// 이미 오프셋(Z, +09:00, GMT)이 있으면 그 값을 존중한다 — 임의로 덧씌우면 실제로 UTC로
// 주는 날 9시간이 어긋난다.
function toEpochMsKst(value) {
  if (typeof value !== 'string') return null;
  const s = value.trim();
  if (s === '') return null;
  if (/[zZ]$|[+-]\d{2}:?\d{2}$/.test(s) || NAMED_UTC_ZONE.test(s)) return toEpochMs(s);
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

// 공지 번호가 실제로 쓸 수 있는 값일 때만 참이다.
// `upbit:${undefined}`는 'upbit:undefined'라는 멀쩡한 문자열이라 dedupeNewEvents의
// "비어 있지 않은 id" 검사를 통과한다. 그래서 번호 없는 공지가 여러 건 오면 전부
// 같은 id가 되고, 파서에서는 지켜지던 "출력 개수 = 입력 개수"가 중복 제거 단계에서
// 무너져 서로 다른 공지가 조용히 한 건으로 합쳐진다.
function upbitNoticeNo(id) {
  if (typeof id === 'number') return Number.isFinite(id) ? String(id) : null;
  if (typeof id === 'string' && id.trim() !== '') return id.trim();
  return null;
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
    // 번호가 없으면 항목을 버리는 대신, 폴링 간 재현되는 내용 해시로 물러선다.
    // 빗썸 쪽과 같은 전략이다 — id가 호출마다 달라지면 중복 제거가 통째로 무력해진다.
    const no = upbitNoticeNo(n.id);
    return {
      id: no !== null
        ? `upbit:${no}`
        : `upbit:h_${shortHash(typeof n.title === 'string' ? n.title : '', String(n.first_listed_at ?? ''), String(n.listed_at ?? ''))}`,
      source: 'upbit',
      at: first !== null ? first : listed,
      title: typeof n.title === 'string' ? n.title : '',
      category: normalizeCategory(n.category),
      url: no !== null ? upbitNoticeUrl(no) : null,
      updatedAt: listed,
    };
  });
}

// ---- 빗썸 ----

// pc_url 경로 끝의 공지 번호를 뽑는다. 쿼리(?utm_source=...)와 프래그먼트(#top)는
// 같은 공지를 가리키는 장식일 뿐인데, 이것이 붙었다고 번호 추출이 실패하면 해시 id로
// 떨어져 이미 본 공지가 새 재료로 되살아난다.
function bithumbNoticeNo(pcUrl) {
  if (typeof pcUrl !== 'string') return null;
  const m = pcUrl.split(/[?#]/, 1)[0].match(/\/(\d+)\/?$/);
  return m ? m[1] : null;
}

// 공지 번호도 제목도 발행 시각도 없는 항목의 마지막 수단.
// shortHash('', '')는 항상 같은 값이라, 단서가 없는 항목이 여러 건 오면 전부 한 id로
// 뭉쳐 중복 제거에서 한 건만 남고 나머지가 사라진다. 남은 단서는 항목 내용 전체뿐이므로
// 키를 정렬해 안정적으로 해시한다 — 같은 내용은 매 폴링 같은 id여야 한다.
function bithumbRowHash(row) {
  const keys = Object.keys(row).sort();
  return shortHash(...keys.map((k) => `${k}=${JSON.stringify(row[k])}`));
}

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
    // 고유 키이므로 그것을 먼저 쓰고, 없을 때 제목+발행시각 → 항목 전체 순으로 물러선다.
    // 해시를 쓰는 이유는 id가 호출마다 달라지면(예: 배열 인덱스나 난수) 중복 제거가
    // 통째로 무력해져 같은 공지로 매 폴링마다 다시 진입하기 때문이다.
    const no = bithumbNoticeNo(n.pc_url);
    let id;
    if (no !== null) {
      id = `bithumb:${no}`;
    } else if (n.title || n.published_at) {
      id = `bithumb:h_${shortHash(n.title || '', n.published_at || '')}`;
    } else {
      id = `bithumb:h_${bithumbRowHash(n)}`;
    }
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

// 숫자 문자참조를 문자로 바꾸되, 바꿀 수 없으면 원문을 그대로 둔다.
// String.fromCodePoint는 범위를 벗어난 값에 RangeError를 던진다. 그 예외가 파서 밖으로
// 올라가면 제목 하나가 깨졌다는 이유로 그 폴링에서 받은 기사 전체가 사라진다 —
// 이 모듈이 내세운 "항목을 버리지 않는다"의 정반대이고, 감시가 조용히 멈추는 경로다.
// 홀로 남은 서로게이트(D800~DFFF)도 던지지는 않지만 깨진 UTF-16을 만들므로 제외한다.
function decodeCodePoint(raw, cp) {
  if (!Number.isInteger(cp) || cp <= 0 || cp > 0x10ffff) return raw;
  if (cp >= 0xd800 && cp <= 0xdfff) return raw;
  return String.fromCodePoint(cp);
}

function decodeEntities(s) {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (m, hex) => decodeCodePoint(m, parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (m, dec) => decodeCodePoint(m, Number(dec)))
    // 한 번만 푼다. &amp;amp; 같은 이중 인코딩을 끝까지 벗기면 원문에 실제로 들어 있던
    // "&amp;"까지 바꿔버려, 제목이 원문과 달라진다.
    .replace(/&(amp|lt|gt|quot|apos|nbsp);/gi, (_, name) => ENTITIES[name.toLowerCase()]);
}

function unwrapCdata(s) {
  const m = s.match(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/);
  return m ? m[1] : s;
}

// 태그 이름 뒤에 반드시 공백이나 '>'가 오도록 강제한다. 이 경계가 없으면
// <pubDate>를 찾는 정규식이 <pubDate2>를 여는 태그로 집는다. 닫는 태그는
// </pubDate2>에 맞지 않아 다음 </pubDate>까지 끌려가고, 결국 태그가 뒤섞인
// 쓰레기 문자열을 파싱해 at: null이 된다 — 시각이 어긋나는 게 아니라 통째로 사라진다.
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
  const added = [];
  // 이번 폴링에서 본 id 전체(이미 알던 것 포함). 상한의 하한을 정하는 데 쓴다.
  const batch = new Set();

  for (const e of events) {
    if (!e || typeof e.id !== 'string' || e.id === '') {
      // id 없는 항목을 그냥 흘려보내면 매 폴링마다 같은 재료가 새 것으로 되살아난다.
      throw new TypeError(`이벤트에 id가 없습니다: ${JSON.stringify(e)}`);
    }
    batch.add(e.id);
    if (seen.has(e.id)) continue;
    seen.add(e.id);
    fresh.push(e);
    added.push(e.id);
  }

  // 절삭은 "가장 오래 전에 본 id"부터 버려야 한다. 그런데 거래소·RSS는 모두 최신순으로
  // 주므로 배치 안의 삽입 순서는 최신 → 오래된 것이다. 그대로 뒤에서 잘라내면 정확히
  // 최신 공지가 먼저 지워지고, 바로 다음 폴링에서 새 재료로 되살아나 이미 반영된
  // 자리에서 진입하게 만든다. 그래서 이번 배치분은 순서를 뒤집어 넣는다 —
  // 그래야 Set 전체의 삽입 순서가 오래된 것 → 최신 순이 되어 뒤쪽이 최신이 된다.
  if (added.length > 1) {
    for (const id of added) seen.delete(id);
    for (let i = added.length - 1; i >= 0; i -= 1) seen.add(added[i]);
  }

  // 상한은 폴링이 쌓이며 Set이 무한히 커지는 것을 막기 위한 것이지, 이번에 본 것을
  // 잊기 위한 것이 아니다. 한 배치보다 작은 상한을 그대로 적용하면 방금 본 공지를
  // 즉시 잊어 중복 제거가 구조적으로 무력해진다. 이번 배치는 최소한 전부 기억한다.
  //
  // 하한은 added.length가 아니라 **배치 전체**여야 한다. added는 이번에 새로 추가된
  // 것만 세므로, 하한이 항목이 추가된 폴링에서만 걸린다. 바로 다음 폴링은 새 항목이
  // 없어 added=0이 되고 상한이 원래 값으로 되돌아가, 방금 기억하기로 한 것을 즉시
  // 잊는다 — 그리고 그 다음 폴링에서 잊은 것이 새 재료로 되살아난다.
  // (maxSeen 10에 30건 배치를 5회 폴링하면 30·0·20·10·20으로 재발화했다.)
  const cap = Number.isFinite(maxSeen) && maxSeen > 0 ? Math.max(maxSeen, batch.size) : null;
  if (cap !== null && seen.size > cap) {
    return { fresh, seenIds: new Set([...seen].slice(seen.size - cap)) };
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


// 나이로 거른다 — 중복 제거만으로는 막을 수 없는 실패가 있다.
//
// 폴링 첫 회에는 seenIds가 비어 있어 응답 전체가 "처음 보는 것"이 된다. 실제로
// 감시 모드를 처음 켰을 때 27일 전 공지까지 신규 재료로 잡혔다(2026-08-21).
// 유목민식 매매의 전제는 "아직 시장에 퍼지지 않은 재료"인데, 나이 제한이 없으면
// 이미 다 반영된 옛 뉴스를 재료로 믿고 정확히 고점을 사게 된다.
//
// 걸러낸 것도 함께 돌려준다. 화면에는 보여야 무엇이 지나갔는지 사람이 판단할 수 있다.
function filterFreshEvents(events, { maxAgeMs, now = Date.now() } = {}) {
  if (!Array.isArray(events)) {
    throw new TypeError('filterFreshEvents의 events는 배열이어야 합니다');
  }
  if (typeof maxAgeMs !== 'number' || !Number.isFinite(maxAgeMs) || maxAgeMs <= 0) {
    throw new RangeError(`maxAgeMs는 양의 유한수여야 합니다: ${maxAgeMs}`);
  }

  const fresh = [];
  const stale = [];
  for (const ev of events) {
    const at = ev && typeof ev.at === 'number' && Number.isFinite(ev.at) ? ev.at : null;
    // 시각을 모르는 항목은 신선한 쪽에 넣지 않는다. 언제 나온 재료인지 모른 채
    // 진입하면 나이 제한을 둔 의미가 없어진다.
    if (at == null) { stale.push(ev); continue; }
    // 미래 시각은 신선한 것으로 본다 — 거래소 서버와 시계가 몇 초 어긋날 수 있고,
    // 그걸 버리면 방금 나온 공지를 놓친다.
    if (now - at <= maxAgeMs) fresh.push(ev);
    else stale.push(ev);
  }
  return { fresh, stale };
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
  filterFreshEvents,
  hasUsableTime,
};
