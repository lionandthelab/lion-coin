'use strict';

// 고유 하락 판정 — 순수 함수.
//
// **이 층 하나가 신호를 쓸 만한 것으로 바꾼다.** 검증된 반전 신호(거래량 급증 + 저가 이탈)는
// 조건 없이는 대조군 대비 우위가 +2.3bps(t=0.52)로 사실상 아무것도 아니다. 그런데
// "시장이 아니라 그 코인만 빠졌을 때"로 좁히면 +25bps가 된다 — 왕복 비용 8bps의 3배다.
//
// **왜 이게 선택 편의가 아니라고 보는가:** 여집합이 반대 부호이기 때문이다.
//
//   조건 없음        4567건  +2.3bps  (t=0.52)
//   그 코인만 빠짐   1356건  +25.3bps (t=2.35)
//   시장도 같이 빠짐 1962건  −8.2bps  (t=−1.46)   ← 반대 부호
//
// 부분집합이 좋아지는 것은 조합을 많이 시험하면 우연히도 나온다. 그러나 그 여집합이
// 반대 방향으로 가는 것은 메커니즘이 있어야 나온다. 여기서의 메커니즘은:
// **그 코인만 빠지면 유동성 사건(강제 매도·얇은 호가)이라 되돌아오고,
// 시장과 같이 빠지면 정보라 되돌아오지 않는다.**
//
// ⚠ 아직 검증 완료가 아니다. 확인 구간에서 t=1.99로 사전 등록한 문턱 2.0을 놓쳤다.
// 다만 확인이 탐색보다 나빠지지 않았고(+23.8 → +29.5) 시간 4분할 전 구간에서 순기대값이
// 양수라, 부호가 뒤집혔던 이전 실패들과는 다르다. 상세: docs/venue-and-data.md §8

// 그 봉의 시장 수익률 = 관측 가능한 전 종목 수익률의 평균.
// 한두 종목으로는 시장을 대표할 수 없으므로 최소 개수를 요구한다.
function marketReturn(bars, { minSymbols = 15 } = {}) {
  if (!Array.isArray(bars)) {
    throw new TypeError('bars는 배열이어야 합니다');
  }

  let sum = 0;
  let count = 0;
  for (const b of bars) {
    if (!b) continue;
    const { prevClose, close } = b;
    // 0이나 음수 가격이 섞이면 수익률이 무한대가 되어 평균 전체를 오염시킨다.
    if (!(prevClose > 0) || !(close > 0)) continue;
    sum += (close / prevClose - 1) * 10000;
    count += 1;
  }

  return count >= minSymbols ? sum / count : null;
}

// 시장 대비 초과 수익률. 시장을 모르면 null — 0으로 간주하면 하락장 전체가
// "고유 하락"으로 분류되어 이 층이 정확히 반대로 작동한다.
function excessReturn(ownReturnBps, marketReturnBps) {
  if (marketReturnBps == null || !Number.isFinite(marketReturnBps)) return null;
  if (!Number.isFinite(ownReturnBps)) return null;
  return ownReturnBps - marketReturnBps;
}

function isIdiosyncraticDrop({ ownReturnBps, marketReturnBps, threshold = -100 } = {}) {
  if (!(threshold < 0)) {
    throw new RangeError(`임계값은 음수여야 합니다 (하락 조건입니다): ${threshold}`);
  }
  const excess = excessReturn(ownReturnBps, marketReturnBps);
  // 판단 근거가 없을 때 통과시키면 이 층이 없는 것과 같아진다.
  if (excess == null) return false;
  return excess < threshold;
}

module.exports = { marketReturn, excessReturn, isIdiosyncraticDrop };
