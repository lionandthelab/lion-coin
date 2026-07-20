# 사람이 해야 할 일

하네스가 자동으로 진행할 수 없는 작업 목록입니다. 완료하면 `harness/state.json`에서 해당 작업의 `status`를 `"done"`으로 바꾸거나, 다음 회차 로그에서 하네스가 감지하도록 그대로 두세요 (B2는 `.env` 존재로 자동 감지됩니다).

> ✅ **해결됨 (2026-07-17):** 회차 1·2가 보고한 "Bash 승인 거부" 문제는 워크스페이스 미신뢰가 원인이었습니다. 신뢰 설정 후 회차 3에서 `npm test`·커밋이 정상 동작함을 확인했습니다.

## B1 — Blink 지갑 개설 확인 (지금 가능, ⚠ 재확인 필요) ★확정: Blink로 진행
- **왜:** 실제 sats를 수령할 계좌. 이것 없이는 목표 판정 자체가 불가능합니다.
- **현재 상태:** `.env`에 API 키가 입력돼 있지만 `npm run check-goal`이 계속 **401**을 반환합니다. 키가 `ak_v2_` 접두사(79자)인데 Blink 지갑 키는 `blink_`로 시작해야 합니다([공식 문서](https://dev.blink.sv/api/auth)) — **다른 서비스의 키가 잘못 들어갔을 가능성**이 있습니다. 즉 B1(Blink 가입) 자체가 실제로 완료됐는지부터 확인이 필요합니다.
- **방법:**
  1. App Store에서 **Blink** 앱이 설치·가입돼 있는지 확인 (전화번호로 가입 → BTC 지갑 자동 생성, 라이트닝 주소 `xxx@blink.sv`도 함께 생성됨). 아직이라면 지금 가입하세요.
  2. 가입 확인되면 [dashboard.blink.sv](https://dashboard.blink.sv)에 **그 Blink 계정으로** 로그인 → API Keys → **Read 스코프** 키 발급 (`blink_...` 형식인지 반드시 확인).
  3. `.env`의 `BLINK_API_KEY` 값을 새 키로 교체.
- **주의:** 커스터디얼이므로 소액만. "not your keys, not your coins." (`docs/SECURITY.md` 참고)
- **확인:** `npm run check-goal`이 `configured:true`를 출력하면 성공 (B1·B2 모두 완료로 간주).

## C3 — Stacker News 계정 개설 (B1 후 권장)
- **왜:** 연재 게시(C5) + tips 수령 채널. 라이트닝 지갑으로 로그인하므로 B1이 먼저입니다.
- **방법:** [stacker.news](https://stacker.news) → 라이트닝 로그인.
- **참고:** 연재 1편 영문 초안이 이미 준비돼 있습니다 — `drafts/01-building-a-bitcoin-wallet-from-scratch.md`. 계정 개설 후 검토·게시만 하면 됩니다. 회차 5에서 `docs/benchmark.md`(벤치마킹 리포트)도 준비됐으니, 게시 후 판매 신호(zap 유도)를 참고하세요.

## A3 — 테스트넷 faucet 코인 수령 (지금 가능)
- **왜:** 트랙 A 학습용 전송 실습(A5 PSBT 서명·전송)에 필요. 실자산 아님.
- **방법:**
  1. 터미널에서 니모닉·주소 생성 (화면에만 출력됨 — 니모닉은 종이에 적고 터미널을 닫으세요. 취급 원칙은 `docs/SECURITY.md` 참고):
     ```bash
     node -e "const w=require('./src/wallet');const m=w.generateMnemonic();console.log('니모닉(종이에만 기록):',m);console.log(w.deriveAddress(m))"
     ```
  2. testnet4 faucet(예: mempool.space/testnet4/faucet)에서 캡차 풀고 위 `tb1q...` 주소로 전송.
  3. 완료되면 니모닉을 `.env`가 아닌 **종이에만** 보관하고, `harness/state.json`의 A3 `notes`에 주소만 적어주세요.
  4. 잔액 확인은 이제 `src/balance.js`(회차 3에서 완성)로 가능합니다: `node -e "require('./src/balance').fetchBalanceSats('tb1q...').then(s=>console.log(s+' sats'))"` (mempool.space testnet3 기준 — testnet4 faucet을 쓰면 `{ baseUrl: '...' }` 옵션으로 맞는 Esplora 엔드포인트를 지정해야 합니다).
