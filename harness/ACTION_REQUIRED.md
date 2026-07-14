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

## A3 — 테스트넷 faucet 코인 수령 (A1 완료 후 안내 예정)
- **왜:** 트랙 A 학습용 전송 실습에 필요. 실자산 아님.
- **방법:** 하네스가 주소를 생성해 일일 로그에 안내하면, signet faucet에서 캡차 풀고 전송.
