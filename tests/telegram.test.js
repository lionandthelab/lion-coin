const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  MARKERS,
  formatEventAlert,
  formatEntryAlert,
  formatExitAlert,
  formatHaltAlert,
  buildSendUrl,
  sendMessage,
} = require('../src/telegram');
const { classifyMaterial } = require('../src/material');

// 알림은 **판단을 대신 내려주지 않는다** — 휴대폰 잠금화면에서 3초 안에
// "지금 봐야 하나"를 가르는 것이 전부다. 그래서 이 테스트가 못박는 것은 두 가지다.
//
// 1) 첫 줄만 보고 종류·방향·크기를 알 수 있는가
// 2) **봇 토큰이 어떤 경로로도 새지 않는가**
//
// (2)가 더 중요하다. 토큰이 새면 남이 내 계정으로 알림을 보낼 수 있고,
// 텔레그램 토큰은 취소하기 전까지 영구히 유효하다. 특히 fetch가 던지는 에러의
// message에는 요청 URL이 통째로 들어가는데, 그 URL 경로에 토큰이 박혀 있다.
// "에러를 그대로 로그에 찍는" 흔한 코드 한 줄이 곧 토큰 유출이다.

// 실제 페이로드에서 그대로 가져온 문자열들(tests/fixtures/upbit-notices.json,
// bithumb-notices.json). 픽스처 파일을 런타임에 읽지 않고 값만 옮겨 적은 이유는,
// 이 테스트가 픽스처 파일의 존재 여부에 의존하지 않게 하기 위해서다.
const REAL_TITLE = '넥소(NEXO) 신규 거래지원 안내 (USDT 마켓) (거래지원 개시 시점 변경 안내)';
const REAL_AT_KST = '2026-08-21T21:50:05+09:00'; // 업비트 listed_at
const REAL_AT_SPACE = '2026-08-21 19:00:00'; // 빗썸 published_at (오프셋 없음, KST)
// event-sources.js가 정규화해 내보내는 실제 값. 프로덕션 알림은 100% 이 타입이다.
const REAL_AT_EPOCH = 1787307565000; // upbit:6496의 at — 19:19:25 KST
const REAL_BITHUMB_AT_EPOCH = 1787299200000; // bithumb:1654570의 at — 19:00:00 KST

const FAKE_TOKEN = '1234567890:AAH-fake_TOKEN_value_do_not_leak_xyz';

// fetch를 대신할 스텁. 호출 인자를 그대로 붙잡아 둔다.
function stubFetch(responder) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    return responder({ url, init });
  };
  impl.calls = calls;
  return impl;
}

// 표식 이모지는 대부분 서로게이트 쌍이다. text[0]으로 비교하면 🔥(D83D DD25)와
// 🚨(D83D DEA8)가 같은 값으로 보여, 방향 구분이 깨져도 테스트가 초록이 된다.
const firstGlyph = (text) => Array.from(text)[0];

const okResponse = (body = { ok: true, result: { message_id: 7 } }) => ({
  ok: true,
  status: 200,
  json: async () => body,
});

// ---- formatEventAlert ----

test('formatEventAlert: 첫 줄에 등급·종류·심볼이 오고 급별 이모지가 붙는다', () => {
  const out = formatEventAlert({
    event: { symbol: 'NEXO', title: REAL_TITLE, source: '업비트 공지', at: REAL_AT_KST },
    material: { grade: 'S', kind: '호재', direction: 'bullish' },
  });
  const first = out.split('\n')[0];
  assert.ok(first.startsWith('🔥'), `첫 줄: ${first}`);
  assert.match(first, /S급/);
  assert.match(first, /호재/);
  assert.match(first, /NEXO/);
});

// H1 재현: 실제 파이프라인이 넘기는 이벤트에는 symbol이 없다.
// event-sources.js의 EVENT_KEYS는 id·source·at·title·category·url·updatedAt 뿐이고,
// event-trader.js는 그 정규화 이벤트를 그대로 넘긴다. 종목을 아는 쪽은 분류기다.
// 첫 줄에서 종목을 못 가리면 "3초 판단"이 재료 알림에서만 깨진다.
test('formatEventAlert: 정규화 이벤트(symbol 없음)에서도 material.tickers로 티커를 낸다', () => {
  const event = {
    id: 'upbit:6496',
    source: 'upbit',
    at: REAL_AT_EPOCH,
    title: REAL_TITLE,
    category: '거래',
    url: 'https://upbit.com/service_center/notice?id=6496',
    updatedAt: null,
  };
  const material = classifyMaterial({
    title: event.title,
    category: event.category,
    source: event.source,
    knownSymbols: ['NEXO', 'BTC', 'USDT'],
  });
  assert.deepEqual(material.tickers, ['NEXO'], '분류기가 티커를 찾아 두었는지 먼저 확인');

  const first = formatEventAlert({ event, material }).split('\n')[0];
  assert.match(first, /NEXO/, `첫 줄에 티커가 없다: ${first}`);
});

test('formatEventAlert: 티커는 실제로 주문이 나가는 자리(material.tickers[0])를 따른다', () => {
  // event-trader.js의 tryEnter는 m.tickers[0]으로 진입한다. 알림이 가리키는 종목과
  // 주문이 나가는 종목이 어긋나면 사람이 엉뚱한 차트를 보게 된다.
  const first = formatEventAlert({
    event: { symbol: 'WRONG', title: REAL_TITLE, source: 'upbit' },
    material: { grade: 'S', kind: '원화상장', direction: 'bullish', tickers: ['NEXO', 'BTC'] },
  }).split('\n')[0];
  assert.match(first, /NEXO/, first);
  assert.ok(!first.includes('WRONG'), first);
});

// H1 잔여: **가장 중요한 재료가 정확히 종목명 없이 나간다.**
// 신규 상장·상장폐지 종목은 정의상 거래소 목록(knownSymbols)에 없다. 그래서
// tickers는 비고 candidateTickers만 채워진다 — S급 재료 전부가 이 경로다.
test('formatEventAlert: 거래 불가 종목도 candidateTickers로 이름을 낸다', () => {
  const event = {
    id: 'upbit:6530', source: 'upbit', at: REAL_AT_EPOCH,
    title: '소파이(SOPH) KRW 마켓 디지털 자산 추가', category: '거래',
    url: null, updatedAt: null,
  };
  // 신규 상장이므로 SOPH는 아직 거래소 목록에 없다 — 실전 조건 그대로다.
  const material = classifyMaterial({
    title: event.title, category: event.category, source: event.source,
    knownSymbols: ['BTC', 'ETH'],
  });
  assert.equal(material.grade, 'S');
  assert.deepEqual(material.tickers, [], '거래 가능 티커는 없는 것이 정상이다');
  assert.deepEqual(material.candidateTickers, ['SOPH'], '분별기는 대상을 알고 있다');

  const first = formatEventAlert({ event, material }).split('\n')[0];
  assert.match(first, /SOPH/, `S급 상장 알림 첫 줄에 종목이 없다: ${first}`);
});

test('formatEventAlert: 거래 가능한 티커가 있으면 후보보다 우선한다', () => {
  // 폴백이 주문 대상을 가려서는 안 된다. 주문은 tickers[0]으로 나간다.
  const first = formatEventAlert({
    event: { title: REAL_TITLE, source: 'upbit' },
    material: {
      grade: 'S', kind: '원화상장', direction: 'bullish',
      tickers: ['NEXO'], candidateTickers: ['WRONG'],
    },
  }).split('\n')[0];
  assert.match(first, /NEXO/, first);
  assert.ok(!first.includes('WRONG'), first);
});

test('formatEventAlert: 제목·출처·시각 줄을 만든다', () => {
  const out = formatEventAlert({
    event: { symbol: 'NEXO', title: REAL_TITLE, source: '업비트 공지', at: REAL_AT_KST },
    material: { grade: 'S', kind: '호재', direction: 'bullish' },
  });
  const lines = out.split('\n');
  assert.equal(lines[1], REAL_TITLE);
  assert.equal(lines[2], '출처: 업비트 공지 · 21:50:05');
});

test('formatEventAlert: KST 표기 시각을 시간대 변환 없이 그대로 읽는다', () => {
  // 서버가 UTC로 돌면 Date로 되돌릴 때 9시간이 밀린다. 공지 시각이 9시간 틀리면
  // "방금 뜬 재료"와 "어제 재료"를 구분할 수 없어 알림 자체가 무의미해진다.
  const spaced = formatEventAlert({
    event: { symbol: 'MEGA', title: '입출금 일시 중지 안내', source: '빗썸 공지', at: REAL_AT_SPACE },
    material: { grade: 'B', kind: '악재' },
  });
  assert.match(spaced, /· 19:00:00/);

  // 반대로 UTC(Z) 표기는 진짜로 변환해야 한다 — 21:50:05 KST.
  const utc = formatEventAlert({
    event: { symbol: 'NEXO', title: 't', source: 's', at: '2026-08-21T12:50:05Z' },
    material: { grade: 'S' },
  });
  assert.match(utc, /· 21:50:05/);
});

test('formatEventAlert: Markdown 특수문자가 든 제목을 훼손하지 않고 그대로 통과시킨다', () => {
  // 거래소 제목에는 `_`, `*`, `[`, 백틱이 실제로 들어온다. 이스케이프 백슬래시를
  // 끼워 넣으면 사람이 읽는 글자가 더러워지고, 안 넣고 Markdown으로 보내면 400이 난다.
  // 이 모듈의 선택은 "평문으로 보낸다"이므로, 제목은 원문 그대로여야 한다.
  const nasty = 'AAA_BBB *특별* [이벤트] `코드` 안내';
  const out = formatEventAlert({
    event: { symbol: 'AAA', title: nasty, source: '빗썸 공지', at: REAL_AT_SPACE },
    material: { grade: 'A', kind: '호재' },
  });
  assert.ok(out.includes(nasty), '제목이 원문 그대로 들어가야 한다');
  assert.ok(!out.includes('\\'), '평문 전송이므로 이스케이프 백슬래시가 있으면 안 된다');
});

test('formatEventAlert: 출처·시각이 없으면 그 줄을 지어내지 않는다', () => {
  const out = formatEventAlert({
    event: { symbol: 'AAA', title: '제목만 있는 재료' },
    material: { grade: 'A', kind: '호재' },
  });
  assert.ok(!out.includes('출처'), out);
  assert.equal(out.split('\n').length, 2);
});

test('formatEventAlert: 등급이 없으면 등급미상으로 표시하고 던지지 않는다', () => {
  const out = formatEventAlert({
    event: { symbol: 'AAA', title: '분류 실패한 공지' },
    material: {},
  });
  assert.match(out, /등급미상/);
});

// H2 재현: 제목이 비면 던지는 게 아니라 대체 문구로 알려야 한다.
// event-sources.js는 제목이 문자열이 아니면 의도적으로 ''로 정규화하고,
// classifyMaterial은 빈 제목이어도 카테고리 폴백('거래유의')으로 **B급/neutral**을
// 준다 — 등급이 붙는 이상 걸러지지 않고 포맷 함수까지 내려온다.
// event-trader.js에서 포맷 호출은 notify()의 **인자**라 notify의 try/catch 밖에서
// 평가되므로, 여기서 던지면 TypeError가 pollOnce를 뚫고 나가 폴링 배치가 통째로
// 중단된다 — 남은 재료까지 전부 버려진다. 이 모듈 자신이 formatHaltAlert에서
// "던지면 최악의 순간에 침묵한다"는 정반대 정책을 이미 세워 두었다.
test('formatEventAlert: 제목이 비어도 던지지 않고 대체 문구를 낸다', () => {
  for (const title of [undefined, '', '   ', null, 123]) {
    const out = formatEventAlert({ event: { symbol: 'AAA', title }, material: { grade: 'S', direction: 'bearish' } });
    const lines = out.split('\n');
    assert.match(lines[0], /AAA/, lines[0]);
    assert.ok(lines[1] && lines[1].trim(), `제목 줄이 비었다: ${JSON.stringify(out)}`);
    assert.match(lines[1], /제목/, lines[1]);
  }
  assert.doesNotThrow(() => formatEventAlert({ material: { grade: 'S' } }));
  assert.doesNotThrow(() => formatEventAlert());
});

test('formatEventAlert: 제목 하나가 비어도 폴링 배치의 나머지 재료를 버리지 않는다', () => {
  // 실제 빗썸 페이로드 5건 중 첫 건의 title만 지운 재현. 던지면 0건 처리 후 중단된다.
  const batch = [
    { source: 'bithumb', title: '', category: '거래유의', at: REAL_BITHUMB_AT_EPOCH },
    { source: 'bithumb', title: '만트라(MANTRA), 바운스빗(BB), 갈라(GALA), 썬도그(SUNDOG) 거래유의종목 지정', category: '거래유의', at: REAL_BITHUMB_AT_EPOCH },
    { source: 'bithumb', title: '메가이더(MEGA) 입출금 일시 중지 안내 (08/25 09:00 ~)', category: '입출금', at: REAL_BITHUMB_AT_EPOCH },
  ];
  const sent = [];
  for (const event of batch) {
    const material = classifyMaterial({
      title: event.title, category: event.category, source: event.source,
      knownSymbols: ['MANTRA', 'BB', 'GALA', 'SUNDOG', 'MEGA'],
    });
    if (!material.grade) continue;
    sent.push(formatEventAlert({ event, material })); // notify()의 인자 = try/catch 밖
  }
  assert.equal(sent.length, 3, `배치가 중단됐다: ${sent.length}건만 처리`);
});

// H3 재현: 악재에 🔥가 붙으면 잠금화면에서 호재와 구별되지 않아 정확히 반대로 행동한다.
test('formatEventAlert: 악재는 호재와 다른 표식을 쓴다', () => {
  const bearish = formatEventAlert({
    event: { title: '만트라(MANTRA) 거래 유의 종목 지정 안내', source: 'upbit', at: REAL_AT_EPOCH },
    material: { grade: 'S', kind: '거래유의', direction: 'bearish', tickers: ['MANTRA'] },
  });
  const bullish = formatEventAlert({
    event: { title: '커브(CRV) KRW, USDT 마켓 디지털 자산 추가', source: 'upbit', at: REAL_AT_EPOCH },
    material: { grade: 'S', kind: '원화상장', direction: 'bullish', tickers: ['CRV'] },
  });
  // 이모지는 서로게이트 쌍이라 [0]으로 자르면 🔥와 🚨가 똑같은 D83D로 보인다.
  // 첫 "글자"는 코드포인트 단위로 비교해야 한다.
  assert.notEqual(firstGlyph(bearish), firstGlyph(bullish), `같은 S급이어도 방향이 다르면 표식이 달라야 한다: ${firstGlyph(bearish)}`);
  assert.ok(!bearish.startsWith('🔥'), `악재에 호재 표식: ${bearish.split('\n')[0]}`);
  assert.ok(bullish.startsWith('🔥'), bullish.split('\n')[0]);
  // 이모지가 죽는 환경(일부 잠금화면·이메일 게이트웨이)에서도 방향이 남아야 한다.
  assert.match(bearish.split('\n')[0], /▼/, bearish.split('\n')[0]);
  assert.match(bullish.split('\n')[0], /▲/, bullish.split('\n')[0]);
});

test('formatEventAlert: 방향을 모르면 호재 표식으로 위장하지 않는다', () => {
  const out = formatEventAlert({ event: { title: '분류 실패한 공지' }, material: { grade: 'S', kind: '기타' } });
  assert.ok(!out.startsWith('🔥'), out);
});

test('formatEventAlert: 실제 분류기 출력에서 악재와 호재의 첫 글자가 갈린다', () => {
  const known = ['MANTRA', 'BB', 'GALA', 'SUNDOG', 'CRV'];
  const bad = classifyMaterial({
    title: '만트라(MANTRA), 바운스빗(BB), 갈라(GALA), 썬도그(SUNDOG) 거래유의종목 지정',
    category: '거래유의', source: 'bithumb', knownSymbols: known,
  });
  const good = classifyMaterial({
    title: '커브(CRV) KRW, USDT 마켓 디지털 자산 추가', category: '거래', source: 'upbit', knownSymbols: known,
  });
  assert.equal(bad.direction, 'bearish');
  assert.equal(good.direction, 'bullish');
  assert.equal(bad.grade, good.grade, '둘 다 S급이라 등급만으로는 구별되지 않는다');

  const badLine = formatEventAlert({ event: { title: 'x', source: 'bithumb' }, material: bad }).split('\n')[0];
  const goodLine = formatEventAlert({ event: { title: 'y', source: 'upbit' }, material: good }).split('\n')[0];
  assert.notEqual(firstGlyph(badLine), firstGlyph(goodLine), `${badLine} / ${goodLine}`);
});

// M5 재현: event-sources.js는 at을 epoch ms 숫자로 내보내므로 프로덕션 알림은
// 100% 이 분기를 탄다. 그런데 기존 테스트에는 숫자 at이 하나도 없었다.
test('formatEventAlert: epoch ms 숫자 at을 KST 시:분:초로 읽는다', () => {
  const out = formatEventAlert({
    event: { title: REAL_TITLE, source: 'upbit', at: REAL_AT_EPOCH },
    material: { grade: 'S', kind: '원화상장', direction: 'bullish', tickers: ['NEXO'] },
  });
  assert.match(out, /출처: upbit · 19:19:25/, out);
});

test('formatEventAlert: 숫자 at이 NaN이면 시각 줄을 지어내지 않는다', () => {
  const out = formatEventAlert({
    event: { title: REAL_TITLE, at: Number.NaN },
    material: { grade: 'S', kind: '원화상장', direction: 'bullish', tickers: ['NEXO'] },
  });
  assert.ok(!out.includes('출처'), out);
});

test('formatEventAlert: 원본 페이로드 필드명(pc_url·published_at)도 읽는다', () => {
  const out = formatEventAlert({
    event: {
      symbol: 'MEGA',
      title: '메가이더(MEGA) 입출금 일시 중지 안내',
      source: '빗썸 공지',
      published_at: REAL_AT_SPACE,
      pc_url: 'https://feed.bithumb.com/notice/1654571',
    },
    material: { grade: 'B', kind: '악재' },
  });
  assert.match(out, /19:00:00/);
  assert.match(out, /https:\/\/feed\.bithumb\.com\/notice\/1654571/);
});

test('formatEventAlert: 객체에 딸려온 토큰 필드는 절대 출력되지 않는다', () => {
  // 설정 객체를 통째로 넘기는 실수가 흔하다. 포맷 함수는 아는 필드만 읽어야 한다.
  const out = formatEventAlert({
    event: { symbol: 'AAA', title: '제목', source: '빗썸 공지', token: FAKE_TOKEN, botToken: FAKE_TOKEN },
    material: { grade: 'S', kind: '호재', token: FAKE_TOKEN },
  });
  assert.ok(!out.includes(FAKE_TOKEN), out);
  assert.ok(!out.includes('AAH-fake'), out);
});

// ---- formatEntryAlert ----

test('formatEntryAlert: 명목·진입가·익절·손절을 세 줄로 낸다', () => {
  const out = formatEntryAlert({
    symbol: 'NEXO',
    plan: { entryPrice: 1234, notional: 7800, takeProfitBps: 500, stopLossBps: 200, maxHoldSec: 600 },
  });
  const lines = out.split('\n');
  assert.ok(lines[0].startsWith('💰'), lines[0]);
  assert.match(lines[0], /진입 NEXO/);
  assert.equal(lines[1], '7,800원 @ 1,234원');
  assert.equal(lines[2], '익절 +500bps / 손절 -200bps / 최대 10분');
});

test('formatEntryAlert: planBracket 출력(가격만 있는 경우)에서 bps를 역산한다', () => {
  // planBracket은 takeProfitPrice·stopLossPrice를 돌려주고 bps는 돌려주지 않는다.
  // 그 출력을 그대로 넘겨도 알림이 나와야 한다.
  const out = formatEntryAlert({
    symbol: 'NEXO',
    plan: { entryPrice: 100, takeProfitPrice: 101, stopLossPrice: 99.5, quantity: 5000 },
  });
  assert.match(out, /익절 \+100bps \/ 손절 -50bps/);
  // 명목이 없으면 수량×진입가로 만든다.
  assert.match(out, /500,000원 @ 100원/);
});

test('formatEntryAlert: 손절 bps를 양수로 넘겨도 화면에는 음수로 보여준다', () => {
  // 저장소 관례상 stopLossBps는 양수다. 화면에서까지 양수면 방향을 오독한다.
  const out = formatEntryAlert({ symbol: 'AAA', plan: { entryPrice: 100, notional: 10000, takeProfitBps: 300, stopLossBps: 100 } });
  assert.match(out, /손절 -100bps/);
});

test('formatEntryAlert: 최대 보유 시간이 없으면 그 조각을 붙이지 않는다', () => {
  const out = formatEntryAlert({ symbol: 'AAA', plan: { entryPrice: 100, notional: 10000, takeProfitBps: 300, stopLossBps: 100 } });
  assert.ok(!out.includes('최대'), out);
});

test('formatEntryAlert: 1원 미만 가격을 0원으로 반올림하지 않는다', () => {
  // 원화 마켓에는 0.4521원짜리 종목이 실제로 있다. 반올림하면 진입가가 "0원"이 되어
  // 알림이 거짓말을 한다.
  const out = formatEntryAlert({ symbol: 'AAA', plan: { entryPrice: 0.4521, notional: 9042, takeProfitBps: 500, stopLossBps: 200 } });
  assert.match(out, /@ 0\.4521원/);
  assert.ok(!out.includes('@ 0원'), out);
});

test('formatEntryAlert: 재료 정보가 있으면 근거 줄을 덧붙인다', () => {
  const out = formatEntryAlert({
    symbol: 'NEXO',
    plan: { entryPrice: 1234, notional: 7800, takeProfitBps: 500, stopLossBps: 200 },
    event: { title: REAL_TITLE, source: '업비트 공지' },
    material: { grade: 'S', kind: '호재' },
  });
  const last = out.split('\n').at(-1);
  assert.match(last, /S급 호재/);
  assert.ok(last.includes(REAL_TITLE), last);
});

test('formatEntryAlert: plan이 없거나 진입가가 없으면 TypeError', () => {
  assert.throws(() => formatEntryAlert({ symbol: 'AAA' }), TypeError);
  assert.throws(() => formatEntryAlert({ symbol: 'AAA', plan: { notional: 10000 } }), TypeError);
});

test('formatEntryAlert: 모의 매매면 첫 줄에서 그 사실이 드러난다', () => {
  // 모의와 실거래 알림이 똑같이 생기면, 종이 체결을 실제 체결로 읽고 뛰어들거나
  // 실제 체결을 종이로 읽고 방치한다. 둘 다 돈이 걸린 오독이다.
  const out = formatEntryAlert({
    symbol: 'NEXO',
    plan: { entryPrice: 1234, notional: 7800, takeProfitBps: 500, stopLossBps: 200 },
    simulated: true,
  });
  const first = out.split('\n')[0];
  assert.ok(first.startsWith('💰'), '종류 표식은 여전히 첫 글자여야 한다');
  assert.match(first, /모의/);
});

test('formatEntryAlert: 실거래에는 모의 표시를 붙이지 않는다', () => {
  const live = formatEntryAlert({
    symbol: 'NEXO',
    plan: { entryPrice: 1234, notional: 7800, takeProfitBps: 500, stopLossBps: 200 },
    simulated: false,
  });
  assert.ok(!live.includes('모의'), live);
  const omitted = formatEntryAlert({ symbol: 'NEXO', plan: { entryPrice: 1234, notional: 7800 } });
  assert.ok(!omitted.includes('모의'), omitted);
});

test('formatExitAlert: 모의 매매면 첫 줄에서 그 사실이 드러난다', () => {
  const out = formatExitAlert({
    symbol: 'NEXO', outcome: 'take_profit', returnBps: 312, holdSec: 252, pnlKrw: 24, simulated: true,
  });
  const first = out.split('\n')[0];
  assert.ok(first.startsWith('✅'), first);
  assert.match(first, /모의/);
  // 손익금 괄호와 모의 표시가 뒤섞여 읽히면 안 된다.
  assert.match(first, /\(\+24원\).*모의/);
});

test('formatExitAlert: 실거래에는 모의 표시를 붙이지 않는다', () => {
  const out = formatExitAlert({ symbol: 'NEXO', outcome: 'stop_loss', returnBps: -200, holdSec: 61, simulated: false });
  assert.ok(!out.includes('모의'), out);
});

test('formatEntryAlert: plan에 섞여 들어온 토큰은 출력되지 않는다', () => {
  const out = formatEntryAlert({
    symbol: 'AAA',
    plan: { entryPrice: 100, notional: 10000, takeProfitBps: 300, stopLossBps: 100, token: FAKE_TOKEN },
  });
  assert.ok(!out.includes(FAKE_TOKEN), out);
});

// ---- formatExitAlert ----

test('formatExitAlert: 이익이면 ✅, 손실이면 ❌, 본전이면 ➖', () => {
  const win = formatExitAlert({ symbol: 'NEXO', outcome: 'take_profit', returnBps: 312, holdSec: 252, pnlKrw: 24 });
  const loss = formatExitAlert({ symbol: 'NEXO', outcome: 'stop_loss', returnBps: -200, holdSec: 61, pnlKrw: -1240 });
  const flat = formatExitAlert({ symbol: 'NEXO', outcome: 'timeout', returnBps: 0, holdSec: 600, pnlKrw: 0 });
  assert.ok(win.startsWith('✅'), win);
  assert.ok(loss.startsWith('❌'), loss);
  assert.ok(flat.startsWith('➖'), flat);
});

test('formatExitAlert: 첫 줄에 수익률과 손익금이 함께 온다', () => {
  const out = formatExitAlert({ symbol: 'NEXO', outcome: 'take_profit', returnBps: 312, holdSec: 252, pnlKrw: 24 });
  assert.equal(out.split('\n')[0], '✅ 청산 NEXO +312bps (+24원)');
});

test('formatExitAlert: 손실 금액에 부호와 천단위 구분이 들어간다', () => {
  const out = formatExitAlert({ symbol: 'AAA', outcome: 'stop_loss', returnBps: -200, holdSec: 61, pnlKrw: -1240 });
  assert.match(out, /-200bps \(-1,240원\)/);
});

test('formatExitAlert: 손익금이 없으면 괄호를 만들지 않는다', () => {
  const out = formatExitAlert({ symbol: 'AAA', outcome: 'timeout', returnBps: 12, holdSec: 600, pnlKrw: null });
  assert.ok(!out.includes('('), out);
  assert.match(out, /\+12bps/);
});

test('formatExitAlert: 보유 시간을 사람이 읽는 단위로 쓴다', () => {
  const m = formatExitAlert({ symbol: 'A', outcome: 'take_profit', returnBps: 1, holdSec: 252 });
  assert.match(m, /보유 4분 12초/);
  const s = formatExitAlert({ symbol: 'A', outcome: 'take_profit', returnBps: 1, holdSec: 45 });
  assert.match(s, /보유 45초/);
  const h = formatExitAlert({ symbol: 'A', outcome: 'take_profit', returnBps: 1, holdSec: 3723 });
  assert.match(h, /보유 1시간 2분/);
  const exact = formatExitAlert({ symbol: 'A', outcome: 'take_profit', returnBps: 1, holdSec: 300 });
  assert.match(exact, /보유 5분$/);
});

test('formatExitAlert: 알 수 없는 청산 사유는 지어내지 않고 그대로 보여준다', () => {
  const out = formatExitAlert({ symbol: 'A', outcome: '거래소 점검', returnBps: -5, holdSec: 30 });
  assert.match(out, /거래소 점검/);
});

test('formatExitAlert: 수익률이 없으면 손익금 부호로 방향을 판정한다', () => {
  const out = formatExitAlert({ symbol: 'A', outcome: 'manual', returnBps: null, pnlKrw: -300 });
  assert.ok(out.startsWith('❌'), out);
  assert.ok(!out.includes('bps'), out);
});

// ---- formatHaltAlert ----

test('formatHaltAlert: 🛑와 사유를 낸다', () => {
  const out = formatHaltAlert({ reason: '일일 손실 한도 -300bps 도달' });
  assert.ok(out.startsWith('🛑'), out);
  assert.match(out, /매매 중단/);
  assert.match(out, /일일 손실 한도 -300bps 도달/);
});

test('formatHaltAlert: 사유가 없어도 던지지 않는다', () => {
  // 중단 알림은 가장 중요한 알림이다. 사유를 못 채웠다고 알림 자체를 못 보내면
  // 최악의 순간에 침묵한다. 대신 "미상"이라고 밝힌다.
  const out = formatHaltAlert({});
  assert.ok(out.startsWith('🛑'), out);
  assert.match(out, /미상/);
});

// M6 재현: 포맷 함수 중 formatHaltAlert만 임의 문자열을 그대로 통과시킨다.
// 중단 사유는 event-trader.js에서 `청산 실패 ${symbol}: ${err.message}`로 조립되는데,
// 그 err가 요청 URL을 message에 담고 있으면 경로의 /bot<token>/이 알림과 로그에 남는다.
test('formatHaltAlert: 사유에 섞여 들어온 봇 토큰은 출력되지 않는다', () => {
  const leaky = `청산 실패 NEXO: request to https://api.telegram.org/bot${FAKE_TOKEN}/sendMessage failed`;
  const out = formatHaltAlert({ reason: leaky });
  assert.ok(!out.includes(FAKE_TOKEN), `토큰 유출: ${out}`);
  assert.ok(!out.includes('AAH-fake'), `토큰 유출: ${out}`);
  // 알림 자체는 반드시 나가야 한다 — 중단 알림에서 침묵이 가장 비싸다.
  assert.ok(out.startsWith('🛑'), out);
  assert.match(out, /청산 실패 NEXO/, out);
});

test('formatHaltAlert: 토큰 모양만 가리고 나머지 사유는 훼손하지 않는다', () => {
  const out = formatHaltAlert({ reason: '일일 손실 한도 -300bps 도달 (거래 12건, 09:37~14:02)' });
  assert.match(out, /일일 손실 한도 -300bps 도달 \(거래 12건, 09:37~14:02\)/, out);
});

test('알림 종류별 표식이 서로 겹치지 않는다', () => {
  const eventMarks = Object.values(MARKERS.event).flatMap((set) => Object.values(set));
  const otherMarks = [MARKERS.entry, MARKERS.win, MARKERS.loss, MARKERS.flat, MARKERS.halt];
  assert.equal(new Set(otherMarks).size, otherMarks.length, '진입·청산·중단 표식이 서로 달라야 한다');
  for (const m of eventMarks) {
    assert.ok(!otherMarks.includes(m), `재료 표식 ${m}이 다른 종류와 겹친다`);
  }
});

test('재료 표식은 방향(호재/악재)별로 하나도 겹치지 않는다', () => {
  // 겹치는 등급이 하나라도 있으면 그 등급에서 호재와 악재가 다시 구별되지 않는다.
  const bullish = new Set(Object.values(MARKERS.event.bullish));
  const bearish = new Set(Object.values(MARKERS.event.bearish));
  const neutral = new Set(Object.values(MARKERS.event.neutral));
  for (const m of bearish) assert.ok(!bullish.has(m), `악재 표식 ${m}이 호재와 겹친다`);
  for (const m of neutral) assert.ok(!bullish.has(m) && !bearish.has(m), `방향미상 표식 ${m}이 겹친다`);
});

// ---- buildSendUrl ----

test('buildSendUrl: bot<token>/<method> 형태를 만든다', () => {
  assert.equal(
    buildSendUrl(FAKE_TOKEN, 'sendMessage'),
    `https://api.telegram.org/bot${FAKE_TOKEN}/sendMessage`
  );
  assert.match(buildSendUrl(FAKE_TOKEN), /\/sendMessage$/, '메서드 기본값은 sendMessage');
});

test('buildSendUrl: 토큰이 비면 TypeError이고 메시지에 토큰이 없다', () => {
  // 이 단언은 한때 needle이 \u0000(NUL)으로 폴백해 **무조건 통과**했다.
  // 어떤 문자열도 NUL을 포함하지 않으므로, 구현이 토큰을 통째로 찍어도 초록이었다.
  // 그래서 needle을 폴백시키지 않고, 값이 실제로 있을 때만 포함 여부를 묻는다.
  const bads = ['', '   ', null, undefined, 123, FAKE_TOKEN.replace(':', ' '), '123:abc?x', '\t\n'];
  for (const bad of bads) {
    assert.throws(
      () => buildSendUrl(bad, 'sendMessage'),
      (err) => {
        assert.ok(err instanceof TypeError, `${String(bad)}: ${err}`);
        const needle = String(bad).trim();
        // 값이 비어 있으면 "포함되지 않았는지"를 물을 대상 자체가 없다 —
        // 그때는 대신 값을 통째로 직렬화해 넣지 않았는지를 묻는다.
        if (needle) {
          assert.ok(!err.message.includes(needle), `토큰 유출: ${err.message}`);
        }
        assert.ok(!err.message.includes(String(JSON.stringify(bad))), `직렬화된 토큰 유출: ${err.message}`);
        // 값을 감췄다는 사실을 메시지가 스스로 밝혀야 나중에 누가 "왜 값이 없지" 하며
        // 되살리지 않는다.
        assert.match(err.message, /로그에 남기지 않습니다/);
        return true;
      }
    );
  }
});

test('buildSendUrl: 토큰에 URL 구분자가 있으면 거부하고, 에러에 토큰을 넣지 않는다', () => {
  // 토큰에 슬래시가 섞이면 경로가 갈라져 엉뚱한 메서드가 호출된다.
  const sneaky = '123:abc/deleteWebhook';
  assert.throws(
    () => buildSendUrl(sneaky, 'sendMessage'),
    (err) => {
      assert.ok(!err.message.includes(sneaky), `에러에 토큰이 들어갔다: ${err.message}`);
      assert.ok(!err.message.includes('abc'), err.message);
      return true;
    }
  );
});

test('buildSendUrl: 메서드 이름이 올바르지 않으면 TypeError', () => {
  assert.throws(() => buildSendUrl(FAKE_TOKEN, '../getMe'), TypeError);
  assert.throws(() => buildSendUrl(FAKE_TOKEN, ''), TypeError);
});

// ---- sendMessage ----

test('sendMessage: chat_id·text를 POST하고 parse_mode는 기본으로 넣지 않는다', async () => {
  // parse_mode를 붙이면 거래소 제목의 `_`·`[`·백틱이 그대로 400을 만든다.
  // 평문이 기본값이어야 한다.
  const impl = stubFetch(() => okResponse());
  await sendMessage({ token: FAKE_TOKEN, chatId: -1001234, text: '💰 진입 NEXO', fetchImpl: impl });

  assert.equal(impl.calls.length, 1);
  const { url, init } = impl.calls[0];
  assert.equal(url, `https://api.telegram.org/bot${FAKE_TOKEN}/sendMessage`);
  assert.equal(init.method, 'POST');
  const body = JSON.parse(init.body);
  assert.equal(body.chat_id, -1001234);
  assert.equal(body.text, '💰 진입 NEXO');
  assert.ok(!('parse_mode' in body), `평문이어야 한다: ${init.body}`);
});

test('sendMessage: 성공하면 텔레그램 result를 돌려준다', async () => {
  const impl = stubFetch(() => okResponse({ ok: true, result: { message_id: 42 } }));
  const res = await sendMessage({ token: FAKE_TOKEN, chatId: 1, text: 'hi', fetchImpl: impl });
  assert.deepEqual(res, { message_id: 42 });
});

// 이 두 테스트의 스텁 본문이 무해하면 "오류 본문을 message에 붙이는" 변이를 못 잡는다.
// **실제 위협은 텔레그램이 아니라 앞단 프록시(게이트웨이·WAF·사내 아웃바운드 프록시)다.**
// 그런 중계기는 오류 본문에 요청 URL을 그대로 되돌려주는데, 텔레그램 URL은 경로에
// 봇 토큰이 박혀 있다(/bot<토큰>/sendMessage). 본문을 message에 붙이는 순간 토큰이
// 로그·알림·에러 리포터로 통째로 흘러나가고, 그 토큰이면 누구든 봇을 조종할 수 있다.
// 그래서 스텁 본문에 위협 그대로 토큰이 든 URL을 심어 둔다.
const leakyProxyBody = (errorCode, extra = {}) => ({
  ok: false,
  error_code: errorCode,
  description:
    `Bad Gateway: upstream request https://api.telegram.org/bot${FAKE_TOKEN}/sendMessage failed`,
  ...extra,
});

test('sendMessage: HTTP 오류 메시지에 토큰도 URL도 들어가지 않는다', async () => {
  const impl = stubFetch(() => ({ ok: false, status: 400, json: async () => leakyProxyBody(400) }));
  await assert.rejects(
    () => sendMessage({ token: FAKE_TOKEN, chatId: 1, text: 'hi', fetchImpl: impl }),
    (err) => {
      assert.ok(!err.message.includes(FAKE_TOKEN), `토큰 유출: ${err.message}`);
      assert.ok(!err.message.includes('api.telegram.org'), `URL 유출: ${err.message}`);
      assert.match(err.message, /400/);
      assert.match(err.message, /sendMessage/);
      return true;
    }
  );
});

// M7 재현: 429는 "얼마나 기다려라"까지 알려주는데(본문 parameters.retry_after),
// !res.ok에서 본문을 아예 읽지 않아 그 숫자가 호출부에 도달하지 못한다.
// 호출부는 눈을 감고 재시도하게 되고, 그러면 rate limit이 더 길어진다.
test('sendMessage: 429면 retry_after를 에러에 실어 준다', async () => {
  const impl = stubFetch(() => ({
    ok: false,
    status: 429,
    json: async () => leakyProxyBody(429, { parameters: { retry_after: 17 } }),
  }));
  await assert.rejects(
    () => sendMessage({ token: FAKE_TOKEN, chatId: 1, text: 'hi', fetchImpl: impl }),
    (err) => {
      assert.equal(err.status, 429);
      assert.equal(err.retryAfter, 17, `백오프 초를 못 전달했다: ${err.retryAfter}`);
      // 본문을 읽더라도 메시지에 붙이면 안 된다 — 프록시가 되돌려주는 URL로 토큰이 샌다.
      assert.ok(!err.message.includes(FAKE_TOKEN), `토큰 유출: ${err.message}`);
      assert.ok(!err.message.includes('api.telegram.org'), `URL 유출: ${err.message}`);
      return true;
    }
  );
});

test('sendMessage: HTTP 200인데 ok:false여도 retry_after를 실어 준다', async () => {
  // 텔레그램은 거부를 HTTP 오류로만 돌려주지 않는다 — **200에 ok:false**로 오는 경로가
  // 따로 있고, rate limit도 그렇게 올 수 있다. !res.ok 경로에서만 백오프를 챙기면
  // 이쪽 호출부는 기다릴 초를 못 받아 눈을 감고 즉시 재시도하고, 밴이 더 길어진다.
  // 이 경로에는 테스트가 아예 없어서 attachRetryAfter를 지워도 초록이었다.
  const impl = stubFetch(() => okResponse(leakyProxyBody(429, { parameters: { retry_after: 23 } })));
  await assert.rejects(
    () => sendMessage({ token: FAKE_TOKEN, chatId: 1, text: 'hi', fetchImpl: impl }),
    (err) => {
      assert.equal(err.status, 200, 'HTTP는 성공인데 본문이 거부인 경로다');
      assert.equal(err.retryAfter, 23, `백오프 초를 못 전달했다: ${err.retryAfter}`);
      assert.match(err.message, /429/, '거부 코드는 남긴다');
      // 이 경로도 본문을 message에 붙이면 안 된다 — 같은 프록시 유출 위협이 걸린다.
      assert.ok(!err.message.includes(FAKE_TOKEN), `토큰 유출: ${err.message}`);
      assert.ok(!err.message.includes('api.telegram.org'), `URL 유출: ${err.message}`);
      return true;
    }
  );
});

test('sendMessage: retry_after가 없으면 숫자를 지어내지 않는다', async () => {
  // 0으로 위장하면 호출부가 "지금 바로 재시도해도 된다"로 읽는다.
  const impl = stubFetch(() => ({ ok: false, status: 500, json: async () => ({ ok: false, error_code: 500 }) }));
  await assert.rejects(
    () => sendMessage({ token: FAKE_TOKEN, chatId: 1, text: 'hi', fetchImpl: impl }),
    (err) => {
      assert.equal(err.retryAfter, undefined, `없는 값을 지어냈다: ${err.retryAfter}`);
      return true;
    }
  );
});

test('sendMessage: 오류 본문을 못 읽어도 에러 자체는 그대로 던진다', async () => {
  // 텔레그램 앞단의 프록시는 429에 HTML을 돌려주기도 한다. 본문 파싱 실패가
  // 전송 실패 보고 자체를 삼키면 호출부는 성공으로 오해한다.
  const impl = stubFetch(() => ({
    ok: false,
    status: 502,
    json: async () => {
      throw new SyntaxError('Unexpected token < in JSON');
    },
  }));
  await assert.rejects(
    () => sendMessage({ token: FAKE_TOKEN, chatId: 1, text: 'hi', fetchImpl: impl }),
    (err) => {
      assert.match(err.message, /502/);
      assert.equal(err.status, 502);
      assert.ok(!(err instanceof SyntaxError), '본문 파싱 에러가 전송 에러를 덮었다');
      return true;
    }
  );
});

test('sendMessage: fetch가 URL이 든 에러로 거부해도 토큰이 새지 않는다', async () => {
  // 실제로 Node의 fetch 실패 에러 message에는 요청 URL이 통째로 들어간다.
  // 그대로 다시 던지거나 cause로 매달면, 그 에러를 찍는 순간 토큰이 로그에 남는다.
  const leaky = new Error(`request to https://api.telegram.org/bot${FAKE_TOKEN}/sendMessage failed`);
  leaky.code = 'ECONNREFUSED';
  const impl = stubFetch(() => {
    throw leaky;
  });

  await assert.rejects(
    () => sendMessage({ token: FAKE_TOKEN, chatId: 1, text: 'hi', fetchImpl: impl }),
    (err) => {
      const dump = `${err.message}|${err.stack}|${JSON.stringify(err.cause ?? null)}|${err.cause?.message ?? ''}`;
      assert.ok(!dump.includes(FAKE_TOKEN), `토큰 유출: ${dump}`);
      assert.equal(err.cause, undefined, 'cause를 매달면 토큰이 딸려온다');
      assert.equal(err.code, 'ECONNREFUSED', '원인 코드는 안전하므로 남긴다');
      return true;
    }
  );
});

test('sendMessage: 4096자를 넘는 텍스트를 잘라서 보낸다', async () => {
  // 초과하면 텔레그램이 400을 돌려주고 알림이 통째로 사라진다.
  // 잘린 사실은 표시하되, 알림 자체는 반드시 나가야 한다.
  const impl = stubFetch(() => okResponse());
  await sendMessage({ token: FAKE_TOKEN, chatId: 1, text: '가'.repeat(5000), fetchImpl: impl });
  const body = JSON.parse(impl.calls[0].init.body);
  assert.ok(body.text.length <= 4096, `길이 ${body.text.length}`);
  assert.match(body.text, /잘림/);
});

test('sendMessage: 자르는 자리가 이모지 한가운데여도 깨진 문자를 남기지 않는다', async () => {
  // 위 테스트는 '가'만 5000자라 절단면이 절대 서로게이트 쌍에 걸리지 않는다.
  // 그런데 이 알림의 첫 글자부터가 이모지고(🔥/🚨), 본문에도 이모지가 섞인다.
  // 자바스크립트 문자열 길이는 UTF-16 코드 단위라, slice가 이모지(서로게이트 쌍)
  // 한가운데를 자르면 짝 없는 반쪽이 남는다. 그 반쪽은 UTF-8로 직렬화될 때
  // U+FFFD로 뭉개지고, 텔레그램은 잘못된 UTF-8에 400을 돌려줘 알림이 통째로 사라진다.
  // 4096자 제한을 지키려다 알림을 잃는 셈이다.

  // 접미사 '…(잘림)'이 5자이므로 절단 인덱스는 4091이다. 이모지를 정확히 4090에 두면
  // 절단면이 쌍의 한가운데를 지난다.
  const CUT = 4096 - '…(잘림)'.length;
  const text = '가'.repeat(CUT - 1) + '🔥' + 'x'.repeat(1000);
  assert.equal(text.charCodeAt(CUT - 1), 0xd83d, '이모지가 절단면에 걸려 있어야 하는 입력이다');

  const impl = stubFetch(() => okResponse());
  await sendMessage({ token: FAKE_TOKEN, chatId: 1, text, fetchImpl: impl });
  const out = JSON.parse(impl.calls[0].init.body).text;

  assert.ok(out.length <= 4096, `길이 ${out.length}`);
  assert.match(out, /잘림/);
  // 짝 없는 상위/하위 서로게이트가 남아 있으면 안 된다.
  assert.doesNotMatch(out, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/,
    '이모지의 앞쪽 반이 짝 없이 남았다');
  assert.doesNotMatch(out, /(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/,
    '이모지의 뒤쪽 반이 짝 없이 남았다');
  // 실제로 전선에 나가는 형태로 확인한다 — UTF-8 왕복에서 변형되면 깨진 문자가 있다는 뜻이다.
  assert.equal(Buffer.from(out, 'utf8').toString('utf8'), out,
    'UTF-8로 내보내면 U+FFFD로 뭉개지는 반쪽 문자가 남아 있다');

  // 반대 방향도 함께 막아야 한다. 이모지가 절단면에 **딱 맞게 끝나면** 쌍이 온전하므로
  // 그대로 둬야 하는데, 검사 범위를 하위 서로게이트까지 넓히면 멀쩡한 쌍의 뒤쪽 반을
  // 잘라내 이번엔 앞쪽 반이 홀로 남는다 — 고치려던 것과 똑같은 깨짐을 만든다.
  const exact = '가'.repeat(CUT - 2) + '🔥' + 'x'.repeat(1000);
  assert.equal(exact.charCodeAt(CUT - 1), 0xdd25, '이모지가 절단면에서 끝나는 입력이다');

  const impl2 = stubFetch(() => okResponse());
  await sendMessage({ token: FAKE_TOKEN, chatId: 1, text: exact, fetchImpl: impl2 });
  const out2 = JSON.parse(impl2.calls[0].init.body).text;

  assert.ok(out2.includes('🔥'), '절단면에 딱 맞게 들어간 이모지를 온전히 남겨야 한다');
  assert.equal(Buffer.from(out2, 'utf8').toString('utf8'), out2,
    '온전한 쌍을 잘라내 반쪽을 남겼다');
});

test('sendMessage: text나 chatId가 비면 전송 시도조차 하지 않는다', async () => {
  const impl = stubFetch(() => okResponse());
  await assert.rejects(() => sendMessage({ token: FAKE_TOKEN, chatId: 1, text: '', fetchImpl: impl }), TypeError);
  await assert.rejects(() => sendMessage({ token: FAKE_TOKEN, chatId: null, text: 'hi', fetchImpl: impl }), TypeError);
  assert.equal(impl.calls.length, 0);
});

test('sendMessage: 지원하지 않는 parseMode는 거부한다', async () => {
  const impl = stubFetch(() => okResponse());
  await assert.rejects(
    () => sendMessage({ token: FAKE_TOKEN, chatId: 1, text: 'hi', parseMode: 'Markdown', fetchImpl: impl }),
    TypeError
  );
  assert.equal(impl.calls.length, 0);
});
