'use strict';

// 백테스트 엔진 코어 — 순수 함수. 네트워크·파일 I/O 없음.
//
// 이 엔진의 출력은 공개 성과 홍보와 SaaS의 근거가 된다. 그래서 성과를 부풀리는
// 흔한 경로를 API가 아니라 엔진 구조로 막는다 (단타_전략랩_확장_제안서.md §3-2):
//
//   1. 룩어헤드 차단 — targetPositions[i]는 "i번 봉 종가까지의 정보로 낸 판단"이며,
//      체결은 반드시 i+1번 봉 시가에 일어난다. 같은 봉 종가로 체결하지 않는다.
//      따라서 마지막 봉의 판단은 체결 기회가 없어 버려진다.
//   2. 비용 필수 — 수수료(bps)와 슬리피지(bps)를 진입·청산 양쪽에 적용한다.
//
// 포지션은 롱 온리 전량 진입/청산(0 또는 1)만 다룬다. 분할 매매는 아직 범위 밖이다.

const BPS = 10000;

function assertPositiveNumber(value, name) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${name}은(는) 양의 유한수여야 합니다: ${value}`);
  }
}

function assertNonNegativeNumber(value, name) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new RangeError(`${name}은(는) 0 이상의 유한수여야 합니다: ${value}`);
  }
}

function validate(candles, targetPositions, feeBps, slippageBps, initialEquity) {
  if (!Array.isArray(candles) || candles.length === 0) {
    throw new TypeError('candles는 비어 있지 않은 배열이어야 합니다');
  }
  if (!Array.isArray(targetPositions) || targetPositions.length !== candles.length) {
    throw new TypeError(
      `targetPositions 길이(${targetPositions?.length})가 candles 길이(${candles.length})와 다릅니다 — 신호와 봉의 정렬이 어긋나면 성과 전체가 무의미해집니다`
    );
  }
  targetPositions.forEach((p, i) => {
    if (p !== 0 && p !== 1 && p !== -1) {
      throw new TypeError(`targetPositions[${i}]은 -1(숏)·0(현금)·1(롱) 중 하나여야 합니다: ${p}`);
    }
  });
  candles.forEach((c, i) => {
    if (!c || typeof c !== 'object') {
      throw new TypeError(`candles[${i}]가 객체가 아닙니다`);
    }
    assertPositiveNumber(c.open, `candles[${i}].open`);
    assertPositiveNumber(c.close, `candles[${i}].close`);
  });
  assertNonNegativeNumber(feeBps, 'feeBps');
  assertNonNegativeNumber(slippageBps, 'slippageBps');
  assertPositiveNumber(initialEquity, 'initialEquity');
}

function runBacktest({
  candles,
  targetPositions,
  feeBps = 10,
  slippageBps = 5,
  initialEquity = 1000,
  fundingCost = false,
} = {}) {
  validate(candles, targetPositions, feeBps, slippageBps, initialEquity);

  const feeRate = feeBps / BPS;
  const slipRate = slippageBps / BPS;

  let cash = initialEquity;
  let units = 0; // 음수면 숏
  let open = null;
  const trades = [];
  const equity = [];

  for (let i = 0; i < candles.length; i += 1) {
    // 직전 봉 종가에서 낸 판단을 이번 봉 시가에 체결한다.
    if (i > 0) {
      const desired = targetPositions[i - 1];
      const held = Math.sign(units);

      if (desired !== held) {
        // 방향을 뒤집을 때는 청산과 진입이 각각 일어나므로 수수료도 두 번 든다.
        if (held !== 0) {
          const fill = candles[i].open * (held > 0 ? 1 - slipRate : 1 + slipRate);
          if (held > 0) {
            const gross = units * fill;
            cash += gross - gross * feeRate;
          } else {
            const cost = -units * fill;
            cash -= cost + cost * feeRate;
          }
          units = 0;
          trades.push({
            ...open,
            exitIndex: i,
            exitTime: candles[i].openTime,
            exitPrice: fill,
            exitEquity: cash,
            pnl: cash - open.entryEquity,
            returnPct: ((cash - open.entryEquity) / open.entryEquity) * 100,
          });
          open = null;
        }

        if (desired !== 0) {
          const equityNow = cash;
          const fill = candles[i].open * (desired > 0 ? 1 + slipRate : 1 - slipRate);
          const fee = equityNow * feeRate;
          if (desired > 0) {
            units = (equityNow - fee) / fill;
            cash = 0;
          } else {
            // 숏: 명목을 자기자본만큼 잡아 매도하고, 매도 대금을 현금에 더한다.
            const notional = equityNow;
            units = -notional / fill;
            cash = equityNow + notional - fee;
          }
          open = {
            entryIndex: i,
            entryTime: candles[i].openTime,
            entryPrice: fill,
            entryEquity: equityNow,
            side: desired > 0 ? 'long' : 'short',
          };
        }
      }
    }

    // 무기한 선물은 8시간마다 펀딩을 주고받는다. 롱은 펀딩이 양수일 때 지불한다.
    // 빼먹으면 장기 보유 전략의 성과가 실제보다 좋게 나온다.
    if (fundingCost && units !== 0 && candles[i].fundingSettled && candles[i].funding != null) {
      const notional = Math.abs(units) * candles[i].close;
      cash -= Math.sign(units) * notional * candles[i].funding;
    }

    equity.push(cash + units * candles[i].close);
  }

  return { equity, trades, open, initialEquity, finalEquity: equity[equity.length - 1] };
}

// 자산곡선 고점 대비 최대 하락폭(%).
function maxDrawdownPct(equity) {
  let peak = equity[0];
  let worst = 0;
  for (const value of equity) {
    if (value > peak) peak = value;
    const dd = ((peak - value) / peak) * 100;
    if (dd > worst) worst = dd;
  }
  return worst;
}

// 지표가 정의되지 않는 경우(트레이드 0건, 손실 0건)에는 0이나 Infinity로 위장하지 않고 null을 돌려준다.
function summarize(result) {
  const { equity, trades, initialEquity, finalEquity } = result;

  const wins = trades.filter((t) => t.pnl > 0);
  const grossProfit = wins.reduce((sum, t) => sum + t.pnl, 0);
  const grossLoss = trades.filter((t) => t.pnl < 0).reduce((sum, t) => sum - t.pnl, 0);

  return {
    totalReturnPct: (finalEquity / initialEquity - 1) * 100,
    maxDrawdownPct: maxDrawdownPct(equity),
    tradeCount: trades.length,
    winCount: wins.length,
    winRatePct: trades.length === 0 ? null : (wins.length / trades.length) * 100,
    profitFactor: grossLoss === 0 ? null : grossProfit / grossLoss,
    openPosition: result.open !== null,
  };
}

module.exports = { runBacktest, summarize, maxDrawdownPct };
