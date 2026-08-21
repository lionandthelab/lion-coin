'use strict';

// 배포 게이트 — 복기에서 나온 개선안이 실행 중인 시스템에 들어가도 되는지 판정한다. 순수 함수.
//
// **이 게이트의 존재 이유: 실행 중인 시스템은 자동으로 바뀌지 않는다.**
// 코드 개선이 자동으로 main에 들어가고 데몬이 재시작되면, 어느 버전이 어떤 거래를 냈는지
// 알 수 없어 롤백 판단 자체가 불가능해진다. 게이트를 통과한 뒤에도 병합과 배포는 사람이 한다.
// 이 모듈은 "통과했는가"만 답하고 아무것도 실행하지 않는다.
//
// **가장 중요한 차단은 테스트 수 감소다.** 실패하는 테스트를 지워서 초록을 만드는 것은
// 코드를 고치는 에이전트가 저지를 수 있는 가장 그럴듯한 실패 방식이고, "통과 여부"만
// 보는 게이트로는 절대 잡히지 않는다. 이 프로젝트에서 이미 테스트가 결함을 가린 사례가
// 여럿 나왔다(항상 참인 단언, 공회전하는 방어 테스트, 변이 생존).

const BLOCKER = {
  TESTS_FAILED: 'TESTS_FAILED',
  TESTS_UNKNOWN: 'TESTS_UNKNOWN',
  TESTS_REMOVED: 'TESTS_REMOVED',
  POSITION_OPEN: 'POSITION_OPEN',
  TREE_DIRTY: 'TREE_DIRTY',
};

// `node --test` 요약을 읽는다. 요약이 없으면 null —
// 파싱 실패를 "0 실패"로 읽으면 테스트가 아예 안 돌아도 게이트가 열린다.
function parseTestOutput(text) {
  if (typeof text !== 'string' || !text) return null;
  const num = (label) => {
    const m = text.match(new RegExp(`^\\s*ℹ?\\s*${label}\\s+(\\d+)\\s*$`, 'm'));
    return m ? Number(m[1]) : null;
  };
  const total = num('tests');
  const passed = num('pass');
  const failed = num('fail');
  if (total == null || passed == null || failed == null) return null;
  return { total, passed, failed };
}

function evaluateDeployGate({
  tests,
  baselineTests = null,
  openPosition = false,
  mode = 'stopped',
  // `git status --porcelain` 결과를 줄 배열로. null이면 "모른다".
  dirtyFiles = null,
} = {}) {
  const blockers = [];
  const warnings = [];

  if (!tests || typeof tests.failed !== 'number' || typeof tests.total !== 'number') {
    blockers.push({
      code: BLOCKER.TESTS_UNKNOWN,
      message: '테스트 결과를 읽지 못했습니다 — 실행되지 않은 것과 통과한 것을 구별할 수 없어 배포를 막습니다.',
    });
  } else {
    if (tests.failed > 0) {
      blockers.push({
        code: BLOCKER.TESTS_FAILED,
        message: `테스트 ${tests.failed}건이 실패했습니다 (전체 ${tests.total}건).`,
      });
    }
    if (baselineTests && typeof baselineTests.total === 'number') {
      const removed = baselineTests.total - tests.total;
      if (removed > 0) {
        blockers.push({
          code: BLOCKER.TESTS_REMOVED,
          message: `테스트가 ${removed}개 줄었습니다 (${baselineTests.total} → ${tests.total}) — `
            + '실패하는 테스트를 지워 통과시킨 것일 수 있어 배포를 막습니다.',
        });
      }
    } else {
      warnings.push('기준 테스트 수가 없어 테스트 감소 검사를 건너뜁니다 (첫 배포이거나 이력이 유실됨).');
    }
  }

  // **커밋되지 않은 코드는 되돌릴 대상이 없다.**
  // 실제로 겪은 일: 다른 프로세스가 검증을 위해 소스에 결함을 심어 둔 순간에
  // 게이트를 돌렸더니 통과했다. 게이트가 "테스트가 통과했는가"만 보고 "그 테스트가
  // 어느 코드에 대한 것인가"는 보지 않았기 때문이다. version-log가 배포 기록에
  // 커밋 해시를 요구하는 것과 같은 이유로 여기서도 커밋을 요구한다.
  if (Array.isArray(dirtyFiles)) {
    if (dirtyFiles.length) {
      const shown = dirtyFiles.slice(0, 5).map((s) => String(s).trim()).join(', ');
      blockers.push({
        code: BLOCKER.TREE_DIRTY,
        message: `커밋되지 않은 변경이 ${dirtyFiles.length}건 있습니다 (${shown}`
          + `${dirtyFiles.length > 5 ? ' 외' : ''}) — 커밋되지 않은 코드는 되돌릴 대상이 없습니다.`,
      });
    }
  } else {
    // git이 없는 환경에서 배포를 영영 막으면 게이트가 도구가 아니라 벽이 된다.
    warnings.push('작업 트리 상태를 확인하지 못해 커밋 여부 검사를 건너뜁니다.');
  }

  // 매매 중 코드를 교체하면 그 거래가 어느 버전 것인지 알 수 없어져 롤백 판단이 오염된다.
  if (openPosition) {
    blockers.push({
      code: BLOCKER.POSITION_OPEN,
      message: '열린 포지션이 있습니다 — 청산 후 배포하세요. 매매 중 교체하면 그 거래의 버전 귀속이 모호해집니다.',
    });
  }

  // 막아버리면 실거래 중에는 영원히 개선할 수 없다. 사람이 알고 결정하도록 경고만 한다.
  if (mode === 'live') {
    warnings.push('실거래 모드에서의 배포입니다 — 데몬 재시작 중에는 재료를 놓칩니다.');
  }

  const pass = blockers.length === 0;
  return {
    pass,
    blockers,
    warnings,
    reason: pass
      ? `배포 게이트 통과 (테스트 ${tests.total}건 전부 통과${warnings.length ? `, 경고 ${warnings.length}건` : ''})`
      : `배포 차단 ${blockers.length}건: ${blockers.map((b) => b.code).join(', ')}`,
  };
}

module.exports = { BLOCKER, parseTestOutput, evaluateDeployGate };
