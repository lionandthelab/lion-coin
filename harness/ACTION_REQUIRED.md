# 사람이 해야 할 일

하네스가 자동으로 진행할 수 없는 작업 목록입니다. 완료하면 `harness/state.json`에서 해당 작업의 `status`를 `"done"`으로 바꾸거나, 다음 회차 로그에서 하네스가 감지하도록 그대로 두세요 (B2는 `.env` 존재로 자동 감지됩니다).

> ✅ **해결됨 (2026-07-17):** 회차 1·2가 보고한 "Bash 승인 거부" 문제는 워크스페이스 미신뢰가 원인이었습니다. 신뢰 설정 후 회차 3에서 `npm test`·커밋이 정상 동작함을 확인했습니다.

> ⚠️ **참고 (2026-08-05):** 글로벌 `claude` CLI 설치 손상으로 2026-07-22~2026-08-04 사이 하네스가 14회차 연속 기동하지 못했습니다 (코드·상태 변화 없음, 단순 공백). 2026-08-05 복구되어 재개했습니다. 이 기간 중 **B1/B2는 그대로 미해결 상태**입니다 — 아래 안내는 여전히 유효합니다.

## B1 — Blink 지갑 개설 확인 (지금 가능, ⚠ 재확인 필요) ★확정: Blink로 진행
- **왜:** 실제 sats를 수령할 계좌. 이것 없이는 목표 판정 자체가 불가능합니다.
- **현재 상태 (2026-07-21 재확인):** `.env`의 키가 여전히 `ak_v2_` 접두사(79자)입니다 — 2026-07-17에 지적된 것과 동일한 값으로, 아직 교체되지 않았습니다. [공식 문서](https://dev.blink.sv/api/auth)를 다시 확인한 결과 Blink 키 형식은 지금도 `blink_...`가 맞습니다. 즉 여전히 다른 서비스의 키가 들어가 있는 상태입니다.
- **방법 (공식 문서 기준 정확한 경로):**
  1. App Store에서 **Blink** 앱이 설치·가입돼 있는지 확인 (전화번호로 가입 → BTC 지갑 자동 생성, 라이트닝 주소 `xxx@blink.sv`도 함께 생성됨). 아직이라면 지금 가입하세요.
  2. 가입 확인되면 [dashboard.blink.sv](https://dashboard.blink.sv)에 **그 Blink 계정으로** 로그인 → 좌측 메뉴 **"API Keys"** → **`+`** 버튼으로 새 키 생성.
  3. 스코프 선택: **Read**(잔액·거래내역 조회 — B2/체크스크립트에 필수)에 더해 **Receive**(인보이스 생성·온체인 주소 발급 — 나중에 B4 결제 페이지에서 필요)까지 함께 체크해서 발급하면, B4 착수 시 키를 다시 만들 필요가 없습니다. **Write는 선택하지 마세요** (공식 문서도 제3자 서버에서의 Write 스코프 사용을 권장하지 않음).
  4. 발급된 키가 `blink_`로 시작하는지 반드시 확인한 뒤 `.env`의 `BLINK_API_KEY` 값을 교체.
- **주의:** 커스터디얼이므로 소액만. "not your keys, not your coins." (`docs/SECURITY.md` 참고)
- **빠른 자가 점검 (2026-08-05 추가):** `.env` 교체 직후 `npm run check-goal`의 401을 기다리지 않고 `npm run verify-blink-key`로 먼저 형식만 즉시 확인할 수 있습니다 (네트워크 호출 없음). `blink_`로 시작하지 않으면 바로 알려줍니다.
- **확인:** `npm run check-goal`이 `configured:true`를 출력하면 성공 (B1·B2 모두 완료로 간주).

## C3 — Stacker News 계정 개설 (지금 바로 가능 — B1을 기다릴 필요 없음)
- **왜:** 연재 게시(C5) + tips 수령 채널.
- **방법 (2026-08-10 갱신):** [stacker.news](https://stacker.news)는 라이트닝 로그인 외에 **Nostr 로그인**(브라우저 확장 기반)도 지원합니다. B1(Blink) 완료 전이라도 아래 경로로 계정을 먼저 만들 수 있습니다:
  1. [Alby 브라우저 확장](https://getalby.com/products/browser-extension) 설치.
  2. Alby 설정에서 "Create Master Key"로 새 Nostr 키 생성 (또는 기존 키가 있으면 가져오기).
  3. stacker.news 접속 → 로그인에서 Nostr 옵션 선택 → Alby가 뜨면 승인.
  4. 나중에 B1(Blink) 완료 후 Settings → "Link Lightning"에서 라이트닝 지갑을 계정에 연결하면 zap 수령이 가능해집니다.
  - (이메일 로그인도 지원되는 것으로 보이나 세부 절차는 미확인 — Nostr 경로가 더 확실합니다.)
- **참고:** 연재 1편 영문 초안이 이미 준비돼 있습니다 — `drafts/01-building-a-bitcoin-wallet-from-scratch.md`. 계정 개설 후 검토·게시만 하면 됩니다. 회차 5에서 `docs/benchmark.md`(벤치마킹 리포트)도 준비됐으니, 게시 후 판매 신호(zap 유도)를 참고하세요.
- **주의:** 게시물에 zap을 받으려면 결국 라이트닝 지갑 연결(B1)이 필요합니다 — Nostr 로그인은 계정 개설·활동(게시·댓글)만 먼저 시작하게 해줄 뿐, C5의 최종 목표(수령)를 대체하지 않습니다.

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
