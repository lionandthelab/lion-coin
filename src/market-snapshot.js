'use strict';

// 티커 목록 → 시황 입력. 순수 함수.
//
// **이 모듈의 유일한 규칙: 모르는 값을 그럴듯한 기본값으로 채우지 않는다.**
//
// event-plan.js의 assessMarketContext는 입력이 없으면 regime을 null로 돌려주고,
// planEventTrade는 regime이 null이면 계획을 만들지 않는다. 잘 설계된 사슬인데
// 호출자가 "BTC 변동을 못 읽으면 0, 시장폭을 못 읽으면 50"으로 채워 넘기면
// 그 사슬 전체가 무력화된다 — 0도 50도 완벽하게 중립적인 값이라 아무 가드에도
// 걸리지 않기 때문이다. 시황을 한 번도 못 읽어도 항상 neutral 계획이 만들어진다.
//
// 0과 null은 다르다. 0은 "변동이 없었다"는 확정된 관측이고, null은 관측 자체가
// 없다는 뜻이다. 이 저장소는 값 없음을 0으로 위장했다가 손절선이 0이 되는 사고를
// 이미 겪었다(src/event-engine.js의 entryPrice 주석).

// 시황이 이보다 오래됐으면 쓰지 않는다. 재료 매매의 시간 단위는 분인데
// 한 시간 전 국면으로 지금 재료의 크기를 조절하는 것은 모르는 것보다 나쁘다.
const MAX_CONTEXT_AGE_MS = 15 * 60 * 1000;

const finite = (v) => typeof v === 'number' && Number.isFinite(v);

function marketInputsFromTickers(tickers) {
  if (!Array.isArray(tickers) || !tickers.length) {
    return { btcChange24hBps: null, breadthPct: null };
  }

  const btc = tickers.find((m) => m && m.symbol === 'BTC');
  const btcChange24hBps = btc && finite(btc.changeRate) ? btc.changeRate * 10000 : null;

  // 변동률을 못 읽은 종목은 분모에서도 뺀다. 세지 못한 종목을 분모에만 넣으면
  // 하락으로 센 것과 같아져 시장폭이 조용히 낮게 나온다.
  const readable = tickers.filter((m) => m && finite(m.changeRate));
  const breadthPct = readable.length
    ? (readable.filter((m) => m.changeRate > 0).length / readable.length) * 100
    : null;

  return { btcChange24hBps, breadthPct };
}

// 이 시황으로 계획을 세워도 되는가. 나이와 판정 여부를 함께 본다.
function isContextUsable(context, { at, now, maxAgeMs = MAX_CONTEXT_AGE_MS } = {}) {
  if (!context || !context.regime) return false;
  if (!finite(at)) return false;          // 평가한 적이 없다
  return now - at <= maxAgeMs;
}

module.exports = { MAX_CONTEXT_AGE_MS, marketInputsFromTickers, isContextUsable };
