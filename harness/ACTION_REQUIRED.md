# 사람이 해야 할 일

하네스가 자동으로 진행할 수 없는 작업 목록입니다. 완료하면 `harness/state.json`에서 해당 작업의 `status`를 `"done"`으로 바꾸거나, 다음 회차 로그에서 하네스가 감지하도록 그대로 두세요 (B2는 `.env` 존재로 자동 감지됩니다).

## B1 — 라이트닝 지갑 개설 (지금 가능)
- **왜:** 실제 sats를 수령할 계좌. 이것 없이는 목표 판정 자체가 불가능합니다.
- **방법:** 둘 중 하나
  1. [demo.lnbits.com](https://demo.lnbits.com)에서 지갑 생성 (브라우저만으로 가능, 소액 한정)
  2. Blink 앱 설치 (App Store) — 이 경우 API 연동 방식이 달라지므로 하네스에 알려주세요
- **주의:** 커스터디얼이므로 소액만. "not your keys, not your coins."

## B2 — .env에 API 키 설정 (B1 후)
- **왜:** 하네스가 매일 잔액을 조회해 목표 달성을 자동 판정합니다.
- **방법:** `.env.example`을 `.env`로 복사하고 LNbits 지갑의 URL과 **Invoice/read key**(admin key 아님)를 입력.

## C3 — Stacker News 계정 개설 (B1 후 권장)
- **왜:** 연재 게시 + tips 수령 채널. 라이트닝 지갑으로 로그인하므로 B1이 먼저입니다.
- **방법:** [stacker.news](https://stacker.news) → 라이트닝 로그인.

## A3 — 테스트넷 faucet 코인 수령 (지금 가능)
- **왜:** 트랙 A 학습용 전송 실습(A5 PSBT 서명·전송)에 필요. 실자산 아님.
- **방법:**
  1. 터미널에서 니모닉·주소 생성 (화면에만 출력됨 — 니모닉은 종이에 적고 터미널을 닫으세요):
     ```bash
     node -e "const w=require('./src/wallet');const m=w.generateMnemonic();console.log('니모닉(종이에만 기록):',m);console.log(w.deriveAddress(m))"
     ```
  2. testnet4 faucet(예: mempool.space/testnet4/faucet)에서 캡차 풀고 위 `tb1q...` 주소로 전송.
  3. 완료되면 니모닉을 `.env`가 아닌 **종이에만** 보관하고, `harness/state.json`의 A3 `notes`에 주소만 적어주세요.
