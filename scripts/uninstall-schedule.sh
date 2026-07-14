#!/bin/bash
# launchd 데일리 스케줄 제거
set -euo pipefail

LABEL="com.lionandthelab.lion-coin-harness"
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
rm -f "$HOME/Library/LaunchAgents/$LABEL.plist"
echo "스케줄 제거 완료."
