'use strict';

// 기동 시 남아 있는 포지션 점검 — 순수 함수.
//
// **왜 필요한가:** 데몬은 매번 `createEventState()`로 시작한다. 거래소에는
// 포지션이 그대로 있는데 상태 기계는 IDLE이라, 익절·손절·시간초과 어느 것도
// 돌지 않고 화면에도 보이지 않는다. 배포 게이트가 POSITION_OPEN으로 *의도된*
// 교체는 막지만, 크래시·재부팅·전원 차단은 막지 못한다.
//
// **자동으로 복원하지 않는다.** 디스크의 마지막 값이 거래소의 현재 사실과
// 일치한다는 보장이 없다 — 죽는 순간 청산 주문이 나가 있었을 수도 있고, 부분
// 체결됐을 수도 있다. 어긋난 상태로 청산을 지시하면 없는 수량을 팔거나 남은
// 수량을 놓친다. 사람이 확인할 수 있게 **드러내는 것**까지가 이 모듈 몫이다.
//
// (같은 원칙이 version-log.js에도 있다: 멈추고 알리는 것은 자동으로 해도 되지만
// 되돌리고 고치는 것은 사람이 한다.)

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function describeAge(entryAt, now) {
  const at = num(entryAt);
  if (at === null || now - at < 0) return null;
  const min = Math.floor((now - at) / 60000);
  if (min < 60) return `${min}분 전`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}시간 전`;
  return `${Math.floor(hr / 24)}일 전`;
}

function checkStrandedPosition(position, { now = Date.now() } = {}) {
  const quiet = { stranded: false, message: null };
  if (!position || typeof position !== 'object' || Array.isArray(position)) return quiet;

  // 감시 모드의 가상 포지션은 거래소에 없다. 그것까지 깨우면 알림이 무뎌지고,
  // 무뎌진 알림은 진짜일 때도 무시된다.
  if (position.simulated) return quiet;

  const qty = num(position.quantity);
  if (qty === null || qty <= 0) return quiet;

  const symbol = typeof position.symbol === 'string' && position.symbol.trim()
    ? position.symbol.trim() : '종목 미상';
  const entry = num(position.entryPrice);
  const age = describeAge(position.entryAt, now);

  return {
    stranded: true,
    message: [
      `⚠ 재시작 전 포지션이 남아 있습니다 — ${symbol} 수량 ${qty}`,
      entry === null ? '진입가 미상' : `진입가 ${entry.toLocaleString('ko-KR')}원`,
      age ? `마지막 기록 ${age}` : null,
      '',
      '이 프로세스는 그 포지션을 감시하지 않습니다. 익절·손절·시간초과가 돌지 않습니다.',
      '거래소에서 직접 확인하고 처리하세요. 상태를 자동 복원하지 않는 것은,',
      '디스크의 마지막 값이 거래소의 현재 사실과 어긋나면 없는 수량을 팔게 되기 때문입니다.',
    ].filter((l) => l !== null).join('\n'),
  };
}

module.exports = { checkStrandedPosition };
