'use strict';

// 재료 분별기 — 거래소 공지 제목 하나를 "매매 가능한 재료"로 환산한다. 순수 함수.
//
// **이 모듈이 전략의 심장이다.** 유목민식 단타에서 승부는 진입 타이밍이 아니라
// 재료의 급에서 갈린다. 원화 상장은 한국 개인 매수세가 직접 유입되어 수백~수천
// bps를 움직이지만, 같은 "신규 거래지원"이라도 USDT 마켓이면 국내 수급 영향이
// 훨씬 작다. 거래대회 공지는 사실상 0이다. 급을 구분하지 못하면 왕복 비용만
// 지불하는 매매가 대부분이 된다.
//
// 판정에서 실제로 돈을 잃게 만드는 실패는 두 가지다.
//
// 1) **티커 오탐.** USDT·BTC는 그 자체가 거래 가능한 심볼이면서 동시에 마켓
//    이름으로 제목에 등장한다("(USDT 마켓)", "BTC, USDT 마켓 신규 거래지원").
//    상장 심볼 대조만으로는 이걸 막지 못한다 — 둘 다 진짜 심볼이기 때문이다.
//    그래서 여기서는 괄호 안에서만, 마켓/네트워크 표기를 제외하고 뽑는다.
//
// 2) **이미 반영된 재료.** 거래소는 같은 사건에 대해 "(완료)", "기간 연장",
//    "시점 변경" 같은 후속 공지를 계속 낸다. 이걸 새 재료로 착각하면 급등이
//    끝난 자리에서 정확히 고점을 산다. stale 판정이 없으면 이 전략은
//    "뒤늦게 사는 기계"가 된다.
//
// 거래소마다 띄어쓰기가 다르다는 점도 실전에서 곧바로 문제가 된다. 업비트는
// "거래 유의 종목 지정", 빗썸은 "거래유의종목 지정"으로 쓴다. 그래서 키워드
// 대조는 공백을 모두 제거한 형태로만 한다.

// 티커 후보의 모양. 원문이 전부 대문자여야 한다 — "BNB Smart Chain"의 Smart·Chain
// 처럼 첫 글자만 대문자인 영어 단어를 심볼로 승격시키지 않기 위해서다.
// 첫 글자를 [A-Z]로 못박아 "08", "25" 같은 날짜 조각도 함께 배제한다.
const TICKER_SHAPE = /^[A-Z][A-Z0-9]{1,9}$/;

// 공백을 지운 형태로 비교한다. 거래소별 띄어쓰기 차이를 규칙마다 나열하는 대신
// 한 번에 없앤다.
const compact = (text) => text.replace(/\s+/g, '');

// 이미 지나간 일이거나 기존 공지의 후속임을 알리는 표지.
// '종료'를 통째로 넣지 않는 이유: "거래지원 종료"는 상장폐지 예고라 오히려
// 가장 신선한 악재다. 이벤트 종료만 따로 집는다.
const STALE_MARKERS = ['(완료)', '기간연장', '시점변경', '변경안내', '이벤트종료'];

const hasKrwMarket = (c) => c.includes('KRW') || c.includes('원화');
const isListing = (c) =>
  c.includes('신규거래지원') || c.includes('마켓추가') || c.includes('디지털자산추가') || c.includes('신규상장');

// 위에서부터 먼저 맞는 규칙이 이긴다. 악재를 호재보다 앞에 두는 이유는
// "거래지원 종료"가 "거래지원"을 포함하기 때문이다 — 순서가 곧 안전장치다.
const RULES = [
  {
    kind: '거래유의',
    direction: 'bearish',
    grade: 'S',
    // '유의사항'과 구분하려면 '지정'까지 함께 요구해야 한다. 상시 고정 공지인
    // "미신고 가상자산사업자와의 입출금 제한 및 유의사항"이 매일 S급 악재로
    // 뜨는 사고가 여기서 갈린다.
    match: (c) => c.includes('유의종목지정'),
    note: '상장폐지 전조. 즉각 급락하므로 보유 중이면 즉시 이탈 판단이 필요하다',
  },
  {
    kind: '상장폐지',
    direction: 'bearish',
    grade: 'S',
    match: (c) => c.includes('상장폐지'),
    note: '상장폐지 확정. 즉각 급락한다',
  },
  {
    kind: '거래지원종료',
    direction: 'bearish',
    grade: 'S',
    match: (c) => c.includes('거래지원종료'),
    note: '거래 지원 종료는 사실상 상장폐지다. 즉각 급락한다',
  },
  {
    kind: '입출금중단',
    direction: 'bearish',
    grade: 'B',
    // '제한'은 제외한다. 중단·중지는 일시적 작업 공지지만 제한은 제도 안내라
    // 종목 재료가 아니다.
    // c는 공백이 제거된 형태라 '.'로 충분하다.
    match: (c) => /입출금.{0,8}(중단|중지)/.test(c),
    note: '보통 네트워크 업그레이드라 중립에 가깝지만, 차익거래 경로가 막혀 약악재로 본다',
  },
  {
    kind: '원화상장',
    direction: 'bullish',
    grade: 'S',
    match: (c) => isListing(c) && hasKrwMarket(c),
    note: '원화 마켓 신규 상장. 한국 개인 매수세가 직접 유입되어 즉각 급등한다',
  },
  {
    kind: 'BTC/USDT상장',
    direction: 'bullish',
    grade: 'A',
    match: (c) => isListing(c),
    note: 'BTC/USDT 마켓 상장. 원화 상장보다 국내 수급 영향이 작다',
  },
  {
    kind: '에어드랍',
    direction: 'bullish',
    grade: 'B',
    match: (c) => c.includes('에어드랍') || c.includes('에어드롭'),
    note: '수량이 늘어나는 호재지만 즉발성은 낮다',
  },
  {
    kind: '스냅샷',
    direction: 'bullish',
    grade: 'B',
    match: (c) => c.includes('스냅샷'),
    note: '스냅샷 기준일 전까지 매수 유인이 생긴다',
  },
  {
    kind: '메인넷',
    direction: 'bullish',
    grade: 'B',
    match: (c) => c.includes('메인넷'),
    note: '메인넷 전환은 기대감을 만들지만 반영 속도가 느리다',
  },
  {
    kind: '파트너십',
    direction: 'bullish',
    grade: 'B',
    match: (c) => c.includes('파트너십') || c.includes('제휴'),
    note: '대형 파트너십은 기대감 재료다',
  },
  {
    kind: '이벤트',
    direction: 'bullish',
    grade: 'C',
    match: (c) => c.includes('이벤트') || c.includes('프로모션') || c.includes('거래대회'),
    note: '이벤트·프로모션은 가격 영향이 거의 없다',
  },
];

// stale이면 한 급씩 내린다. B·C는 애초에 즉발성이 약해서, 한 급 더 내려가면
// 남는 우위가 없다 — 매매 대상에서 뺀다.
const STALE_DOWNGRADE = { S: 'B', A: 'C', B: null, C: null };

function assertTitle(title) {
  if (typeof title !== 'string') {
    throw new TypeError(`title은 문자열이어야 합니다: ${JSON.stringify(title)}`);
  }
}

function toKnownSet(knownSymbols) {
  if (!Array.isArray(knownSymbols)) {
    throw new TypeError(
      'knownSymbols는 실제 거래 가능한 심볼 배열이어야 합니다 — 대조 없이는 마켓 이름과 날짜가 전부 티커로 잡힙니다'
    );
  }
  const set = new Set();
  for (const symbol of knownSymbols) {
    if (typeof symbol === 'string' && symbol.trim()) set.add(symbol.trim().toUpperCase());
  }
  return set;
}

// 제목의 괄호 안에서 티커를 뽑되, 실제 상장 심볼에 있는 것만 남긴다.
//
// 괄호 밖을 보지 않는 것은 의도한 선택이다. "8월 2주차 GAS 에어드랍 지급 안내"의
// GAS는 이 규칙으로 놓친다. 그러나 괄호 밖 대문자를 받으면 "총 상금 1 BTC",
// "BTC, USDT 마켓 신규 거래지원"이 전부 BTC 신호가 된다 — 놓치는 쪽이 싸다.
function extractTickers(title, knownSymbols) {
  assertTitle(title);
  const known = toKnownSet(knownSymbols);

  // "Ontology 네트워크 계열 ... 입출금 중단"은 체인 전체 공지다. 괄호 안의
  // 체인 이름(BNB Smart Chain)을 종목 재료로 승격시키면 28종 공지가 BNB 단독
  // 신호가 되어 버린다.
  if (/네트워크\s*계열/.test(title)) return [];

  const found = [];
  const seen = new Set();
  for (const match of title.matchAll(/\(([^()]*)\)/g)) {
    const group = match[1];
    // "(USDT 마켓)"의 USDT는 진짜 심볼이라 대조로는 못 거른다. 마켓 표기임을
    // 알리는 단어가 같은 괄호 안에 있으면 그 괄호는 통째로 버린다.
    if (group.includes('마켓')) continue;
    for (const token of group.split(/[^A-Za-z0-9]+/)) {
      if (!TICKER_SHAPE.test(token)) continue;
      if (!known.has(token)) continue;
      if (seen.has(token)) continue;
      seen.add(token);
      found.push(token);
    }
  }
  return found;
}

// category는 업비트가 문자열('거래'), 빗썸이 배열(['거래유의'])로 준다.
function categoryText(category) {
  if (Array.isArray(category)) return compact(category.filter((c) => typeof c === 'string').join(' '));
  if (typeof category === 'string') return compact(category);
  return '';
}

function classifyMaterial({ title, category, source, knownSymbols } = {}) {
  assertTitle(title);
  const c = compact(title);
  const cat = categoryText(category);
  const tickers = extractTickers(title, knownSymbols);

  const staleMarker = STALE_MARKERS.find((marker) => c.includes(marker)) ?? null;

  let rule = RULES.find((r) => r.match(c)) ?? null;

  // 제목에 키워드가 없어도 거래소가 분류해 준 카테고리가 남아 있다. 빗썸의
  // '거래유의', 업비트의 '이벤트'가 그렇다 — 제목 표현이 바뀌어도 이쪽은 버틴다.
  if (!rule && cat.includes('거래유의')) rule = RULES.find((r) => r.kind === '거래유의');
  if (!rule && cat.includes('이벤트')) rule = RULES.find((r) => r.kind === '이벤트');

  const where = source ? `${source} 공지` : '공지';

  if (!rule) {
    return {
      grade: null,
      direction: 'neutral',
      kind: '기타',
      tickers,
      stale: staleMarker !== null,
      reason: `${where}: 가격을 움직이는 재료로 볼 근거가 없습니다 — 매매 대상이 아닙니다.`,
    };
  }

  const baseGrade = rule.grade;
  const grade = staleMarker ? STALE_DOWNGRADE[baseGrade] : baseGrade;

  const parts = [`${where}: ${rule.kind} — ${rule.note}.`];
  if (tickers.length) parts.push(`대상 ${tickers.join(', ')}.`);
  if (staleMarker) {
    parts.push(
      grade === null
        ? `"${staleMarker}"가 붙은 이미 반영된 후속 공지라 ${baseGrade}급에서 매매 대상 제외로 내립니다.`
        : `"${staleMarker}"가 붙은 이미 반영된 후속 공지라 ${baseGrade}급에서 ${grade}급으로 내립니다.`
    );
  } else {
    parts.push(`${baseGrade}급으로 판정합니다.`);
  }

  return {
    grade,
    // 등급이 내려가도 재료의 방향 자체는 바뀌지 않는다. 매매하지 않더라도
    // 어느 쪽 재료였는지는 사후 검토에 남겨 둔다.
    direction: rule.direction,
    kind: rule.kind,
    tickers,
    stale: staleMarker !== null,
    reason: parts.join(' '),
  };
}

module.exports = { extractTickers, classifyMaterial, STALE_MARKERS };
