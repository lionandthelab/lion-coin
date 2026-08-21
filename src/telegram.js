'use strict';

// 텔레그램 알림 — 포맷(순수)과 전송(네트워크)을 분리한다.
//
// 이 모듈이 존재하는 이유는 **판단을 옮기기 위해서가 아니라, 판단할 시간을 벌기 위해서다.**
// 재료 매매에서 알림이 도착하는 순간 사람이 할 수 있는 일은 "지금 화면을 볼 것인가"를
// 정하는 것뿐이다. 그래서 모든 메시지는 잠금화면에 잘려 보이는 **첫 줄만으로**
// 종류·방향·크기가 드러나야 한다. 두 번째 줄부터는 이유다.
//
// ── 보안: 봇 토큰 ──────────────────────────────────────────────────────────
// 텔레그램 봇 토큰은 URL 경로에 들어간다(`/bot<token>/sendMessage`). 즉 **요청 URL
// 자체가 비밀**이다. 그런데 fetch가 실패할 때 던지는 에러의 message에는 요청 URL이
// 통째로 들어간다. 그 에러를 그대로 다시 던지거나 `{ cause }`로 매달아 두면,
// 나중에 누가 `console.error(err)` 한 줄을 찍는 순간 토큰이 로그 파일에 영구히 남는다.
// 토큰은 사람이 취소하기 전까지 유효하므로 이건 되돌릴 수 없는 사고다.
//
// 그래서 이 모듈은:
//   1) 포맷 함수는 토큰을 받지도 않는다 — 아는 필드만 읽으므로 설정 객체를 통째로
//      넘겨도 토큰이 본문에 섞일 수 없다.
//   2) 전송 실패 시 원본 에러를 버리고 **HTTP 상태와 method만** 담아 새로 던진다.
//      cause도 매달지 않는다. 대신 code(ECONNREFUSED 같은)만 옮긴다.
//   3) 토큰 검증 에러 메시지에도 토큰 값을 넣지 않는다.
//
// ── parse_mode를 쓰지 않는 이유 ────────────────────────────────────────────
// 메시지 본문의 대부분은 거래소 공지 제목이고, 거기엔 `_`, `*`, `[`, 백틱이 실제로
// 들어온다("AAA_BBB *특별* [이벤트]"). Markdown으로 보내면 텔레그램이 400을 돌려주고
// **알림이 통째로 사라진다** — 가장 중요한 순간에 침묵하는 실패다. 이스케이프도
// 가능하지만, 백슬래시가 낀 제목은 사람이 읽기 나빠지고 MarkdownV2의 이스케이프
// 대상 집합은 텔레그램이 바꿔 왔다. 알림에 굵은 글씨가 주는 이득보다 400 한 번의
// 손해가 훨씬 크므로 **평문으로 보낸다**. 이모지가 서식의 역할을 대신한다.

const TELEGRAM_API_BASE = 'https://api.telegram.org';

// 텔레그램 단일 메시지 길이 상한. 넘기면 400이다.
const TEXT_LIMIT = 4096;
const TRUNCATED_SUFFIX = '…(잘림)';

// 지원 parse_mode 화이트리스트. 기본은 null(평문)이며, 넘기는 쪽이 위험을 진다.
const PARSE_MODES = ['MarkdownV2', 'HTML'];

// 알림 종류를 첫 글자로 구분하기 위한 표식. 재료 알림은 급에 따라 달라지지만
// 진입·청산·중단 표식과는 절대 겹치지 않는다 — 겹치면 첫 글자로 종류를 못 가른다.
const MARKERS = Object.freeze({
  event: Object.freeze({ S: '🔥', A: '⚡', B: '📌', C: '💤', unknown: '📌' }),
  entry: '💰',
  win: '✅',
  loss: '❌',
  flat: '➖',
  halt: '🛑',
});

const OUTCOME_LABELS = Object.freeze({
  take_profit: '익절 도달',
  tp: '익절 도달',
  stop_loss: '손절 도달',
  sl: '손절 도달',
  timeout: '시간 초과',
  max_hold: '시간 초과',
  manual: '수동 청산',
  halt: '중단 청산',
});

// ── 숫자·시각 포맷 (순수) ──────────────────────────────────────────────────

// toLocaleString은 실행 환경의 ICU 빌드에 따라 결과가 달라진다. 알림 문구가
// 서버마다 달라지면 테스트로 못박을 수 없으므로 구분자를 직접 넣는다.
function group(intStr) {
  return intStr.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

// 원화 표기. 원화 마켓에는 0.4521원짜리 종목이 실제로 있어서 무조건 정수로
// 반올림하면 진입가가 "0원"이 된다 — 알림이 거짓말을 하게 된다. 그래서 100원
// 미만은 소수점을 살린다.
function formatKrw(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const sign = value < 0 ? '-' : '';
  const abs = Math.abs(value);
  if (abs >= 100) return `${sign}${group(String(Math.round(abs)))}원`;
  const trimmed = String(Number(abs.toFixed(4)));
  const [int, frac] = trimmed.split('.');
  return `${sign}${group(int)}${frac ? `.${frac}` : ''}원`;
}

function formatSignedKrw(value) {
  const body = formatKrw(value);
  if (body === null) return null;
  return value > 0 ? `+${body}` : body;
}

// bps는 이 저장소의 공용 단위다. 소수 둘째 자리부터는 체결 잡음이라 버린다.
function formatBps(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const rounded = Math.round(value * 10) / 10;
  const sign = rounded > 0 ? '+' : rounded < 0 ? '-' : '';
  const abs = Math.abs(rounded);
  return `${sign}${Number.isInteger(abs) ? abs : abs.toFixed(1)}bps`;
}

// 보유 시간. "252초"는 사람이 못 읽는다.
function formatHold(seconds) {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) return null;
  const total = Math.round(seconds);
  if (total < 60) return `${total}초`;
  if (total < 3600) {
    const m = Math.floor(total / 60);
    const s = total % 60;
    return s ? `${m}분 ${s}초` : `${m}분`;
  }
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  return m ? `${h}시간 ${m}분` : `${h}시간`;
}

// 공지 시각을 KST 시:분:초로.
//
// 중요: 거래소 공지 타임스탬프는 이미 KST다("2026-08-21 19:00:00", "...+09:00").
// 이걸 Date로 되돌린 뒤 실행 환경의 시간대로 다시 찍으면, 서버가 UTC면 9시간이 밀린다.
// 공지 시각이 9시간 틀리면 "방금 뜬 재료"와 "어제 재료"를 구분할 수 없어 알림이
// 무의미해진다. 그래서 **이미 KST로 적혀 있으면 문자열을 그대로 읽고**, 다른
// 시간대(Z 등)나 epoch일 때만 +9시간으로 변환한다.
function formatKstTime(at) {
  if (at === null || at === undefined) return null;

  if (at instanceof Date || typeof at === 'number') {
    const ms = at instanceof Date ? at.getTime() : at;
    if (!Number.isFinite(ms)) return null;
    return new Date(ms + 9 * 3600 * 1000).toISOString().slice(11, 19);
  }

  if (typeof at !== 'string') return null;
  const m = at.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}:\d{2}:\d{2})(?:\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/);
  if (!m) return null;

  const [, , , , hms, offset] = m;
  // 오프셋이 없거나 +09:00이면 원문이 이미 KST다 — 손대지 않는다.
  if (!offset || offset === '+09:00' || offset === '+0900') return hms;

  const ms = Date.parse(at);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms + 9 * 3600 * 1000).toISOString().slice(11, 19);
}

// ── 포맷 함수 ──────────────────────────────────────────────────────────────
//
// 아래 함수들은 인자 객체에서 **아는 필드만** 읽는다. 호출부가 설정 객체를 통째로
// 넘겨도 토큰·API 키가 본문에 섞일 수 없게 하기 위한 의도적인 제약이다.

function pickTitle(event) {
  const title = event && typeof event.title === 'string' ? event.title.trim() : '';
  if (!title) {
    throw new TypeError('알림에 넣을 재료 제목(event.title)이 없습니다');
  }
  return title;
}

// 빗썸·업비트 원본 페이로드의 필드명이 서로 다르고 아직 정규화 계층이 없다.
// 원본을 그대로 넘겨도 동작하도록 최소한의 대체 필드만 본다.
const pickAt = (e) => e.at ?? e.publishedAt ?? e.published_at ?? e.listedAt ?? e.listed_at ?? null;
const pickUrl = (e) => (typeof (e.url ?? e.pc_url) === 'string' ? (e.url ?? e.pc_url) : null);

function gradeLabel(material) {
  const grade = material && typeof material.grade === 'string' ? material.grade.trim().toUpperCase() : '';
  const kind = material && typeof material.kind === 'string' && material.kind.trim() ? material.kind.trim() : '재료';
  // 등급 분류에 실패했다고 알림을 막지 않는다 — 분류기가 모르는 재료가 제일 클 수도 있다.
  // 다만 모른다는 사실은 숨기지 않는다.
  const marker = MARKERS.event[grade] ?? MARKERS.event.unknown;
  return { marker, label: grade ? `${grade}급 ${kind}` : `등급미상 ${kind}` };
}

function formatEventAlert({ event, material } = {}) {
  const e = event && typeof event === 'object' ? event : {};
  const title = pickTitle(e);
  const { marker, label } = gradeLabel(material);

  const symbol = typeof e.symbol === 'string' && e.symbol.trim() ? e.symbol.trim().toUpperCase() : null;
  const lines = [`${marker} [${label}]${symbol ? ` ${symbol}` : ''}`, title];

  const source = typeof e.source === 'string' && e.source.trim() ? e.source.trim() : null;
  const time = formatKstTime(pickAt(e));
  // 출처도 시각도 없으면 줄을 만들지 않는다. 빈 값을 채워 넣으면 "확인된 것"처럼 보인다.
  if (source || time) lines.push(`출처: ${[source, time].filter(Boolean).join(' · ')}`);

  const url = pickUrl(e);
  if (url) lines.push(url); // 휴대폰에서 원문으로 바로 넘어갈 수 있어야 한다

  return lines.join('\n');
}

// 익절·손절 폭을 bps로 정리한다. planBracket은 bps가 아니라 가격을 돌려주므로
// 그 출력을 그대로 넘겨도 동작하도록 가격에서 역산한다.
function planBpsPair(plan, entryPrice) {
  const fromPrice = (price) =>
    typeof price === 'number' && Number.isFinite(price) && price > 0
      ? ((price - entryPrice) / entryPrice) * 10000
      : null;

  const tp =
    typeof plan.takeProfitBps === 'number' && Number.isFinite(plan.takeProfitBps)
      ? Math.abs(plan.takeProfitBps)
      : fromPrice(plan.takeProfitPrice);

  const slRaw =
    typeof plan.stopLossBps === 'number' && Number.isFinite(plan.stopLossBps)
      ? plan.stopLossBps
      : fromPrice(plan.stopLossPrice);
  // 저장소 관례상 stopLossBps는 양수로 들고 다닌다. 화면에서까지 양수면 방향을
  // 오독하므로 표시할 때는 항상 음수로 뒤집는다.
  const sl = slRaw === null ? null : -Math.abs(slRaw);

  return { tp, sl };
}

// 모의 매매 표시. 종류 표식(첫 글자)은 그대로 두고 첫 줄 끝에 붙인다 —
// 모의와 실거래 알림이 똑같이 생기면 종이 체결을 실제 체결로 읽거나 그 반대가 된다.
// 기본값은 "표시 없음 = 실거래"다. 플래그를 안 넘긴 쪽이 실거래로 보이는 편이,
// 실제로 돈이 나가는 중인데 모의로 보이는 것보다 덜 위험하다.
const simulatedSuffix = (simulated) => (simulated === true ? ' · 🧪모의' : '');

function formatEntryAlert({ symbol, plan, event, material, simulated } = {}) {
  const p = plan && typeof plan === 'object' ? plan : null;
  if (!p || typeof p.entryPrice !== 'number' || !Number.isFinite(p.entryPrice) || p.entryPrice <= 0) {
    throw new TypeError('진입 알림에는 양수 plan.entryPrice가 필요합니다');
  }

  const sym = typeof symbol === 'string' && symbol.trim() ? symbol.trim().toUpperCase() : null;
  const notional =
    typeof p.notional === 'number' && Number.isFinite(p.notional)
      ? p.notional
      : typeof p.quantity === 'number' && Number.isFinite(p.quantity)
        ? p.quantity * p.entryPrice
        : null;

  const lines = [`${MARKERS.entry} 진입${sym ? ` ${sym}` : ''}${simulatedSuffix(simulated)}`];

  // 얼마를 걸었는지가 먼저다 — 가격보다 금액이 위험의 크기다.
  const money = formatKrw(notional);
  lines.push(`${money ? `${money} @ ` : ''}${formatKrw(p.entryPrice)}`);

  const { tp, sl } = planBpsPair(p, p.entryPrice);
  const parts = [];
  if (tp !== null) parts.push(`익절 ${formatBps(tp)}`);
  if (sl !== null) parts.push(`손절 ${formatBps(sl)}`);
  const hold = formatHold(p.maxHoldSec);
  if (hold) parts.push(`최대 ${hold}`);
  if (parts.length) lines.push(parts.join(' / '));

  // 왜 들어갔는지를 한 줄로. 나중에 로그를 되짚을 때 이 줄이 전부다.
  const e = event && typeof event === 'object' ? event : null;
  const title = e && typeof e.title === 'string' && e.title.trim() ? e.title.trim() : null;
  if (material && typeof material === 'object' && title) {
    const { marker, label } = gradeLabel(material);
    lines.push(`${marker} ${label} · ${title}`);
  }

  return lines.join('\n');
}

function formatExitAlert({ symbol, outcome, returnBps, holdSec, pnlKrw, simulated } = {}) {
  const bps = typeof returnBps === 'number' && Number.isFinite(returnBps) ? returnBps : null;
  const pnl = typeof pnlKrw === 'number' && Number.isFinite(pnlKrw) ? pnlKrw : null;

  // 방향은 수익률로 판정하되, 없으면 손익금으로 대신한다. 둘 다 없으면 모른다(➖).
  const direction = bps ?? pnl ?? 0;
  const marker = direction > 0 ? MARKERS.win : direction < 0 ? MARKERS.loss : MARKERS.flat;

  const sym = typeof symbol === 'string' && symbol.trim() ? symbol.trim().toUpperCase() : null;
  const head = [`${marker} 청산${sym ? ` ${sym}` : ''}`];
  if (bps !== null) head.push(formatBps(bps));
  if (pnl !== null) head.push(`(${formatSignedKrw(pnl)})`);

  const lines = [`${head.join(' ')}${simulatedSuffix(simulated)}`];

  // 아는 사유는 다듬어 보여주고, 모르는 값은 지어내지 않고 그대로 보여준다.
  const key = typeof outcome === 'string' ? outcome.trim() : '';
  const label = key ? (OUTCOME_LABELS[key] ?? key) : null;
  const hold = formatHold(holdSec);
  const second = [label, hold ? `보유 ${hold}` : null].filter(Boolean);
  if (second.length) lines.push(second.join(' · '));

  return lines.join('\n');
}

function formatHaltAlert({ reason } = {}) {
  // 중단 알림은 가장 중요한 알림이다. 사유를 못 채웠다고 던져서 알림을 막으면
  // 최악의 순간에 침묵한다. 대신 모른다는 사실을 그대로 적는다.
  const text = typeof reason === 'string' && reason.trim() ? reason.trim() : '(미상)';
  return `${MARKERS.halt} 매매 중단\n사유: ${text}`;
}

// ── 전송 (네트워크) ────────────────────────────────────────────────────────

function buildSendUrl(token, method = 'sendMessage', baseUrl = TELEGRAM_API_BASE) {
  // 아래 에러 메시지들에는 토큰 값을 절대 넣지 않는다 — 검증 실패 로그가
  // 토큰 유출 경로가 되는 것이 이 모듈에서 제일 흔한 사고다.
  if (typeof token !== 'string' || token.trim() === '') {
    throw new TypeError('텔레그램 봇 토큰이 비어 있습니다 (값은 로그에 남기지 않습니다)');
  }
  // 토큰에 슬래시·물음표·공백이 섞이면 경로가 갈라져 의도하지 않은 메서드가 호출된다.
  if (/[\s/?#]/.test(token)) {
    throw new TypeError('텔레그램 봇 토큰에 URL로 쓸 수 없는 문자가 있습니다 (값은 로그에 남기지 않습니다)');
  }
  if (typeof method !== 'string' || !/^[A-Za-z][A-Za-z0-9]*$/.test(method)) {
    throw new TypeError(`텔레그램 메서드 이름이 올바르지 않습니다: ${JSON.stringify(method)}`);
  }
  return `${baseUrl.replace(/\/+$/, '')}/bot${token}/${method}`;
}

// 4096자를 넘으면 텔레그램이 400을 돌려주고 알림이 통째로 사라진다. 잘라서라도
// 보내는 편이 낫다 — 다만 잘렸다는 사실은 본문에 남긴다.
function clampText(text) {
  if (text.length <= TEXT_LIMIT) return text;
  let cut = text.slice(0, TEXT_LIMIT - TRUNCATED_SUFFIX.length);
  // 이모지(서로게이트 쌍) 한가운데를 자르면 깨진 문자가 남는다.
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  return cut + TRUNCATED_SUFFIX;
}

// 얇은 fetch 래퍼. 순수 로직을 테스트 가능하게 두기 위해 fetchImpl을 주입받는다.
async function sendMessage({
  token,
  chatId,
  text,
  parseMode = null,
  fetchImpl = fetch,
  baseUrl = TELEGRAM_API_BASE,
} = {}) {
  const method = 'sendMessage';

  if (typeof text !== 'string' || text.trim() === '') {
    throw new TypeError('보낼 텍스트가 비어 있습니다');
  }
  if (!(typeof chatId === 'number' && Number.isFinite(chatId)) && !(typeof chatId === 'string' && chatId.trim())) {
    throw new TypeError('chatId는 숫자이거나 비어 있지 않은 문자열이어야 합니다');
  }
  if (parseMode !== null && parseMode !== undefined && !PARSE_MODES.includes(parseMode)) {
    throw new TypeError(`지원하지 않는 parseMode입니다: ${JSON.stringify(parseMode)} (가능: ${PARSE_MODES.join(', ')})`);
  }

  const url = buildSendUrl(token, method, baseUrl);
  const body = {
    chat_id: chatId,
    text: clampText(text),
    // 공지 링크의 미리보기 카드가 알림을 덮으면 첫 줄을 읽는 데 방해가 된다.
    disable_web_page_preview: true,
  };
  // 기본은 평문이다(파일 상단 주석 참고). 넘어온 경우에만 붙인다.
  if (parseMode) body.parse_mode = parseMode;

  let res;
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (cause) {
    // ⚠ cause를 매달지 않는다. fetch 실패 에러의 message에는 요청 URL이 통째로
    // 들어 있고, 그 경로에 토큰이 박혀 있다. 안전한 code만 옮긴다.
    const err = new Error(`텔레그램 ${method} 요청 실패: 네트워크 오류`);
    if (typeof cause?.code === 'string') err.code = cause.code;
    throw err;
  }

  if (!res || typeof res.status !== 'number') {
    throw new Error(`텔레그램 ${method} 응답이 올바르지 않습니다`);
  }
  if (!res.ok) {
    // 상태와 method만 넣는다. 응답 본문을 붙이면 프록시가 URL을 되돌려줄 때 토큰이 샌다.
    const err = new Error(`텔레그램 ${method} 실패: HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }

  let json = null;
  try {
    json = await res.json();
  } catch {
    // 본문을 못 읽어도 전송 자체는 성공했다. 결과를 모른다는 뜻으로 null을 돌려준다.
    return null;
  }
  if (json && json.ok === false) {
    const err = new Error(`텔레그램 ${method} 거부: error_code ${json.error_code ?? '미상'}`);
    err.status = res.status;
    throw err;
  }
  return json?.result ?? null;
}

module.exports = {
  TELEGRAM_API_BASE,
  TEXT_LIMIT,
  MARKERS,
  formatEventAlert,
  formatEntryAlert,
  formatExitAlert,
  formatHaltAlert,
  buildSendUrl,
  sendMessage,
};
