'use strict';

// 매매 관문 — 이 재료로 진입할 것인가. 순수 함수.
//
// scripts/event-trader.js 안에 있던 판단부를 꺼냈다. 스크립트 안에 있는 동안에는
// 테스트가 닿지 않았고, 그 상태로 **모든 신호가 조용히 사라지는 사고**가 한 번
// 있었다(08-17, 주문 크기가 최소 주문금액에 걸려 사이징 단계에서 전부 탈락).
// 관문은 정상 동작했다 — 무엇이 왜 버려졌는지 남지 않은 것이 문제였다.
//
// 그래서 이 모듈의 계약은 "통과/차단"이 아니라 **"통과/차단 + 사람이 읽을 수 있는
// 이유"**다. 이유 문자열은 화면과 텔레그램에 그대로 실린다.

const GRADE_RANK = { S: 4, A: 3, B: 2, C: 1 };

const list = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x.trim()) : []);

// 이 재료가 어느 종목 이야기인가. 주문이 나가는 자리를 우선한다 —
// 알림이 가리키는 종목과 주문이 나가는 종목이 어긋나면 안 된다.
// 거래 가능한 티커가 없을 때만 후보로 내려간다. 후보는 검증되지 않은 값이라
// **주문 심볼로 쓰면 안 되고** 기록·표시용이다.
function describeTarget(material) {
  const m = material && typeof material === 'object' ? material : {};
  return list(m.tickers)[0] || list(m.candidateTickers)[0] || null;
}

function shouldTrade(material, config = {}) {
  const m = material && typeof material === 'object' ? material : {};
  const no = (why) => ({ ok: false, why });

  if (!m.grade) return no('매매 대상 아님');
  if (m.direction === 'bearish') return no('악재 — 현물은 하락에 베팅할 수 없음');
  if (m.direction !== 'bullish') return no('방향성 없음');
  if (m.stale && !config.tradeStaleEvents) return no('이미 반영된 후속 공지');

  const floor = GRADE_RANK[config.minGrade];
  // 설정 오타로 하한을 못 읽었을 때 전부 통과시키는 것이 가장 위험하다.
  if (!floor) return no(`매매 하한 설정을 읽지 못했습니다: minGrade=${config.minGrade}`);
  if ((GRADE_RANK[m.grade] || 0) < floor) {
    return no(`${m.grade}급은 하한(${config.minGrade}급) 미만`);
  }

  // **미상장과 추출 실패는 다른 사건이다.**
  // 신규 상장·상장폐지 공지의 종목은 정의상 아직(또는 이미) 거래소 목록에 없다.
  // 둘을 같은 문구로 적으면 분별기가 고장 난 것인지 애초에 살 수 없는 것인지
  // 화면만 보고는 구별할 수 없다 — 하필 그게 이 전략이 가장 중요하게 꼽는 재료다.
  if (!list(m.tickers).length) {
    const cand = list(m.candidateTickers)[0];
    return no(cand
      ? `대상 ${cand} — 이 거래소에 상장돼 있지 않아 즉시 매수는 불가합니다`
      : '거래 가능한 티커를 찾지 못함');
  }

  return { ok: true, why: null };
}

// 실거래 모드로 들어가도 되는가.
//
// **화면에서만 막는 것은 관문이 아니다.** 대시보드가 버튼을 비활성화해도
// 오래된 탭이나 curl 한 줄이면 그대로 통과한다. 서버가 같은 조건을 다시 본다.
//
// 특히 API 키를 서버가 확인해야 한다. 키 없이 live로 들어가면 재료를 잡을 때마다
// 주문이 실패하는데 화면에는 "실거래 중"이라고 적힌다 — 켜졌다고 믿는 채로
// 아무것도 사지 못하는, 가장 헷갈리는 상태다.
function canEnterLiveMode(input) {
  // null은 기본 인자가 적용되지 않아 구조 분해에서 던진다. 요청 처리 경로에서
  // 던지면 500이 나가고, 화면은 그걸 "연결 끊김"과 구별하지 못한다.
  const { liveApproved, hasKeys, confirmLive } = (input && typeof input === 'object') ? input : {};
  const no = (reason) => ({ ok: false, reason });
  if (liveApproved !== true) {
    return no('실거래가 승인되지 않았습니다 — .env에 BITHUMB_LIVE=1이 필요합니다');
  }
  if (hasKeys !== true) {
    return no('빗썸 API 키가 없어 실거래로 전환할 수 없습니다 — 주문이 전부 실패합니다');
  }
  // 참 같은 값은 받지 않는다. 'true' 문자열이나 1이 통과하면 확인 관문이 형식이 된다.
  if (confirmLive !== true) {
    return no('실거래 전환에는 명시적 확인이 필요합니다');
  }
  return { ok: true, reason: null };
}

module.exports = { GRADE_RANK, shouldTrade, describeTarget, canEnterLiveMode };
