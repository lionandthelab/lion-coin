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

// 위에서부터 먼저 맞는 규칙이 이긴다. 순서가 곧 안전장치다. 두 종류의 포함
// 관계를 순서로 푼다.
//
// 1) 좁은 악재가 넓은 악재를 포함한다: "거래지원 종료" ⊃ "거래지원".
// 2) **해제 공지가 지정 공지를 포함한다**: "유의 종목 지정 해제" ⊃ "유의 종목 지정",
//    "입출금 일시 중단 해제" ⊃ "입출금 일시 중단". 지정 공지가 난 종목에는 반드시
//    해제 아니면 폐지가 뒤따르므로 이 계열은 드물지 않다. 방향이 정반대라
//    놓치면 안도 랠리 국면에서 급락 신호를 내보낸다.
//
// 그리고 세 번째로, **호재 사유가 붙은 입출금 중단**이 있다. 거래소는 에어드랍·
// 스냅샷·메인넷 스왑·하드포크를 거의 항상 입출금 중단 공지에 얹어서 낸다.
// 같은 제목에 두 재료가 있으면 호재 쪽이 재료의 본질이다 — 입출금 중단은
// 그 호재를 처리하기 위한 절차일 뿐이다. 그래서 호재 규칙을 입출금 중단보다
// 위에 둔다.
const RULES = [
  {
    kind: '거래유의해제',
    direction: 'bullish',
    grade: 'A',
    // '유의종목지정'을 포함하므로 반드시 지정 규칙보다 위에 있어야 한다.
    match: (c) => /유의종목지정.{0,4}해제/.test(c),
    note: '유의 종목 지정이 풀렸다. 상장폐지 위험이 걷혀 안도 랠리가 나오지만 신규 상장만큼 크지는 않다',
  },
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
    // 하드포크도 같은 계열이다 — 체인 업그레이드 기대감이고, 거래소는 둘 다
    // 입출금 중단 공지에 얹어서 낸다.
    match: (c) => c.includes('메인넷') || c.includes('하드포크'),
    note: '메인넷 전환·하드포크는 기대감을 만들지만 반영 속도가 느리다',
  },
  {
    kind: '입출금재개',
    direction: 'bullish',
    grade: 'C',
    // '입출금중단'을 포함하므로 반드시 중단 규칙보다 위에 있어야 한다.
    // 막혔던 차익거래 경로가 열리는 것이라 방향은 호재지만 폭은 매우 작다.
    match: (c) => /입출금.{0,12}(해제|재개)/.test(c),
    note: '막혔던 입출금이 다시 열린다. 방향은 호재지만 가격 영향은 거의 없다',
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

// 카테고리만 보고 만드는 최후 수단 규칙. RULES에 넣지 않는다 — 제목 대조로는
// 절대 맞지 않아야 하기 때문이다. 방향을 모르는 채로 매매에 태울 수는 없으므로
// direction은 neutral이고(호출자가 neutral을 매매에서 제외한다), 등급도 확신
// 없는 만큼 낮춰 사람이 눈으로 확인할 수 있게만 남긴다.
const CAUTION_CATEGORY_RULE = {
  kind: '거래유의계열',
  direction: 'neutral',
  grade: 'B',
  note: '거래소가 유의 계열로 분류했지만 제목에서 지정·해제·폐지 중 무엇인지 읽지 못했습니다. 방향을 단정하지 않습니다',
};

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

// 마켓 이름으로 제목에 등장하는 심볼들. 이 이름들은 그 자체로 거래 가능한
// 심볼이기도 해서 이름 대조로는 구분할 수 없다 — 위치로만 판단할 수 있다.
const MARKET_NAMES = new Set(['KRW', 'BTC', 'ETH', 'USDT', 'USDC', 'BNB']);

// 제목의 괄호 안에서 티커 후보를 뽑는다. 상장 심볼 대조는 하지 않는다 —
// 신규 상장 심볼은 정의상 상장 목록에 없기 때문이다(extractTickers 주석 참고).
//
// 괄호 밖을 보지 않는 것은 의도한 선택이다. "8월 2주차 GAS 에어드랍 지급 안내"의
// GAS는 이 규칙으로 놓친다. 그러나 괄호 밖 대문자를 받으면 "총 상금 1 BTC",
// "BTC, USDT 마켓 신규 거래지원"이 전부 BTC 신호가 된다 — 놓치는 쪽이 싸다.
function extractCandidateTickers(title) {
  assertTitle(title);

  // "Ontology 네트워크 계열 ... 입출금 중단"은 체인 전체 공지다. 괄호 안의
  // 체인 이름(BNB Smart Chain)을 종목 재료로 승격시키면 28종 공지가 BNB 단독
  // 신호가 되어 버린다.
  if (/네트워크\s*계열/.test(title)) return [];

  const found = [];
  const seen = new Set();
  for (const match of title.matchAll(/\(([^()]*)\)/g)) {
    const group = match[1];
    const tokens = [...group.matchAll(/[A-Za-z0-9]+/g)].map((t) => ({ text: t[0], at: t.index }));

    // "(SOPH, KRW 마켓)"처럼 티커와 마켓명이 한 괄호에 섞여 들어온다. 예전에는
    // '마켓'이 보이면 괄호를 통째로 버려서 SOPH까지 잃었다. 마켓명은 언제나
    // '마켓' **바로 앞**에 붙으므로, 그 위치에서 뒤로 거슬러 올라가며 마켓
    // 이름인 토큰만 걷어낸다. "(KRW, USDT 마켓)"은 둘 다 걷히고,
    // "(SOPH, KRW 마켓)"은 KRW에서 멈춰 SOPH가 살아남는다.
    const dropped = new Set();
    for (const marketWord of group.matchAll(/마켓/g)) {
      let i = tokens.length - 1;
      while (i >= 0 && tokens[i].at >= marketWord.index) i -= 1;
      while (i >= 0 && MARKET_NAMES.has(tokens[i].text.toUpperCase())) {
        dropped.add(i);
        i -= 1;
      }
    }

    tokens.forEach((token, i) => {
      if (dropped.has(i)) return;
      if (!TICKER_SHAPE.test(token.text)) return;
      if (seen.has(token.text)) return;
      seen.add(token.text);
      found.push(token.text);
    });
  }
  return found;
}

// 후보 중 실제 상장 심볼에 있는 것만 남긴다 — 지금 이 거래소에서 살 수 있는 것.
function extractTickers(title, knownSymbols) {
  const known = toKnownSet(knownSymbols);
  return extractCandidateTickers(title).filter((t) => known.has(t));
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
  const known = toKnownSet(knownSymbols);
  // 두 필드의 의미가 다르다.
  //   candidateTickers — 제목에서 추출한 전체. 검증하지 않았다. "이 재료가 어느
  //     종목 이야기인가"에 답한다. 신규 상장처럼 아직 이 거래소에 없는 심볼도 남는다.
  //   tickers — 그중 상장 목록 대조를 통과한 것. "지금 살 수 있는가"에 답한다.
  // 호출자는 이 차이로 두 상황을 구분한다: 업비트 상장 공지인데 그 코인이 빗썸에
  // 이미 있으면 매매 가능(주된 플레이), 빗썸 자체 신규 상장이면 아직 못 사지만
  // 재료로 기록은 남긴다. tickers만 보고 버리면 명세가 최우선으로 꼽은 재료를 잃는다.
  const candidateTickers = extractCandidateTickers(title);
  const tickers = candidateTickers.filter((t) => known.has(t));

  const staleMarker = STALE_MARKERS.find((marker) => c.includes(marker)) ?? null;

  let rule = RULES.find((r) => r.match(c)) ?? null;

  // 제목에 키워드가 없어도 거래소가 분류해 준 카테고리가 남아 있다. 빗썸의
  // '거래유의', 업비트의 '이벤트'가 그렇다 — 제목 표현이 바뀌어도 이쪽은 버틴다.
  //
  // 다만 카테고리는 **방향을 말해 주지 않는다**. 빗썸은 지정도 해제도 폐지도
  // 전부 '거래유의' 카테고리에 넣는다. 여기서 bearish로 못박으면 해제 공지가
  // 카테고리만으로 S급 악재로 고정된다 — 정확히 반대 방향이다. 그래서 이
  // 폴백은 제목 규칙이 아무것도 못 맞췄을 때만 쓰이고, 방향은 비워 둔다.
  if (!rule && cat.includes('거래유의')) rule = CAUTION_CATEGORY_RULE;
  if (!rule && cat.includes('이벤트')) rule = RULES.find((r) => r.kind === '이벤트');

  const where = source ? `${source} 공지` : '공지';

  if (!rule) {
    return {
      grade: null,
      direction: 'neutral',
      kind: '기타',
      tickers,
      candidateTickers,
      stale: staleMarker !== null,
      reason: `${where}: 가격을 움직이는 재료로 볼 근거가 없습니다 — 매매 대상이 아닙니다.`,
    };
  }

  const baseGrade = rule.grade;
  const grade = staleMarker ? STALE_DOWNGRADE[baseGrade] : baseGrade;

  const parts = [`${where}: ${rule.kind} — ${rule.note}.`];
  if (tickers.length) {
    parts.push(`대상 ${tickers.join(', ')}.`);
  } else if (candidateTickers.length) {
    // 재료의 대상은 알지만 상장 목록에 없다. 신규 상장이면 이게 정상이다 —
    // "티커를 못 찾았다"와 구분해서 남겨야 사후에 판단이 선다.
    parts.push(`대상 ${candidateTickers.join(', ')} — 상장 목록에 없어 즉시 매수는 불가합니다.`);
  }
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
    candidateTickers,
    stale: staleMarker !== null,
    reason: parts.join(' '),
  };
}

module.exports = { extractTickers, extractCandidateTickers, classifyMaterial, STALE_MARKERS };
