#!/bin/bash
# Satoshi Zero-to-One 하네스 데일리 러너 (launchd가 매일 호출)
# 목표 달성 시 스케줄을 스스로 해제하는 것까지가 이 스크립트의 책임이다.
set -euo pipefail

PROJECT_DIR="/Users/mac/Workspace/lionandthelab/lion-coin"
LABEL="com.lionandthelab.lion-coin-harness"
# launchd는 PATH가 비어있으므로 node/claude 경로를 직접 잡아준다
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
# 회차 실행 모델 (필요시 변경)
HARNESS_MODEL="${HARNESS_MODEL:-claude-sonnet-5}"

cd "$PROJECT_DIR"
mkdir -p logs/runner
STAMP="$(date +%Y-%m-%d_%H%M%S)"
RUN_LOG="logs/runner/${STAMP}.log"

# 목표가 이미 달성됐으면 launchd 잡을 내리고 종료
if node -e "process.exit(require('./harness/state.json').goal.achieved ? 0 : 1)"; then
  echo "[$STAMP] 목표 달성 상태 — 스케줄 해제" >> "$RUN_LOG"
  launchctl bootout "gui/$(id -u)/$LABEL" 2>>"$RUN_LOG" || true
  exit 0
fi

echo "[$STAMP] 회차 시작 (model=$HARNESS_MODEL)" >> "$RUN_LOG"
claude -p "$(cat harness/HARNESS.md)" \
  --model "$HARNESS_MODEL" \
  --permission-mode acceptEdits \
  --max-turns 100 \
  >> "$RUN_LOG" 2>&1
STATUS=$?
echo "[$STAMP] 회차 종료 (exit=$STATUS)" >> "$RUN_LOG"
exit "$STATUS"
