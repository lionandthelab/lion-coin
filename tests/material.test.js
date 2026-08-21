const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { extractTickers, classifyMaterial, STALE_MARKERS } = require('../src/material');

// 재료 분별이 이 전략의 전부다. 같은 뉴스라도 급이 다르면 대응이 완전히 달라지고,
// 이미 반영된 후속 공지를 새 재료로 착각하면 그대로 고점을 산다.
//
// **지어낸 제목으로만 테스트하면 실전에서 깨진다.** 실제 거래소가 내보낸 제목은
// 띄어쓰기가 제각각이고(`거래 유의 종목 지정` vs `거래유의종목 지정`), 괄호에는
// 티커·날짜·마켓 이름·한글 문장이 뒤섞여 들어온다. 그래서 아래 테스트는
// tests/fixtures/ 의 실제 페이로드에서 제목을 꺼내 쓴다.

const FIXTURES = path.join(__dirname, 'fixtures');
const upbit = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'upbit-notices.json'), 'utf8'));
const bithumb = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'bithumb-notices.json'), 'utf8'));

const upbitNotices = [...upbit.data.notices, ...upbit.data.fixed_notices];

// 픽스처가 바뀌어 제목이 사라지면 조용히 통과하지 않고 크게 깨지도록 한다.
function up(fragment) {
  const hit = upbitNotices.find((n) => n.title.includes(fragment));
  if (!hit) throw new Error(`업비트 픽스처에 "${fragment}" 를 담은 공지가 없습니다`);
  return hit;
}
function bt(fragment) {
  const hit = bithumb.find((n) => n.title.includes(fragment));
  if (!hit) throw new Error(`빗썸 픽스처에 "${fragment}" 를 담은 공지가 없습니다`);
  return hit;
}

// 실제 거래 가능한 심볼 목록을 흉내낸 것. BTC·USDT를 일부러 넣어 둔다 —
// 이 둘은 마켓 이름으로도 제목에 등장하므로, 단순 대조만으로는 오탐을 막지
// 못한다는 사실을 테스트가 직접 증명해야 한다.
const KNOWN = [
  'BTC', 'ETH', 'USDT', 'XRP', 'BNB',
  'NEXO', 'MEGA', 'ASTR', 'MANTRA', 'ZIL', 'CRV', 'MED', 'GRVT', 'ALLO',
  'POKT', 'MON', 'ELF', 'LWP', 'STORJ', 'JASMY', 'TT', 'SAFE', 'BIO', 'GAS',
  'BICO', 'BMT', 'NIL', 'GWEI', 'BB', 'GALA', 'SUNDOG',
];

// classifyMaterial 호출을 짧게 쓰기 위한 래퍼.
const cls = (notice, extra = {}) =>
  classifyMaterial({
    title: notice.title,
    category: notice.category ?? notice.categories,
    source: extra.source ?? 'upbit',
    knownSymbols: extra.knownSymbols ?? KNOWN,
  });

// ---- extractTickers: 실제 상장 심볼과의 대조 ----

test('extractTickers: 마켓 이름으로 쓰인 USDT를 티커로 잡지 않는다', () => {
  // 실제 제목. USDT는 KNOWN에 들어 있으므로 심볼 대조만으로는 걸러지지 않는다.
  const { title } = up('넥소(NEXO) 신규 거래지원');
  assert.deepEqual(extractTickers(title, KNOWN), ['NEXO']);
});

test('extractTickers: 티커와 마켓명이 같은 괄호에 있어도 티커는 살린다', () => {
  // 픽스처가 마침 분리형("(USDT 마켓)", "(BICO, BMT, NIL, GWEI)")이라 "괄호에
  // '마켓'이 있으면 통째로 버린다"는 방어가 통과해 왔다. 거래소는 합쳐서도 쓴다.
  assert.deepEqual(extractTickers('신규 거래지원 안내 (SOPH, KRW 마켓)', ['SOPH', 'KRW']), ['SOPH']);
});

test('extractTickers: 마켓명이 여러 개 나열돼도 마켓 직전 것들만 제외한다', () => {
  // "마켓" 직전에 붙은 KRW·USDT는 마켓 이름이다. 둘 다 진짜 심볼이기도 하므로
  // 이름 대조로는 못 거른다 — 위치로 판단해야 한다.
  assert.deepEqual(extractTickers('(KRW, USDT 마켓) 신규 거래지원', ['KRW', 'USDT']), []);
  assert.deepEqual(
    extractTickers('신규 거래지원 안내 (SOPH, KRW, USDT 마켓)', ['SOPH', 'KRW', 'USDT']),
    ['SOPH']
  );
});

test('extractTickers: 마켓명과 같은 심볼이라도 마켓 표기 위치가 아니면 살린다', () => {
  // 괄호 안 BTC가 마켓 앞이 아니라 뒤에 있으면 그건 종목 쪽이다.
  assert.deepEqual(extractTickers('(BTC) 관련 안내', ['BTC']), ['BTC']);
});

test('extractTickers: 괄호 안 복수 티커를 모두 뽑고 중복은 제거한다', () => {
  // "BTC, USDT 마켓 신규 거래지원 안내 (BICO, BMT, NIL, GWEI) (BICO, ... 변경 안내)"
  // 앞머리의 BTC/USDT는 마켓 이름이고, 같은 티커가 두 괄호에 반복 등장한다.
  const { title } = up('BTC, USDT 마켓 신규 거래지원');
  assert.deepEqual(extractTickers(title, KNOWN), ['BICO', 'BMT', 'NIL', 'GWEI']);
});

test('extractTickers: 한 제목에 흩어진 여러 괄호에서 티커 4개를 뽑는다', () => {
  const { title } = bt('거래유의종목 지정');
  assert.deepEqual(extractTickers(title, KNOWN), ['MANTRA', 'BB', 'GALA', 'SUNDOG']);
});

test('extractTickers: knownSymbols에 없는 티커는 버린다', () => {
  const { title } = up('커브(CRV)');
  assert.deepEqual(extractTickers(title, KNOWN), ['CRV']);
  // 같은 제목이라도 상장 목록에 CRV가 없으면 매매 대상이 아니다.
  assert.deepEqual(extractTickers(title, ['BTC', 'ETH']), []);
});

test('extractTickers: 괄호 안 날짜·시각은 티커가 아니다', () => {
  const { title } = up('메가이더(MEGA) 입출금');
  assert.deepEqual(extractTickers(title, KNOWN), ['MEGA']);
});

test('extractTickers: (완료) 같은 한글 괄호는 무시한다', () => {
  const { title } = up('아스타(ASTR)');
  assert.deepEqual(extractTickers(title, KNOWN), ['ASTR']);
});

test('extractTickers: 괄호 밖 대문자 토큰은 티커로 보지 않는다', () => {
  // "엑스알피(리플)(XRP) 거래하고, 총 상금 1 BTC 받아가세요!" — BTC는 상금 단위지
  // 재료의 대상이 아니다. 괄호 밖을 받으면 이런 제목이 전부 BTC 신호가 된다.
  const { title } = up('총 상금 1 BTC');
  assert.deepEqual(extractTickers(title, KNOWN), ['XRP']);
});

test('extractTickers: 괄호 밖 대문자를 안 받는 대가로 에어드랍 제목은 놓친다', () => {
  // "8월 2주차 GAS 에어드랍 지급 안내" — GAS가 괄호 밖에 있어 잡히지 않는다.
  // 의도한 손실이다. 괄호 밖 대문자를 받으면 위의 BTC/USDT 오탐이 되살아난다.
  const { title } = up('GAS 에어드랍');
  assert.deepEqual(extractTickers(title, KNOWN), []);
});

test('extractTickers: 네트워크 계열 공지는 특정 티커의 재료가 아니다', () => {
  // "비앤비 스마트 체인(BNB Smart Chain) 네트워크 계열 가상자산 28종 ..." —
  // 괄호 안 BNB는 체인 이름이다. 28종 전체 공지를 BNB 단독 신호로 오해하면 안 된다.
  const { title } = bt('BNB Smart Chain');
  assert.deepEqual(extractTickers(title, KNOWN), []);
});

test('extractTickers: 두 글자 티커도 잡는다', () => {
  const { title } = up('썬더코어(TT)');
  assert.deepEqual(extractTickers(title, KNOWN), ['TT']);
});

test('extractTickers: knownSymbols 대소문자가 달라도 대조된다', () => {
  const { title } = up('커브(CRV)');
  assert.deepEqual(extractTickers(title, ['crv']), ['CRV']);
});

test('extractTickers: knownSymbols가 배열이 아니면 TypeError', () => {
  // 대조 없이 통과시키면 위의 오탐이 전부 살아난다 — 조용히 넘기지 않는다.
  assert.throws(() => extractTickers('커브(CRV) KRW 마켓 디지털 자산 추가'), TypeError);
  assert.throws(() => extractTickers('커브(CRV)', null), TypeError);
});

test('extractTickers: title이 문자열이 아니면 TypeError', () => {
  assert.throws(() => extractTickers(null, KNOWN), TypeError);
  assert.throws(() => extractTickers(123, KNOWN), TypeError);
});

// ---- classifyMaterial: 호재 등급 ----

test('classifyMaterial: 원화(KRW) 마켓 신규 상장은 S급 호재다', () => {
  // 이 케이스가 성립하는 전제를 테스트 안에 못박는다. 예전에는 KNOWN이 픽스처
  // 괄호 문자열을 그대로 옮긴 목록이라 CRV가 "우연히" 들어 있었고, 그래서
  // tickers가 채워지는 것이 당연해 보였다. 실제로는 "다른 거래소에 이미
  // 상장되어 있어서 지금 살 수 있다"는 조건이 붙어야만 성립한다.
  const { title } = up('커브(CRV)');
  const known = ['BTC', 'ETH', 'CRV']; // CRV는 빗썸에 이미 있다 = 매수 가능
  const r = classifyMaterial({ title, category: '거래', source: 'upbit', knownSymbols: known });
  assert.equal(r.grade, 'S');
  assert.equal(r.direction, 'bullish');
  assert.equal(r.kind, '원화상장');
  assert.deepEqual(r.tickers, ['CRV']);
  assert.deepEqual(r.candidateTickers, ['CRV']);
  assert.equal(r.stale, false);
  assert.match(r.reason, /원화/);
});

// ---- D3/D6: 신규 상장 심볼은 정의상 knownSymbols에 없다 ----

test('classifyMaterial: 진짜 신규 상장이면 tickers는 비고 candidateTickers에 남는다', () => {
  // 호출자(scripts/event-trader.js)는 knownSymbols를 거래소 티커 목록에서 채운다.
  // 신규 상장 심볼은 정의상 거기에 없다 — tickers만 보면 명세가 최우선으로
  // 꼽은 재료가 통째로 버려진다.
  const r = classifyMaterial({
    title: '소파이(SOPH) KRW 마켓 디지털 자산 추가',
    category: '거래',
    source: 'upbit',
    knownSymbols: ['BTC', 'ETH'],
  });
  assert.equal(r.grade, 'S');
  assert.equal(r.kind, '원화상장');
  assert.deepEqual(r.tickers, [], '아직 살 수 없으므로 매매 대상 티커는 비어야 한다');
  assert.deepEqual(r.candidateTickers, ['SOPH'], '재료의 대상은 기록으로 남아야 한다');
});

test('classifyMaterial: candidateTickers는 검증 전 전체, tickers는 검증 통과분이다', () => {
  const r = classifyMaterial({
    title: 'BTC, USDT 마켓 신규 거래지원 안내 (BICO, BMT, NIL, GWEI)',
    category: '거래',
    source: 'upbit',
    knownSymbols: ['BICO', 'NIL'],
  });
  assert.deepEqual(r.candidateTickers, ['BICO', 'BMT', 'NIL', 'GWEI']);
  assert.deepEqual(r.tickers, ['BICO', 'NIL']);
});

test('classifyMaterial: 티커가 아예 없는 공지는 두 필드가 모두 빈 배열이다', () => {
  const r = cls(up('Rate Limit'));
  assert.deepEqual(r.tickers, []);
  assert.deepEqual(r.candidateTickers, []);
});

test('classifyMaterial: 원화 마켓 추가 표현도 S급으로 잡는다', () => {
  const r = classifyMaterial({
    title: '커브(CRV) 원화 마켓 추가',
    category: '거래',
    source: 'upbit',
    knownSymbols: KNOWN,
  });
  assert.equal(r.grade, 'S');
  assert.equal(r.kind, '원화상장');
});

test('classifyMaterial: USDT/BTC 마켓 상장은 원화보다 한 급 낮은 A다', () => {
  // 실제 업비트 제목에서 후속 공지 꼬리표만 뗀 형태(최초 공지 시점의 제목).
  const r = classifyMaterial({
    title: '넥소(NEXO) 신규 거래지원 안내 (USDT 마켓)',
    category: '거래',
    source: 'upbit',
    knownSymbols: KNOWN,
  });
  assert.equal(r.grade, 'A');
  assert.equal(r.direction, 'bullish');
  assert.deepEqual(r.tickers, ['NEXO']);
  assert.equal(r.stale, false);
});

test('classifyMaterial: 에어드랍은 B급 호재다', () => {
  const r = cls(up('GAS 에어드랍'));
  assert.equal(r.grade, 'B');
  assert.equal(r.direction, 'bullish');
  assert.equal(r.kind, '에어드랍');
});

test('classifyMaterial: 이벤트·거래대회는 C급이다', () => {
  const r = cls(up('XRP TOP 100 트레이딩 이벤트'));
  assert.equal(r.grade, 'C');
  assert.equal(r.kind, '이벤트');
  assert.deepEqual(r.tickers, ['XRP']);
});

test('classifyMaterial: 제목에 이벤트가 없어도 카테고리가 이벤트면 C급이다', () => {
  // "그래비티토큰(GRVT) 트레이딩 위크 : ..." — 제목만 보면 키워드가 없다.
  const r = cls(up('트레이딩 위크'));
  assert.equal(r.grade, 'C');
  assert.deepEqual(r.tickers, ['GRVT']);
});

// ---- classifyMaterial: 악재 등급 ----

test('classifyMaterial: 거래 유의 종목 지정은 S급 악재다', () => {
  const r = cls(up('만트라(MANTRA) 거래 유의 종목 지정 안내'));
  assert.equal(r.grade, 'S');
  assert.equal(r.direction, 'bearish');
  assert.equal(r.kind, '거래유의');
  assert.deepEqual(r.tickers, ['MANTRA']);
  assert.equal(r.stale, false);
});

test('classifyMaterial: 띄어쓰기가 붙은 거래유의종목 지정도 같은 S급 악재다', () => {
  // 업비트는 "거래 유의 종목 지정", 빗썸은 "거래유의종목 지정"으로 쓴다.
  // 공백에 의존하면 거래소 하나를 통째로 놓친다.
  const n = bt('거래유의종목 지정');
  const r = classifyMaterial({
    title: n.title,
    category: n.categories,
    source: 'bithumb',
    knownSymbols: KNOWN,
  });
  assert.equal(r.grade, 'S');
  assert.equal(r.direction, 'bearish');
  assert.equal(r.tickers.length, 4);
});

test('classifyMaterial: 거래지원 종료는 상장폐지와 같은 S급 악재다', () => {
  const r = cls(up('스토리지(STORJ) 거래지원 종료'));
  assert.equal(r.grade, 'S');
  assert.equal(r.direction, 'bearish');
  assert.deepEqual(r.tickers, ['STORJ']);
});

test('classifyMaterial: 괄호 앞 공백이 없는 거래지원 종료 제목도 놓치지 않는다', () => {
  // "재스미코인(JASMY) 거래지원 종료 안내(9/14 15:00)" — 실제로 공백이 빠져 있다.
  const r = cls(up('재스미코인(JASMY)'));
  assert.equal(r.grade, 'S');
  assert.deepEqual(r.tickers, ['JASMY']);
});

test('classifyMaterial: 입출금 일시 중단은 B급 약악재다', () => {
  const r = cls(up('메가이더(MEGA) 입출금'));
  assert.equal(r.grade, 'B');
  assert.equal(r.direction, 'bearish');
  assert.equal(r.kind, '입출금중단');
});

test('classifyMaterial: 빗썸 표기 "입출금 일시 중지"도 같은 B급으로 잡는다', () => {
  const n = bt('메가이더(MEGA) 입출금 일시 중지');
  const r = classifyMaterial({
    title: n.title,
    category: n.categories,
    source: 'bithumb',
    knownSymbols: KNOWN,
  });
  assert.equal(r.grade, 'B');
  assert.equal(r.kind, '입출금중단');
});

test('classifyMaterial: 네트워크 전체 입출금 중지는 B급이되 티커를 특정하지 않는다', () => {
  const n = bt('BNB Smart Chain');
  const r = classifyMaterial({
    title: n.title,
    category: n.categories,
    source: 'bithumb',
    knownSymbols: KNOWN,
  });
  assert.equal(r.grade, 'B');
  assert.equal(r.direction, 'bearish');
  assert.deepEqual(r.tickers, []);
});

// ---- D1: 해제 공지는 방향이 정반대다 ----

test('classifyMaterial: 유의 종목 지정 "해제"는 악재가 아니라 호재다', () => {
  // 지정 공지가 난 종목에는 반드시 해제 아니면 폐지가 뒤따른다. 해제를 S급
  // 악재로 읽으면 안도 랠리 국면에서 정확히 반대로 대응한다.
  const r = classifyMaterial({
    title: '질리카(ZIL) 거래 유의 종목 지정 해제 안내',
    category: '거래',
    source: 'upbit',
    knownSymbols: KNOWN,
  });
  assert.equal(r.direction, 'bullish');
  assert.equal(r.kind, '거래유의해제');
  assert.equal(r.grade, 'A', '안도 랠리는 신규 상장만큼 크지 않다');
  assert.deepEqual(r.tickers, ['ZIL']);
});

test('classifyMaterial: 빗썸 표기 "거래유의종목 지정 해제"도 같은 호재다', () => {
  const r = classifyMaterial({
    title: '만트라(MANTRA) 거래유의종목 지정 해제 안내',
    category: ['거래유의'],
    source: 'bithumb',
    knownSymbols: KNOWN,
  });
  assert.equal(r.direction, 'bullish');
  assert.equal(r.kind, '거래유의해제');
});

test('classifyMaterial: 입출금 중단 "해제"는 약악재가 아니라 약호재다', () => {
  const r = classifyMaterial({
    title: '아스타(ASTR) 입출금 일시 중단 해제 안내',
    category: '입출금',
    source: 'upbit',
    knownSymbols: KNOWN,
  });
  assert.equal(r.direction, 'bullish');
  assert.equal(r.kind, '입출금재개');
  assert.equal(r.grade, 'C');
});

test('classifyMaterial: 빗썸 "입출금 재개 안내"도 약호재로 잡는다', () => {
  const r = classifyMaterial({
    title: '메가이더(MEGA) 입출금 재개 안내',
    category: ['입출금'],
    source: 'bithumb',
    knownSymbols: KNOWN,
  });
  assert.equal(r.direction, 'bullish');
  assert.equal(r.kind, '입출금재개');
});

test('classifyMaterial: 거래유의 카테고리 폴백은 방향을 단정하지 않는다', () => {
  // 빗썸은 해제 공지도 '거래유의' 카테고리에 넣는다. 카테고리만으로 방향을
  // bearish로 못박으면 그 카테고리 전체가 S급 악재로 고정된다.
  const r = classifyMaterial({
    title: '가상자산 관련 안내드립니다',
    category: ['거래유의'],
    source: 'bithumb',
    knownSymbols: KNOWN,
  });
  assert.equal(r.direction, 'neutral');
  assert.notEqual(r.grade, 'S');
  assert.match(r.reason, /방향/);
});

test('classifyMaterial: 카테고리 폴백은 제목 규칙을 이기지 못한다', () => {
  // 폴백은 제목 규칙이 아무것도 못 맞췄을 때의 최후 수단이어야 한다.
  const r = classifyMaterial({
    title: '만트라(MANTRA) 거래 유의 종목 지정 안내',
    category: ['거래유의'],
    source: 'bithumb',
    knownSymbols: KNOWN,
  });
  assert.equal(r.direction, 'bearish');
  assert.equal(r.grade, 'S');
});

// ---- D2: 호재 사유가 붙은 입출금 중단 ----

test('classifyMaterial: 메인넷 스왑에 따른 입출금 중단은 B급 호재다', () => {
  // 거래소는 이 호재들을 거의 항상 입출금 중단 공지에 얹어서 낸다. 입출금
  // 규칙이 먼저 맞으면 호재가 통째로 악재로 뒤집힌다.
  const r = classifyMaterial({
    title: '엘프(ELF) 메인넷 스왑 지원에 따른 입출금 일시 중단 안내',
    category: '입출금',
    source: 'upbit',
    knownSymbols: KNOWN,
  });
  assert.equal(r.direction, 'bullish');
  assert.equal(r.kind, '메인넷');
  assert.equal(r.grade, 'B');
  assert.deepEqual(r.tickers, ['ELF']);
});

test('classifyMaterial: 에어드랍 지급에 따른 입출금 중단은 B급 호재다', () => {
  const r = classifyMaterial({
    title: '가스(GAS) 에어드랍 지급을 위한 입출금 일시 중단 안내',
    category: '입출금',
    source: 'upbit',
    knownSymbols: KNOWN,
  });
  assert.equal(r.direction, 'bullish');
  assert.equal(r.kind, '에어드랍');
  assert.equal(r.grade, 'B');
});

test('classifyMaterial: 하드포크 스냅샷에 따른 입출금 중지는 B급 호재다', () => {
  const r = classifyMaterial({
    title: '아스타(ASTR) 하드포크 스냅샷 진행에 따른 입출금 일시 중지 안내',
    category: '입출금',
    source: 'bithumb',
    knownSymbols: KNOWN,
  });
  assert.equal(r.direction, 'bullish');
  assert.equal(r.kind, '스냅샷');
  assert.equal(r.grade, 'B');
});

test('classifyMaterial: 호재 사유가 없는 순수 입출금 중단은 그대로 약악재다', () => {
  // D2 수정이 입출금 규칙 자체를 무력화하지 않았는지 확인한다.
  const r = cls(up('만트라(MANTRA) 입출금 일시 중단 안내'));
  assert.equal(r.direction, 'bearish');
  assert.equal(r.kind, '입출금중단');
  assert.equal(r.grade, 'B');
});

// ---- D5: 무테스트였던 규칙들 ----

test('classifyMaterial: 상장폐지는 S급 악재다', () => {
  const r = classifyMaterial({
    title: '루미웨이브프로토콜(LWP) 상장 폐지 안내',
    category: '거래',
    source: 'bithumb',
    knownSymbols: KNOWN,
  });
  assert.equal(r.grade, 'S');
  assert.equal(r.direction, 'bearish');
  assert.equal(r.kind, '상장폐지');
  assert.deepEqual(r.tickers, ['LWP']);
});

test('classifyMaterial: 단독 스냅샷 공지는 B급 호재다', () => {
  const r = classifyMaterial({
    title: '아스타(ASTR) 스냅샷 진행 안내',
    category: '디지털 자산',
    source: 'upbit',
    knownSymbols: KNOWN,
  });
  assert.equal(r.grade, 'B');
  assert.equal(r.direction, 'bullish');
  assert.equal(r.kind, '스냅샷');
});

test('classifyMaterial: 단독 메인넷·하드포크 공지는 B급 호재다', () => {
  for (const title of ['엘프(ELF) 메인넷 전환 안내', '엘프(ELF) 하드포크 지원 안내']) {
    const r = classifyMaterial({ title, category: '안내', source: 'upbit', knownSymbols: KNOWN });
    assert.equal(r.grade, 'B', title);
    assert.equal(r.direction, 'bullish', title);
    assert.equal(r.kind, '메인넷', title);
  }
});

test('classifyMaterial: 에어드롭 표기 변형도 에어드랍과 같게 잡는다', () => {
  const r = classifyMaterial({
    title: '가스(GAS) 에어드롭 지급 안내',
    category: '디지털 자산',
    source: 'upbit',
    knownSymbols: KNOWN,
  });
  assert.equal(r.grade, 'B');
  assert.equal(r.kind, '에어드랍');
});

test('classifyMaterial: 파트너십·제휴는 B급 호재다', () => {
  for (const title of ['갈라(GALA) 파트너십 체결 안내', '갈라(GALA) 제휴 안내']) {
    const r = classifyMaterial({ title, category: '안내', source: 'upbit', knownSymbols: KNOWN });
    assert.equal(r.grade, 'B', title);
    assert.equal(r.direction, 'bullish', title);
    assert.equal(r.kind, '파트너십', title);
  }
});

test('classifyMaterial: 프로모션·거래대회는 이벤트와 같은 C급이다', () => {
  for (const title of ['비트코인(BTC) 프로모션 안내', '비트코인(BTC) 거래대회 안내']) {
    const r = classifyMaterial({ title, category: '안내', source: 'upbit', knownSymbols: KNOWN });
    assert.equal(r.grade, 'C', title);
    assert.equal(r.kind, '이벤트', title);
  }
});

test('classifyMaterial: "신규상장" 표현도 상장 규칙으로 잡는다', () => {
  const krw = classifyMaterial({
    title: '소파이(SOPH) 원화 마켓 신규상장 안내',
    category: '거래',
    source: 'bithumb',
    knownSymbols: KNOWN,
  });
  assert.equal(krw.grade, 'S');
  assert.equal(krw.kind, '원화상장');

  const usdt = classifyMaterial({
    title: '소파이(SOPH) 신규상장 안내 (USDT 마켓)',
    category: '거래',
    source: 'bithumb',
    knownSymbols: KNOWN,
  });
  assert.equal(usdt.grade, 'A');
  assert.equal(usdt.kind, 'BTC/USDT상장');
});

test('STALE_MARKERS: 공개된 표지는 모두 실제로 stale 판정을 만든다', () => {
  assert.ok(Array.isArray(STALE_MARKERS) && STALE_MARKERS.length > 0);
  for (const marker of STALE_MARKERS) {
    assert.equal(typeof marker, 'string');
    const r = classifyMaterial({
      title: `만트라(MANTRA) 거래 유의 종목 지정 안내 ${marker}`,
      category: '거래',
      source: 'upbit',
      knownSymbols: KNOWN,
    });
    assert.equal(r.stale, true, `"${marker}" 가 stale로 잡혀야 합니다`);
    assert.equal(r.grade, 'B', `"${marker}" 는 S급을 한 급 내려야 합니다`);
  }
});

// ---- stale: 이미 반영된 재료 ----

test('classifyMaterial: 기간 연장은 stale로 잡고 S급 악재를 한 단계 낮춘다', () => {
  // "질리카(ZIL) 거래 유의 종목 지정 기간 연장 안내" — 기존 지정의 연장이라
  // 새 정보가 없다. 이걸 새 재료로 보면 이미 빠진 뒤에 뛰어든다.
  const r = cls(up('질리카(ZIL) 거래 유의 종목 지정 기간 연장'));
  assert.equal(r.stale, true);
  assert.equal(r.grade, 'B');
  assert.equal(r.direction, 'bearish');
  assert.match(r.reason, /이미 반영/);
});

test('classifyMaterial: 시점 변경 후속 공지는 stale이고 A급이 C급으로 내려간다', () => {
  const r = cls(up('거래지원 개시 시점 변경'));
  assert.equal(r.stale, true);
  assert.equal(r.grade, 'C');
  assert.deepEqual(r.tickers, ['NEXO']);
});

test('classifyMaterial: 복수 상장의 변경 안내도 stale로 잡는다', () => {
  const r = cls(up('BTC, USDT 마켓 신규 거래지원'));
  assert.equal(r.stale, true);
  assert.equal(r.grade, 'C');
  assert.deepEqual(r.tickers, ['BICO', 'BMT', 'NIL', 'GWEI']);
});

test('classifyMaterial: (완료)가 붙은 입출금 중단은 매매 대상에서 뺀다', () => {
  const r = cls(up('아스타(ASTR)'));
  assert.equal(r.stale, true);
  assert.equal(r.grade, null);
  assert.match(r.reason, /이미 반영/);
});

test('classifyMaterial: 종료된 이벤트도 매매 대상이 아니다', () => {
  const r = cls(up('거래 수수료 0% 혜택'));
  assert.equal(r.stale, true);
  assert.equal(r.grade, null);
});

// ---- null: 매매 대상 아님 ----

test('classifyMaterial: Rate Limit 안내는 매매 대상이 아니다', () => {
  const r = cls(up('Rate Limit'));
  assert.equal(r.grade, null);
  assert.equal(r.direction, 'neutral');
  assert.deepEqual(r.tickers, []);
  assert.match(r.reason, /매매 대상/);
});

test('classifyMaterial: 실사보고서·유통량 계획표·후기·공시는 전부 grade가 null이다', () => {
  assert.equal(cls(up('실사보고서')).grade, null);
  assert.equal(cls(up('유통량 계획표 변경 안내 : 바이오프로토콜')).grade, null);
  assert.equal(cls(up('피싱메일')).grade, null);

  for (const fragment of ['재산상 이익 제공 공시', '뮤지컬']) {
    const n = bt(fragment);
    const r = classifyMaterial({
      title: n.title,
      category: n.categories,
      source: 'bithumb',
      knownSymbols: KNOWN,
    });
    assert.equal(r.grade, null, `"${n.title}" 는 매매 대상이 아니어야 합니다`);
  }
});

test('classifyMaterial: 입출금 "제한"은 중단·중지와 달라 매매 대상이 아니다', () => {
  // "특정금융정보법에 따른 미신고 가상자산사업자와의 입출금 제한 및 유의사항" —
  // '입출금'과 '유의'가 둘 다 들어 있지만 종목 재료가 아니다. 키워드를 느슨하게
  // 잡으면 이런 상시 고정 공지가 매일 신호로 뜬다.
  const r = cls(up('미신고 가상자산사업자'));
  assert.equal(r.grade, null);
});

test('classifyMaterial: "주의 종목 경보 세분화" 같은 제도 안내는 유의 지정이 아니다', () => {
  const r = cls(up('주의 종목 경보 세분화'));
  assert.equal(r.grade, null);
});

// ---- 계약(shape) ----

test('classifyMaterial: 어떤 입력이든 계약된 7개 키를 모두 갖춘 객체를 돌려준다', () => {
  for (const n of [...upbitNotices, ...bithumb]) {
    const r = classifyMaterial({
      title: n.title,
      category: n.category ?? n.categories,
      source: 'upbit',
      knownSymbols: KNOWN,
    });
    assert.deepEqual(
      Object.keys(r).sort(),
      ['candidateTickers', 'direction', 'grade', 'kind', 'reason', 'stale', 'tickers'].sort()
    );
    assert.ok(r.grade === null || ['S', 'A', 'B', 'C'].includes(r.grade), `grade=${r.grade}`);
    assert.ok(['bullish', 'bearish', 'neutral'].includes(r.direction), `direction=${r.direction}`);
    assert.equal(typeof r.kind, 'string');
    assert.equal(typeof r.reason, 'string');
    assert.equal(typeof r.stale, 'boolean');
    assert.ok(Array.isArray(r.tickers));
    assert.ok(Array.isArray(r.candidateTickers));
    // 매매 대상 티커는 언제나 후보의 부분집합이어야 한다.
    for (const t of r.tickers) assert.ok(r.candidateTickers.includes(t), `${t} 가 후보에 없습니다`);
  }
});

test('classifyMaterial: title이 문자열이 아니면 TypeError', () => {
  assert.throws(() => classifyMaterial({ title: null, knownSymbols: KNOWN }), TypeError);
  assert.throws(() => classifyMaterial(), TypeError);
});
