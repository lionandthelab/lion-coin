# 사람이 해야 할 일

하네스가 자동으로 진행할 수 없는 작업 목록입니다.

## 🎯 우선순위: 지금 딱 하나만 할 수 있다면 → B1 (Coinos 가입)

> **2026-08-16 변경: Blink → Coinos**
> Blink가 **한국 번호 온보딩을 막는** 것이 확인됐습니다. 2026-07-14에 "LNbits 대신 Blink"로
> 결정했지만, 그때는 알 수 없던 외부 제약이므로 공급자를 바꿉니다.
> 코드는 이미 Coinos를 지원합니다 (`check-goal`이 `.env`를 보고 자동 판별).

## B1 — Coinos 지갑 개설 (약 2분, 전화번호 불필요)

- **왜:** 실제 sats를 수령할 계좌. 이것 없이는 목표 판정 자체가 불가능합니다.
  32일 넘게 이 항목 하나가 목표 달성의 유일한 병목입니다.
- **왜 Coinos인가:**
  - **사용자명 + 비밀번호만** 필요 — 전화번호·이메일·KYC 없음 (한국 번호 문제 없음)
  - 수신 **무료**, 한국어 지원
  - **오픈소스**라 응답 형식을 추측하지 않고 소스에서 확인했습니다
  - Alby Hub는 호스팅 노드라 유료 가능성이 있어 "금전 비용 0원" 원칙과 충돌합니다

### 방법

1. **[coinos.io/register](https://coinos.io/register)** 접속 → 사용자명·비밀번호 입력 후 가입
   (브라우저에 이미 열어 뒀습니다)
2. 로그인 상태에서 **[coinos.io/docs](https://coinos.io/docs)** 접속 →
   "Auth Token" 항목에 **본인 토큰이 표시**됩니다. 복사하세요.
3. 프로젝트 루트의 `.env`에 아래 줄을 추가(또는 값 교체):
   ```
   COINOS_TOKEN=<복사한 토큰>
   ```
4. 형식 확인 (네트워크 왕복 없이 즉시):
   ```bash
   npm run verify-wallet
   ```
5. 실제 잔액 조회까지 확인:
   ```bash
   npm run check-goal
   ```
   `configured:true`가 나오면 **B1·B2 모두 완료**입니다. 이후 매 회차 자동 판정됩니다.

### ⚠ 주의

- **이 토큰은 계정 전체 권한입니다.** Blink의 Read 스코프 키와 달리 출금까지 가능합니다.
  `.env`는 gitignore 되어 있지만, **커스터디얼 잔고는 소액만** 유지하세요 (`docs/SECURITY.md`).
- 토큰 값을 대화창이나 저장소에 붙여넣지 마세요. `.env`에만 넣으면 됩니다.
- 옛 `BLINK_API_KEY`는 지우지 않아도 됩니다 — `check-goal`이 Coinos를 먼저 봅니다.

## C3 — Stacker News 계정 개설 (지금 바로 가능 — B1을 기다릴 필요 없음)
- **왜:** 연재 게시(C5) + tips 수령 채널.
- **방법 (2026-08-10 갱신):** [stacker.news](https://stacker.news)는 라이트닝 로그인 외에 **Nostr 로그인**(브라우저 확장 기반)도 지원합니다. B1(Coinos) 완료 전이라도 아래 경로로 계정을 먼저 만들 수 있습니다:
  1. [Alby 브라우저 확장](https://getalby.com/products/browser-extension) 설치.
  2. Alby 설정에서 "Create Master Key"로 새 Nostr 키 생성 (또는 기존 키가 있으면 가져오기).
  3. stacker.news 접속 → 로그인에서 Nostr 옵션 선택 → Alby가 뜨면 승인.
  4. 나중에 B1(Coinos) 완료 후 Settings → "Link Lightning"에서 라이트닝 지갑을 계정에 연결하면 zap 수령이 가능해집니다.
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
     - **백업 (2026-08-11 확인):** mempool.space faucet 페이지는 자바스크립트로 렌더링돼 자동 점검 도구로는 내용 확인이 안 됩니다 — 만약 막히거나 캡차가 안 풀리면 **[coinfaucet.eu/en/btc-testnet4](https://coinfaucet.eu/en/btc-testnet4/)** 를 대안으로 쓰세요. hCaptcha 기반, `tb1q...` bech32 주소를 그대로 받고, 2016년부터 운영 중인 오래된 서비스입니다(누적 지급 이력 확인됨).
  3. 완료되면 니모닉을 `.env`가 아닌 **종이에만** 보관하고, `harness/state.json`의 A3 `notes`에 주소만 적어주세요.
  4. 잔액 확인은 이제 `src/balance.js`(회차 3에서 완성)로 가능합니다: `node -e "require('./src/balance').fetchBalanceSats('tb1q...').then(s=>console.log(s+' sats'))"` (기본값은 mempool.space testnet3). **testnet4 faucet(coinfaucet.eu 등)을 썼다면** testnet3 API로는 잔액이 0으로 나옵니다 — 아래처럼 `baseUrl` 옵션으로 testnet4 Esplora 엔드포인트를 지정하세요 (2026-08-12 회차14에서 실제 응답 확인됨):
     ```bash
     node -e "require('./src/balance').fetchBalanceSats('tb1q...', { baseUrl: 'https://mempool.space/testnet4/api' }).then(s=>console.log(s+' sats'))"
     ```
