# Satoshi Zero-to-One — 자율 하네스

라이트닝으로 **첫 1,000원어치(약 600 sats) 비트코인을 실수령**할 때까지, 매일 스스로 한 회차씩 전진하는 자율 시스템. 전략 원본은 [비트코인_획득_전략_및_개발제안서.md](비트코인_획득_전략_및_개발제안서.md).

## 작동 구조

```
launchd (매일 09:37 KST)
  └─ scripts/run-harness.sh
       ├─ goal.achieved == true → 스케줄 자체 해제 후 종료
       └─ 아니면: claude -p "$(cat harness/HARNESS.md)"  ← 한 회차 실행
            ├─ npm run check-goal      (LNbits 잔액 → 목표 판정)
            ├─ pickNextTask(state)     (의존성 그래프에서 다음 작업)
            ├─ 작업 수행 (TDD) + state.json 갱신
            ├─ logs/YYYY-MM-DD.md 일일 로그
            └─ 원자 커밋
```

- **상태:** [harness/state.json](harness/state.json) — 17개 작업의 의존성 그래프와 목표 지표
- **프로토콜:** [harness/HARNESS.md](harness/HARNESS.md) — 회차당 실행 절차·규칙
- **사람이 할 일:** [harness/ACTION_REQUIRED.md](harness/ACTION_REQUIRED.md) — 계정 개설 등 자동화 불가 작업
- **일일 로그:** `logs/` — 회차별 진행·지표·다음 계획 (러너 원시 로그는 `logs/runner/`, gitignore)

## 운영 명령

| 하고 싶은 것 | 명령 |
|---|---|
| 지금 즉시 한 회차 실행 | `bash scripts/run-harness.sh` |
| 스케줄 설치/재설치 | `bash scripts/install-schedule.sh` |
| 스케줄 중지 | `bash scripts/uninstall-schedule.sh` |
| 목표 판정만 실행 | `npm run check-goal` |
| 테스트 | `npm test` |
| 실행 시각 변경 | `infra/*.plist`의 Hour/Minute 수정 후 재설치 |
| 회차 모델 변경 | `run-harness.sh`의 `HARNESS_MODEL` (기본 claude-sonnet-5) |

## 목표 판정이 켜지는 조건

`.env`에 LNbits 지갑 키가 들어오는 순간(사람 작업 B1·B2) 매 회차 잔액을 조회해, `수령액(baseline 제외) ≥ 600 sats`가 되면 `goal.achieved=true`로 저장 → 다음 기동 때 러너가 launchd 잡을 스스로 내리고 프로젝트를 종료한다.

## 보안 원칙

- 니모닉·개인키·admin key는 코드·저장소·로그 어디에도 저장하지 않는다 (`.env`, `secrets/`는 gitignore).
- `src/` 학습 코드는 **테스트넷 전용** — 기본 네트워크가 testnet이며, 실자산 키를 다루지 않는다.
- 커스터디얼 지갑에는 소액만 둔다.
