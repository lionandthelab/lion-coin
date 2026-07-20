# 벤치마킹 리포트: sats로 팔리는 디지털 상품/서비스 5개

이 문서는 `비트코인_획득_전략_및_개발제안서.md` 4-3절(벤치마킹 리포트 작성 항목)에 따라, 실제로 라이트닝(sats) 결제가 오가는 플랫폼·상품 5개를 조사한 결과다. C2(미니 가이드 제작)와 B4(결제 페이지 구성)의 가격·전달 방식 결정에 참고한다.

조사 방법: WebSearch로 각 플랫폼의 공식 문서·소개 페이지·커뮤니티 글을 확인. 개별 판매자의 실시간 가격은 유동적이라 플랫폼이 정의한 가격 메커니즘(고정가/자유가/스트리밍) 위주로 기록했다.

## 비교표

| # | 상품/플랫폼 | 상품 유형 | 가격(sats) 방식 | 결제 방식 | 전달 방식 | 페이지 구성 | 판매 신호 |
|---|---|---|---|---|---|---|---|
| 1 | [Stacker News](https://stacker.news/guide) | 글(콘텐츠) + 커뮤니티 큐레이션 | 자유가 — 독자가 zap으로 임의 금액 지급, 글 등록 자체엔 스팸 방지용 소액 수수료 | 라이트닝 zap (지갑 연결 필수) | 즉시 (게시물 URL, 별도 파일 전달 없음) | 게시물 목록 + territory(서브포럼) 별 정렬, zap 총액이 순위에 반영 | 상위 zap 게시물 수, 코멘트 스레드 활성도 |
| 2 | [Plebeian Market](https://plebeian.btc.pub/) | 디지털/실물 상품, 서비스(코딩·컨설팅 등) | 고정가 — 판매자가 상품 등록 시 지정 | 온체인 + 라이트닝 인보이스 + Cashu(ecash) 선택 가능 | P2P 직접 정산(플랫폼이 자금 보관 안 함) — nostr 메시지로 배송/전달 협의 | 상품 사진 + 가격 + 설명, nostr 프로토콜 기반이라 어떤 nostr 클라이언트에서도 노출 | 커뮤니티에 일정 % 기부 옵션, nostr 재게시(zap/repost)로 확산 |
| 3 | [LNbits LNURLp (Pay Links)](https://github.com/lnbits/lnurlp) | 셀프호스트 결제 링크 — ebook·템플릿 등 임의 디지털 파일 | 고정가 — 링크 생성 시 금액 지정, 하나의 링크를 반복 판매에 재사용 | 라이트닝 인보이스(LNURL-pay, QR/링크) | **Success Action**으로 결제 직후 자동 전달(메시지·URL·다운로드 링크) — 별도 웹훅으로 이메일 발송도 가능 | 셀프호스트라 페이지 디자인 자유 — 보통 "상품 설명 + 결제 버튼(QR)" 최소 구성 | 반복 결제 카운트를 LNbits 대시보드에서 직접 확인 가능 |
| 4 | [Fountain (V4V 팟캐스트)](https://support.fountain.fm/article/59-how-earning-works-on-fountain) | 오디오 콘텐츠 스트리밍 후원 | 스트리밍형 — 청취 분당 최소 10 sats, "Boost"(메시지 첨부 후원) 최소 100 sats. 플랫폼 수수료 4%(프리미엄 1%) | 라이트닝 스트리밍 결제(Podcasting 2.0) | 실시간 스트리밍이라 별도 전달물 없음 — 콘텐츠 자체가 무료 공개, 결제는 후원 성격 | 팟캐스트 앱 내 재생 화면에 Boost 버튼 | Boost 메시지(코멘트 겸 영수증)가 공개 노출되어 사회적 신호로 작용 |
| 5 | [SatShoot](https://github.com/Pleb5/satshoot) | 프리랜서 서비스(개발 등) | 고정가/시간당가 — 프리랜서가 잡(job) 또는 서비스 등록 시 금액 제시, 클라이언트가 입찰 | 라이트닝 zap(NIP-57) + Cashu nutzap(NIP-60/61) | 작업 완료 후 오프플랫폼 산출물 전달, 결제는 zap으로 정산 | nostr 기반 PWA — 잡 목록 + 입찰 스레드 + 평판(리뷰) | 완료된 잡 히스토리가 곧 프리랜서 평판(포트폴리오)로 축적 |

## 공통 패턴 및 시사점

1. **가격은 거의 항상 sats 고정가 또는 완전 자유가(zap) 둘 중 하나다.** 원화 환산 문구는 부가 정보로만 쓰이고, 실제 청구는 sats 단위. → 우리 상품(C2 미니 가이드)도 "1,000 sats" 같은 고정가로 제시하고, 원화 환산은 참고용 각주로만.
2. **전달 자동화가 핵심 차별점.** LNbits의 Success Action처럼 "결제 즉시 자동 전달"이 되는 구조가 가장 마찰이 적다. → B4(결제 페이지)를 만들 때 결제 확인 후 수동 대응이 아니라 자동 다운로드 링크 노출을 우선 목표로 삼는다.
3. **플랫폼이 자금을 보관하지 않는 구조(Plebeian, SatShoot)가 신뢰 마찰을 줄인다.** 우리는 이미 커스터디얼 지갑(Blink)을 쓰지만, 결제 페이지 자체는 제3자 자금 예치 없이 인보이스만 생성하는 방향이 단순하다.
4. **콘텐츠 자체가 마케팅이자 상품인 구조(Stacker News, Fountain)가 우리 전략(C4→C2→C5)과 정확히 일치한다.** 연재 초안을 먼저 공개하고, 완성된 가이드를 유료 상품으로 묶는 흐름은 이미 검증된 패턴.
5. **판매 신호는 대부분 "공개된 결제/후원 이력"이다.** zap 수, Boost 메시지, 완료된 잡 히스토리 등 — 결제가 소셜 신호를 겸한다. → Stacker News 게시(C5) 시 첫 zap이 곧 첫 판매 신호가 되므로, 초반 zap 유도(지인 공유)가 중요.

## 가격 결정 참고 (C2용)

기존 제안서(4-2절)의 "Bitcoin Wallet from Scratch" 미니 가이드 가격안(1,000 sats)은 위 벤치마크의 고정가 패턴과 부합하며 별도 조정 없이 유지한다. Fountain의 Boost 최소값(100 sats)이 "가벼운 후원"의 심리적 하한선으로 참고할 만하다 — 목표(600 sats)보다 낮은 액수도 결제 흐름 테스트(B3)에는 유효하다는 근거가 된다.

## 출처

- [Stacker News Content Guidelines](https://stacker.news/guide)
- [Plebeian – Circular Economic Community Builder](https://plebeian.btc.pub/)
- [GitHub - lnbits/lnurlp: LNbits Pay Links](https://github.com/lnbits/lnurlp)
- [How earning works on Fountain](https://support.fountain.fm/article/59-how-earning-works-on-fountain)
- [GitHub - Pleb5/satshoot: Freelancing on nostr](https://github.com/Pleb5/satshoot)
