'use strict';

// 랩 UI 지원 모듈 — 공유 링크, 사용자 전략 컴파일, 캠페인 판정. 순수 함수.
// 브라우저에도 번들되므로 Node 전용 API를 쓰지 않는다.

const { ema, sma, rsi, atr, closes, rollingPercentileRank } = require('./indicators');

// ────────────────────────────────────────────────────────────────────────────
// 공유 링크
//
// 사용자 전략(임의 JS)과 공유 링크를 순진하게 합치면 XSS가 된다 — 링크에 코드를
// 담으면 받는 사람 브라우저에서 임의 코드가 실행된다. 그래서 **허용 목록에 있는
// 설정 키만** 담고, 인코딩과 디코딩 양쪽에서 걸러낸다. 손으로 만든 악성 링크는
// 인코더를 거치지 않고 들어오기 때문이다.
// ────────────────────────────────────────────────────────────────────────────

const SHARE_KEYS = [
  'symbol', 'interval', 'days', 'strategy', 'params',
  'execution', 'fee', 'mode', 'group',
];

function pickShareKeys(obj) {
  const out = {};
  for (const k of SHARE_KEYS) {
    if (obj[k] !== undefined) out[k] = obj[k];
  }
  return out;
}

// 브라우저와 Node 양쪽에서 돌아야 한다. btoa는 latin1만 받으므로 UTF-8 바이트를
// 먼저 만들어 넘긴다 — 이 과정을 건너뛰면 한글이 든 설정에서 깨진다.
function toBase64Url(str) {
  let b64;
  if (typeof btoa === 'function') {
    const bytes = new TextEncoder().encode(str);
    let bin = '';
    for (const b of bytes) bin += String.fromCharCode(b);
    b64 = btoa(bin);
  } else {
    b64 = Buffer.from(str, 'utf8').toString('base64');
  }
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(str) {
  const b64 = str.replace(/-/g, '+').replace(/_/g, '/');
  if (typeof atob === 'function') {
    const bin = atob(b64);
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  }
  return Buffer.from(b64, 'base64').toString('utf8');
}

function encodeShareConfig(cfg) {
  return toBase64Url(JSON.stringify(pickShareKeys(cfg || {})));
}

function decodeShareConfig(encoded) {
  if (typeof encoded !== 'string' || encoded.length === 0) {
    throw new Error('공유 링크가 비어 있습니다');
  }
  let parsed;
  try {
    parsed = JSON.parse(fromBase64Url(encoded));
  } catch {
    throw new Error('공유 링크를 해석할 수 없습니다 (손상되었거나 형식이 다릅니다)');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('공유 링크의 내용이 설정 객체가 아닙니다');
  }
  // 인코더를 거치지 않은 링크가 들어올 수 있으므로 여기서도 걸러낸다.
  return pickShareKeys(parsed);
}

// ────────────────────────────────────────────────────────────────────────────
// 사용자 전략 컴파일
//
// 사용자가 자기 전략을 못 돌리면 "당신의 전략을 검증한다"는 제품 카피가 거짓이 된다.
// 코드는 사용자 자신의 브라우저에서만 돌고 공유 링크에는 절대 실리지 않는다.
//
// 출력 검증이 핵심이다. 길이나 범위가 어긋난 배열은 엔진을 통과하면서 조용히
// 이상한 성과를 만들어낸다 — 사용자가 자기 전략이 좋다고 착각하게 되는 경로다.
// ────────────────────────────────────────────────────────────────────────────

const HELPERS = { ema, sma, rsi, atr, closes, rollingPercentileRank };

function compileUserStrategy(source) {
  let fn;
  try {
    // eslint-disable-next-line no-new-func
    fn = new Function('candles', 'params', 'helpers', source);
  } catch (err) {
    throw new Error(`전략 코드에 문법 오류가 있습니다: ${err.message}`);
  }

  return function userStrategy(candles, params = {}) {
    let out;
    try {
      out = fn(candles, params, HELPERS);
    } catch (err) {
      throw new Error(`전략 실행 중 오류: ${err.message}`);
    }

    if (!Array.isArray(out)) {
      throw new Error(`전략은 배열을 반환해야 합니다 (받은 것: ${typeof out})`);
    }
    if (out.length !== candles.length) {
      throw new Error(`반환 배열 길이(${out.length})가 캔들 수(${candles.length})와 다릅니다`);
    }
    out.forEach((p, i) => {
      if (typeof p !== 'number' || !Number.isFinite(p) || p < -1 || p > 1) {
        throw new Error(`[${i}]의 노출이 -1~1 범위의 수가 아닙니다: ${p}`);
      }
    });
    return out;
  };
}

// ────────────────────────────────────────────────────────────────────────────
// 캠페인 판정
//
// 탐색에서 통과한 것이 확인에서도 통과하는지 자동으로 본다. 이 프로젝트에서
// 사전 등록 가설이 네 번 기각된 경로(탐색 1등이 새 데이터에서 무너짐)를
// 도구가 대신 잡아주는 기능이다.
// ────────────────────────────────────────────────────────────────────────────

function campaignVerdict({ exploration, confirmation, minPassRatio = 0.5 } = {}) {
  if (!Array.isArray(exploration) || !Array.isArray(confirmation)) {
    throw new Error('exploration과 confirmation은 배열이어야 합니다');
  }
  if (exploration.length === 0 || confirmation.length === 0) {
    throw new Error('탐색·확인 결과가 비어 있어 판정할 수 없습니다');
  }

  const explorationPassed = exploration.filter((r) => r.passes).length;
  const confirmationPassed = confirmation.filter((r) => r.passes).length;
  const expRatio = explorationPassed / exploration.length;
  const conRatio = confirmationPassed / confirmation.length;

  const base = {
    explorationPassed,
    explorationTotal: exploration.length,
    confirmationPassed,
    confirmationTotal: confirmation.length,
  };

  // 탐색부터 과반에 못 미치면 확인을 볼 것도 없다.
  if (expRatio <= minPassRatio) {
    return {
      ...base,
      replicated: false,
      headline: `탐색 그룹에서 이미 과반 미달 (${explorationPassed}/${exploration.length})`,
      detail: '확인 라운드를 볼 필요 없이 기각입니다. 이 설정은 탐색 구간에서도 통하지 않았습니다.',
    };
  }

  if (conRatio <= minPassRatio) {
    return {
      ...base,
      replicated: false,
      headline: `재현 실패 — 탐색 ${explorationPassed}/${exploration.length} → 확인 ${confirmationPassed}/${confirmation.length}`,
      detail:
        '탐색 그룹에서 통과했지만 손대지 않은 확인 그룹에서 무너졌습니다. ' +
        '탐색 순위는 엣지의 순위가 아니라 그 구간에 우연히 맞은 정도의 순위입니다. ' +
        '이 결과를 근거로 실거래에 들어가면 백테스트와 전혀 다른 결과를 보게 됩니다.',
    };
  }

  return {
    ...base,
    replicated: true,
    headline: `재현됨 — 탐색 ${explorationPassed}/${exploration.length} → 확인 ${confirmationPassed}/${confirmation.length}`,
    detail:
      '탐색과 확인 양쪽에서 과반이 통과했습니다. 재현되지 않는 결과보다 훨씬 강한 근거이지만, ' +
      '여전히 과거 데이터입니다 — 전방 검증(페이퍼)이 남아 있습니다.',
  };
}

module.exports = {
  SHARE_KEYS,
  encodeShareConfig,
  decodeShareConfig,
  compileUserStrategy,
  campaignVerdict,
  HELPERS,
};
