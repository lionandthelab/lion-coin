#!/bin/bash
# launchd 데일리 스케줄 설치 (재실행해도 안전 — 기존 잡을 교체)
set -euo pipefail

PROJECT_DIR="/Users/mac/Workspace/lionandthelab/lion-coin"
LABEL="com.lionandthelab.lion-coin-harness"
PLIST_SRC="$PROJECT_DIR/infra/$LABEL.plist"
PLIST_DST="$HOME/Library/LaunchAgents/$LABEL.plist"

mkdir -p "$HOME/Library/LaunchAgents" "$PROJECT_DIR/logs/runner"
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
cp "$PLIST_SRC" "$PLIST_DST"
launchctl bootstrap "gui/$(id -u)" "$PLIST_DST"
launchctl print "gui/$(id -u)/$LABEL" | grep -E "state|program" | head -4
echo "설치 완료: 매일 09:37 KST에 하네스가 실행됩니다."
