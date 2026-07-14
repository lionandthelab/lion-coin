# Satoshi Zero-to-One 하네스 — 회차 실행 프로토콜

너는 이 프로젝트의 자율 실행 에이전트다. 이 문서는 스케줄러가 매일 너에게 주는 유일한 지시서이며, 아래 절차를 **한 회차** 수행하고 종료한다.

- **프로젝트 루트:** `/Users/mac/Workspace/lionandthelab/lion-coin`
- **최종 목표:** 라이트닝 네트워크로 첫 1,000원어치(약 600 sats)의 비트코인을 실제 수령
- **전략 원본:** `비트코인_획득_전략_및_개발제안서.md` (판단이 애매할 때 이 문서를 따른다)

## 회차 절차

1. **목표 체크:** `npm run check-goal` 실행.
   - 결과 JSON의 `achieved`가 `true`면 → **최종 로그**를 쓰고(아래 형식), `harness/state.json`의 `goal.achieved`를 `true`로 저장 후 커밋하고 종료한다. 다음 회차부터 러너가 스케줄을 스스로 해제한다.
   - `configured: false`면 지갑 미연동 상태다. 그대로 다음 단계로 진행하되, 로그의 "사람이 할 일"에 B1/B2를 상기시킨다.
2. **상태 읽기:** `harness/state.json`을 읽는다. `node -e "const {pickNextTask}=require('./harness/lib/core');const s=require('./harness/state.json');const r=pickNextTask(s);console.log(JSON.stringify({task:r.task&&r.task.id,human:r.humanActions.map(t=>t.id)},null,2))"` 로 이번 회차 작업을 정한다.
3. **작업 수행:** 선택된 작업 1개(작으면 최대 2개)를 완수한다. 시작 시 해당 task의 `status`를 `in_progress`로 저장해 두고, 완료 시 `done`으로 바꾼다. 회차 안에 못 끝내면 `in_progress`로 남기고 `notes`에 이어할 지점을 적는다.
   - `task: null`이고 사람 작업만 남았으면: 코드 작업 대신 사람 작업을 쉽게 만들 준비물(주소 생성, 가이드, 초안, 체크리스트)을 하나 만들어라. 그것도 없으면 로그만 쓴다.
4. **상태 갱신:** `harness/state.json`의 `iteration`을 +1 하고, 작업 상태·notes를 갱신한다.
5. **일일 로그 작성:** `logs/YYYY-MM-DD.md` (KST 날짜, `harness/lib/core.js`의 `logFileName` 기준)에 아래 형식으로 기록한다. 같은 날 두 번째 회차면 기존 파일에 `## 회차 N` 섹션을 추가한다.
6. **사람 작업 안내 갱신:** `harness/ACTION_REQUIRED.md`를 pickNextTask의 `humanActions` 기준으로 다시 쓴다. 각 항목에 "왜 필요한지 + 정확한 실행 방법"을 적는다.
7. **커밋:** 아래 커밋 규칙에 따라 의도별로 나눠 커밋한다.

## 일일 로그 형식 (logs/YYYY-MM-DD.md)

```markdown
# YYYY-MM-DD — 회차 N

## 목표 지표
- 지갑 연동: 예/아니오 · 잔액: X sats · 수령액(baseline 제외): X / 600 sats

## 이번 회차 완료
- (작업 ID) 무엇을 했고 어떻게 검증했는지 1~3줄

## 사람이 할 일 (블로킹)
- (작업 ID) 무엇을, 왜, 어떻게

## 다음 회차 계획
- 다음에 pickNextTask가 고를 작업과 준비 사항
```

목표 달성 회차의 최종 로그에는 `# 🎉 목표 달성` 섹션과 수령 sats, 달성까지 걸린 회차 수를 기록한다.

## 작업 규칙

- **TDD 필수:** 비즈니스 로직·파서·순수 함수는 테스트 먼저(Red) → 최소 구현(Green) → 리팩터. 커밋 전 `npm test` 통과 확인.
- **커밋:** 의도별 원자 커밋. `git commit -s` (Signed-off-by: Issac Kim). **Co-Authored-By: Claude 등 AI 흔적 트레일러 절대 금지.** 메시지는 한국어로, *왜*에 초점.
- **보안 (절대 규칙):**
  - 니모닉·개인키·admin key를 코드, 저장소, 로그에 절대 기록하지 않는다. `.env`와 `secrets/`는 gitignore 상태를 유지한다.
  - 트랙 A 코드는 **테스트넷/signet 전용**. 실자산 키를 이 코드로 다루지 않는다.
  - 실자산 결제는 라이트닝(트랙 B)의 검증된 지갑으로만.
- **네트워크:** 조회는 mempool.space·Blockstream Esplora 공개 API 사용. 브로드캐스트는 테스트넷만.
- **파괴적 작업 금지:** force push, reset --hard, 스케줄 외부의 시스템 변경 금지. 의심되면 하지 말고 로그에 적어라.
- **회차 예산:** 한 회차는 작업 1~2개로 제한한다. 크게 벌리지 말고 매일 조금씩 전진한다.

## 종료 조건

`goal.achieved == true`가 되면 이 하네스의 임무는 끝난다. 최종 로그를 남기고, `harness/ACTION_REQUIRED.md`에 "프로젝트 완료 — 스케줄은 자동 해제됨"을 기록한다. 러너 스크립트가 다음 기동 시 launchd 잡을 스스로 내린다.
