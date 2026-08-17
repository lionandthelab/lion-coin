'use strict';

// 매매 설정 검증 — 순수 함수.
//
// 이 설정은 **실제 주문 금액과 손절 폭**을 정한다. 화면에서 아무 값이나 넣을 수
// 있으면 잘못된 주문이 그대로 거래소로 나가므로, 브라우저 검증을 믿지 않고
// 서버에서 다시 검증한다.
//
// 개별 값이 모두 유효해도 **조합이 무의미할 수 있다** — 익절이 비용보다 좁으면
// 손익분기 승률이 1을 넘어 어떤 승률로도 수익이 불가능하다. 그 조합 검증까지 여기서 한다.

const { INTERVALS } = require('./bithumb');
const { breakevenWinRate } = require('./bracket');

// 화면이 그대로 폼을 그릴 수 있도록 메타를 함께 둔다.
const FIELDS = {
  // 돌파와 반전은 진입 조건이 정반대다. 검증에서 돌파는 무작위보다 나빴고 반전은
  // 나았다(docs/reversal-validation.md) — 검증된 쪽을 앞에 둬 기본값으로 삼는다.
  // 코드에 박아두면 지금 무엇이 돌고 있는지 화면에서 알 수 없다.
  strategy: { label: '전략', type: 'enum', options: ['reversal', 'breakout'] },
  // 시장 대비 초과하락 임계값. 음수여야 한다 — 하락 조건이다.
  // 이 층이 우위를 +6.5bps에서 +14.5bps로 바꾼다 (docs/venue-and-data.md §9).
  excessDropBps: { label: '고유하락 임계', type: 'number', min: -2000, max: -1, unit: 'bps' },
  interval: { label: '캔들 간격', type: 'enum', options: INTERVALS },
  maxSymbols: { label: '스캔 종목 수', type: 'int', min: 1, max: 200 },
  minTradeValue24h: { label: '최소 24h 거래대금', type: 'number', min: 0, unit: '원' },
  lookback: { label: '돌파 룩백(봉)', type: 'int', min: 2, max: 200 },
  volMult: { label: '거래량 배수 기준', type: 'number', min: 1, max: 50 },
  takeProfitBps: { label: '익절', type: 'number', min: 1, max: 10000, unit: 'bps' },
  stopLossBps: { label: '손절', type: 'number', min: 1, max: 10000, unit: 'bps' },
  feeBps: { label: '수수료(편도)', type: 'number', min: 0, max: 100, unit: 'bps' },
  capitalKrw: { label: '운용 자본', type: 'number', min: 1, unit: '원' },
  riskPct: { label: '1회 위험', type: 'number', min: 0.01, max: 100, unit: '%' },
  scanIntervalSec: { label: '스캔 주기', type: 'int', min: 10, max: 3600, unit: '초' },
  maxSpreadBps: { label: '스프레드 상한', type: 'number', min: 1, max: 500, unit: 'bps' },
  maxBreakevenWinRate: { label: '손익분기 승률 상한', type: 'number', min: 0.01, max: 1 },
  maxConcurrentPositions: { label: '동시 포지션', type: 'int', min: 1, max: 20 },
  minNotionalKrw: { label: '최소 주문금액', type: 'number', min: 1, unit: '원' },
  maxHoldBars: { label: '최대 보유(봉)', type: 'int', min: 1, max: 500 },
};

function validateField(key, value) {
  const spec = FIELDS[key];
  if (!spec) return `알 수 없는 설정 항목입니다: ${key}`;

  if (spec.type === 'enum') {
    if (!spec.options.includes(value)) {
      return `${spec.label}: 지원하지 않는 값 "${value}" (가능: ${spec.options.join(', ')})`;
    }
    return null;
  }

  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return `${spec.label}: 숫자여야 합니다 (받은 값: ${JSON.stringify(value)})`;
  }
  if (spec.type === 'int' && !Number.isInteger(value)) {
    return `${spec.label}: 정수여야 합니다 (받은 값: ${value})`;
  }
  if (spec.min !== undefined && value < spec.min) {
    return `${spec.label}: ${spec.min} 이상이어야 합니다 (받은 값: ${value})`;
  }
  if (spec.max !== undefined && value > spec.max) {
    return `${spec.label}: ${spec.max} 이하여야 합니다 (받은 값: ${value})`;
  }
  return null;
}

function validateConfigPatch(patch, current) {
  const errors = [];

  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    return { ok: false, config: current, errors: ['설정은 객체여야 합니다'] };
  }

  for (const [key, value] of Object.entries(patch)) {
    const err = validateField(key, value);
    if (err) errors.push(err);
  }

  const next = { ...current, ...patch };

  // 조합 검증 — 최악의 경우(스프레드 상한까지 벌어진 상황)에도 성립해야 한다.
  // 스프레드가 좁을 때만 되는 설정은 실제로는 대부분의 종목에서 못 쓴다.
  if (errors.length === 0) {
    const worstCost = next.feeBps * 2 + next.maxSpreadBps;
    const be = breakevenWinRate({
      tpBps: next.takeProfitBps,
      slBps: next.stopLossBps,
      costBps: worstCost,
    });
    if (be > 1) {
      errors.push(
        `손익분기 승률이 ${(be * 100).toFixed(0)}%로 100%를 넘습니다 — ` +
          `익절 ${next.takeProfitBps}bps가 최악 비용(수수료 왕복 ${next.feeBps * 2}bps + ` +
          `스프레드 상한 ${next.maxSpreadBps}bps)을 감당하지 못해 전부 이겨도 손실입니다.`
      );
    }
  }

  return errors.length ? { ok: false, config: current, errors } : { ok: true, config: next, errors: [] };
}

module.exports = { FIELDS, validateConfigPatch, validateField };
