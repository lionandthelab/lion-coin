'use strict';

// 버전별 실적 추적과 롤백 판정 — 순수 함수.
//
// **왜 필요한가:** 복기가 코드 개선을 만들고 그게 배포되면, 그 뒤의 거래가 좋아졌는지
// 나빠졌는지 알아야 한다. 버전 태깅 없이는 "요즘 성적이 나쁘다"까지만 알고
// **무엇을 되돌려야 하는지**는 모른다.
//
// **롤백 판정에도 표본 규율이 그대로 적용된다.** 이 프로젝트는 짧은 표본의 우위를 믿었다가
// 두 번 정정한 이력이 있다(docs/reversal-validation.md). 배포 직후 3건 졌다고 되돌리면
// 잡음을 쫓는 것이고, 그 되돌림 자체가 또 다른 변경이라 원인 추적이 더 어려워진다.
//
// **이 모듈은 권고만 한다.** 실제 되돌리기는 사람이 한다 — 코드를 자동으로 되돌리면
// 어느 시점에 무엇이 돌았는지가 다시 모호해진다. 다만 매매 중단은 자동이어도 된다
// (src/review.js와 같은 원칙: 멈추는 데는 민감하게, 바꾸는 데는 둔감하게).

// 하루 거래량(0~3건)의 열 배 이상.
const MIN_TRADES_FOR_ROLLBACK = 30;

// 이전 버전보다 이만큼 나빠야 롤백을 권고한다. 조금 나쁜 것은 잡음이다.
const DEGRADE_THRESHOLD_BPS = 50;

function createVersionLog() {
  return { deploys: [], current: null, orphanTrades: [] };
}

function recordDeploy(log, { version, commit, at = Date.now(), summary = null, changes = null } = {}) {
  if (typeof version !== 'string' || !version) {
    throw new TypeError(`버전 이름이 필요합니다: ${version}`);
  }
  // 커밋 없이는 되돌릴 대상을 특정할 수 없다.
  if (typeof commit !== 'string' || !commit) {
    throw new TypeError(`커밋 해시가 필요합니다 — 없으면 되돌릴 대상을 특정할 수 없습니다: ${commit}`);
  }
  if (log.deploys.some((d) => d.version === version)) {
    throw new RangeError(`이미 기록된 버전입니다: ${version}`);
  }
  return {
    ...log,
    deploys: [...log.deploys, { version, commit, at, summary, changes, trades: [] }],
    current: version,
  };
}

function attachTrade(log, trade) {
  if (!log.current) {
    // 어느 버전 것인지 모르는 거래를 아무 버전에 붙이면 롤백 판단이 오염된다.
    return { ...log, orphanTrades: [...log.orphanTrades, trade] };
  }
  return {
    ...log,
    deploys: log.deploys.map((d) =>
      d.version === log.current ? { ...d, trades: [...d.trades, trade] } : d),
  };
}

function versionStats(log, version) {
  const d = log.deploys.find((x) => x.version === version);
  if (!d) return null;
  const t = d.trades;
  if (!t.length) {
    return { version, trades: 0, wins: 0, losses: 0, netBps: 0, netKrw: 0, avgBps: null };
  }
  const netBps = t.reduce((s, x) => s + (x.returnBps || 0), 0);
  return {
    version,
    trades: t.length,
    wins: t.filter((x) => (x.returnBps || 0) > 0).length,
    losses: t.filter((x) => (x.returnBps || 0) <= 0).length,
    netBps,
    netKrw: t.reduce((s, x) => s + (x.pnlKrw || 0), 0),
    avgBps: netBps / t.length,
  };
}

function shouldRollback(log, {
  minTrades = MIN_TRADES_FOR_ROLLBACK,
  degradeThresholdBps = DEGRADE_THRESHOLD_BPS,
} = {}) {
  const no = (reason, extra = {}) => ({ rollback: false, reason, target: null, targetCommit: null, ...extra });

  if (!log || !log.deploys.length) return no('배포 기록이 없습니다.');
  if (log.deploys.length < 2) return no('이전 버전이 없어 되돌릴 곳이 없습니다.');

  const cur = log.deploys[log.deploys.length - 1];
  const prev = log.deploys[log.deploys.length - 2];
  const curStats = versionStats(log, cur.version);
  const prevStats = versionStats(log, prev.version);

  if (curStats.trades < minTrades) {
    return no(
      `현재 버전 ${cur.version}의 거래가 ${curStats.trades}건뿐입니다 — 롤백 판단에 필요한 ${minTrades}건에 못 미칩니다. `
      + '적은 표본으로 되돌리면 잡음을 쫓는 것이고, 되돌림 자체가 또 다른 변경이라 원인 추적이 더 어려워집니다.',
      { currentStats: curStats, previousStats: prevStats }
    );
  }
  // 비교 대상이 부실하면 "나빠졌다"는 판단 자체가 근거 없다.
  if (prevStats.trades < minTrades) {
    return no(
      `이전 버전 ${prev.version}의 거래가 ${prevStats.trades}건뿐이라 비교 기준이 되지 못합니다.`,
      { currentStats: curStats, previousStats: prevStats }
    );
  }

  const delta = curStats.avgBps - prevStats.avgBps;
  if (delta >= -degradeThresholdBps) {
    return no(
      `현재 버전이 이전보다 ${delta.toFixed(0)}bps 차이입니다 — 열화 문턱(${degradeThresholdBps}bps)을 넘지 않습니다.`,
      { currentStats: curStats, previousStats: prevStats }
    );
  }

  return {
    rollback: true,
    target: prev.version,
    targetCommit: prev.commit,
    reason: `현재 버전 ${cur.version}이 이전 ${prev.version}보다 거래당 ${Math.abs(delta).toFixed(0)}bps 나쁩니다.`,
    evidence: `${cur.version}: ${curStats.trades}건 평균 ${curStats.avgBps.toFixed(0)}bps · `
      + `${prev.version}: ${prevStats.trades}건 평균 ${prevStats.avgBps.toFixed(0)}bps`,
    currentStats: curStats,
    previousStats: prevStats,
  };
}

module.exports = {
  MIN_TRADES_FOR_ROLLBACK,
  DEGRADE_THRESHOLD_BPS,
  createVersionLog,
  recordDeploy,
  attachTrade,
  versionStats,
  shouldRollback,
};
