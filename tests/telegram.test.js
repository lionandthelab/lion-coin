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

const okResponse = (body = { ok: true, result: { message_id: 7 } }) => ({
  ok: true,
  status: 200,
  json: async () => body,
});

// ---- formatEventAlert ----

test('formatEventAlert: 첫 줄에 등급·종류·심볼이 오고 급별 이모지가 붙는다', () => {
  const out = formatEventAlert({
    event: { symbol: 'NEXO', title: REAL_TITLE, source: '업비트 공지', at: REAL_AT_KST },
    material: { grade: 'S', kind: '호재' },
  });
  const first = out.split('\n')[0];
  assert.ok(first.startsWith('🔥'), `첫 줄: ${first}`);
  assert.match(first, /\[S급 호재\]/);
  assert.match(first, /NEXO/);
});

test('formatEventAlert: 제목·출처·시각 줄을 만든다', () => {
  const out = formatEventAlert({
    event: { symbol: 'NEXO', title: REAL_TITLE, source: '업비트 공지', at: REAL_AT_KST },
    material: { grade: 'S', kind: '호재' },
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

test('formatEventAlert: 제목이 없으면 TypeError', () => {
  assert.throws(() => formatEventAlert({ event: { symbol: 'AAA' }, material: { grade: 'S' } }), TypeError);
  assert.throws(() => formatEventAlert({ material: { grade: 'S' } }), TypeError);
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

test('알림 종류별 표식이 서로 겹치지 않는다', () => {
  const eventMarks = Object.values(MARKERS.event);
  const otherMarks = [MARKERS.entry, MARKERS.win, MARKERS.loss, MARKERS.flat, MARKERS.halt];
  assert.equal(new Set(otherMarks).size, otherMarks.length, '진입·청산·중단 표식이 서로 달라야 한다');
  for (const m of eventMarks) {
    assert.ok(!otherMarks.includes(m), `재료 표식 ${m}이 다른 종류와 겹친다`);
  }
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
  for (const bad of ['', '   ', null, undefined, 123]) {
    assert.throws(
      () => buildSendUrl(bad, 'sendMessage'),
      (err) => {
        assert.ok(err instanceof TypeError);
        assert.ok(!String(err.message).includes(String(bad).trim() || ' '), err.message);
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

test('sendMessage: HTTP 오류 메시지에 토큰도 URL도 들어가지 않는다', async () => {
  const impl = stubFetch(() => ({ ok: false, status: 400, json: async () => ({ ok: false, error_code: 400 }) }));
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
