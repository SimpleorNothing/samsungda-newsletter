# 기획 데일리 뉴스레터 — 작업가이드

> 최종 업데이트: 2026-07-22 08:08 (KST)

`samsungda-newsletter` (Cloudflare Worker + Cron). 삼성전자 생활가전(DA) 기획자용 데일리 브리핑.
콘텐츠 로직 단일 기준. 화면 라벨은 2026-07-06 발송본(개편 완료본) 기준.

---

## 0. 편성 · 발송

- **편성**: 월~금 데일리. cron `45 22 * * 1-5` (07:45 KST).
- **발송**: Resend, 수신자별 개별. 제목 `📊 기획 데일리 · {날짜} ({요일})`.
- **구독자**: R2 `subscribers/<sha256(email)>.json`. 신규 구독 시 확인 메일.
- **라우트**: `/subscribe` · `/unsubscribe` · `/subscribers?key=` · `/preview` · `/send?key=` · `/latest` · `/refresh-freight?key=`.
- **아카이브**: 발송분을 R2 `newsletter/{date}.html` + `latest.html` 저장 → 모음/회차 열람 페이지가 참조. 하단에 업데이트 내역 표시.
- **배포**: `src/**`·`wrangler.jsonc`·`package.json`가 main에 push되면 GitHub Actions(`.github/workflows/deploy.yml`)가 Cloudflare Workers로 **자동 배포**. 수동 실행은 Actions 탭 → Run workflow(`workflow_dispatch`). (README 등 비관련 변경은 paths 필터로 배포 안 됨.)
- **실발송 go-live는 hold** — 코드·PR·merge는 정상 진행, 공개 발송만 명시 요청 전까지 보류. 검증은 `/preview`·셀프테스트 전용.

---

## 1. 디자인 — CI 스타일 상속

CI 보드(`ci.samsungda.net`) 자체 팔레트를 상속(`T` 객체). 기본 토큰 미사용.

| 역할 | 값 |
|---|---|
| 배경 `bg` | `#EDEFEC` (CI paper) |
| 서피스 `surface` | `#FFFFFF` |
| 본문 `text` | `#17222D` (CI ink) |
| 보조 `muted` | `#5C6B79` |
| 테두리 `border` | `#D3D9D6` |
| 강조 `brand` | `#46647E` (CI new) |
| 유리·하락 방향 | `#46647E` 파랑 |
| 불리·상승 방향 | `#B02E24` CI insight 빨강 |

- **폰트** Pretendard, 이메일 table 레이아웃, 본문 폭 max 600px.
- **추이 그래프 색은 등락 방향이 아니라 '당사 유불리' 기준**: 유리 파랑 / 불리 빨강 + 세로 그라데이션. (예: 유가 하락 = 원가 유리 = 파랑)
- 상단 헤드룸 기본 70%(우측 끝 최고점이면 65%), 2배 확대, 처음/마지막 값·연월 x축 표기.

> ⚠ STYLE_GUIDE 8-2 레지스트리 표에는 뉴스레터가 아직 "기본 토큰"으로 적혀 있으나 실제 코드는 CI 팔레트 상속. **8-2 표 갱신 필요**(별도).

---

## 2. 데이터 소스 · 취득 방법

`gatherData()`가 병렬 수집.

### 2-1. Yahoo Finance (`range=6mo` → 전일·1개월전·6M 스파크라인)
`KRW=X` `MXN=X` `THB=X` `VND=X` `INR=X` `PLN=X`(환율) · `CL=F`(WTI) · `HG=F`(구리) · `^TNX`(美 10Y) · `ITB`(홈빌더 ETF) · `XLY`(소비재 ETF).

### 2-2. FRED API (월간 30개월 + R2 캐시 폴백 `signals/fred/`)
- 월간: `CPIAUCSL` · `PCEPI` · 한국CPI · 유럽CPI(`CP0000EZ19M086NEST`) · `HOUST` · `EXHOSLUSM495S`(기존주택) · `UMCSENT` · 철광석 · `WPU101`(철강 PPI) · 레진(`PCU325211325211`).
- 주간(전주 델타): `ICSA` · `MORTGAGE30US`.
- API 실패 시 직전 성공값(R2 캐시) 폴백.

### 2-3. 운임 SCFI / FBX
- `signals/fbx.json`에 **web_search 일 1회 자동 캐시** + R2 수동 override.
- **SCFI 6개월 추이** = 엑셀 seed(`SCFI_SEED`) + R2 누적(`signals/scfi-history.json`) + 오늘 관측치 날짜 병합. 관측 4개 미만이면 "추이 축적 중" placeholder.

### 2-4. R2 `samsungda-research` (도구모음 소스)
뉴스 `mi.samsungda.net/data/news.json`(top 5, og:image 썸네일) · 아이디어 `idea-bank/` · 보고서.

### 2-5. 추이셀 규칙
`seriesTrend` 월간 최근 7관측(≈6개월) 절단 · `fredTrend(yoy)` CPI 전년비 변환 · `downsample` 26포인트.

### 2-6. 한국은행 — ECOS 오픈API + 게시판 폴링 (수요·원가·거시 보강)
- **정기 자동수집 (ECOS 오픈API)**: 인증키 발급 후 통계표코드로 호출. 수집 대상 — 소비자심리 CCSI, 기업경기 BSI·경제심리 ESI, 소비자물가·생산자물가·수입물가, 가계 관련 지표. 호출 한도 유의(일/건 제한).
- **부정기 큐레이션 (보도자료·게시판 HTML 폴링)**: 금융안정보고서(반기)·경제전망보고서(분기)·BOK 이슈노트(수시)·소비자동향조사(월). 게시판 신규 게시글 감지 → 후보 스테이징(사람 검토).
- **DA 관점 우선 지표**: CCSI(내구재·가전 수요 선행) · BSI/ESI(제조 심리) · 수입물가(원가 채널) · 가계 양극화 이슈노트(프리미엄 vs 볼륨존 근거).

### 2-7. 글로벌 컨설팅사 인사이트 (C 유형 · 기술/경쟁)
- **백본 (자동수집)**: McKinsey 네이티브 RSS(`/insights/rss`) — State of the Consumer 등 소비·리테일 인사이트.
- **부정기 큐레이션**: Deloitte · BCG · Bain · Accenture · PwC · Kearney · Roland Berger · Oliver Wyman — 이메일 뉴스레터 또는 서드파티 RSS 생성기 경유. 상당수 이메일 게이트(등록 필요).
- **Deloitte Korea 인사이트 허브** (`deloitte.com/kr` · 한국어) ⭐: 인사이트 리포트 목록(`/kr/ko/our-thinking/deloitte-insights.html`) · 월간 **Trend Tracker**(`/kr/ko/our-thinking/Monthly-Trend-Tracker/trend-tracker-YYYY-MM.html` — '이번 달 발간분' 인덱스라 최근 1개월 스캔에 최적) · 주간 **글로벌 경제리뷰**(`/kr/ko/our-thinking/global-economic-review/ger-YYYY-MM-Nst.html` — 매주 금요일) · **Consumer Signals**(분기, 국내 소비심리). 한국어·국내 시사점 포함이라 DA 기획 인용에 직결. DA 우선 픽: Consumer Signals·소비재/유통 전망·관세/통상·에너지(HVAC·전력)·순환경제. 리스트 페이지에 발행일 미표기 → **Trend Tracker(월)·경제리뷰(주차)로 발간 시점 앵커링**.
- **인용 규율**: 수치·발행일 반드시 확인. **균형 인용** — 컨설팅 낙관 전망엔 상반 데이터·caveat 병기(예: AI 가전 낙관치 ↔ BOK 이슈노트 "AI 생산성 효과 아직 불명확").

### 2-8. 가전 기술 트렌드 (C 유형 · 기술/제품)
- **CES / CTA** (`cta.tech`): 매년 1월 최대 가전·전자 트렌드 소스 — 오프라인 음성제어·Matter 생태계·AI 자율 조리·빌트인 미니멀 디자인. 삼성 Bespoke·경쟁사 신제품 공개. 연 1회 집중(부정기 큐레이션).
- **GlobalSpec Appliance Technology** (`globalspec.com`): 제조·설계·부품·로보틱스·공급망 관점 기술 뉴스레터. 이메일 구독형 → 자동수집 가능.
- **HomeWorld Business** (`homeworldbusiness.com`): 가전·하우스웨어 업계 전문지. Appliances/Retail/Financials/Trade Shows 카테고리.
- **ukwhitegoods.co.uk**: 백색가전 업계 뉴스, **RSS 제공**(`?type=rss`) — 리콜·M&A·규제·가격담합 등 사건 중심. 자동 폴링 적합.
- **OEM 뉴스룸**: GE Appliances(`pressroom.geappliances.com`)·Hisense·LG·Whirlpool — 경쟁사 신제품·전략 1차 소스. CI evidence 후보로 직결.

### 2-9. 연관·영향 산업 (수요·원가·규제 채널)
- **냉매·HVAC 규제 — ACHR News** (`achrnews.com`) ⭐: AIM Act에 따른 R-410A→R-454B/R-32 전환. R-410A 가격이 2022년 대비 40~70%↑, 신규 HVAC 장비가 시장별 15~25%↑ — 공조·냉장 원가에 직결. 2026.1 HFC 누출관리 규정 발효. **원가 시그널 보강 소스**.
- **판매·소비 데이터 — NIQ / GfK** (`nielseniq.com`): T&D(가전·내구재) 판매추적. 중국 이구환신(trade-in), 교체 사이클, 세그먼트 지불의향.
- **공급망·부품 — SupplyChainBrain** (`supplychainbrain.com`): 물류·부품·리쇼어링 동향(SCFI 운임과 상호보완).
- **에너지 규제 — DOE / ENERGY STAR**: SEER2 등 효율 기준 → 제품 스펙·리베이트 자격 좌우.
- 매크로·소비심리 축은 §2-2 FRED·§2-6 ECOS가 담당.
- **자동수집 우선순위**: ukwhitegoods RSS · GlobalSpec 뉴스레터 · ACHR News 폴링. CES·NIQ·컨설팅은 부정기 큐레이션. (시장조사 유료 리포트 Technavio·Fortune 등은 게이트로 자동 인용 부적합 → 제외.)

### 2-10. 선택 소스 (env 키 미설정 · 필요 시 활성화)
- **EIA API** (`EIA_API_KEY` · eia.gov 무료 · 선택): 미국 휘발유(가솔린) 가격. 美 소비여력·이동/물류비 프록시 → 원가·수요 시그널 보강.
- **NewsAPI** (`NEWS_API_KEY` · newsapi.org 무료 · 선택): 실시간 뉴스. 시장 동향 보강(현 MI `news.json` 보완).
- 둘 다 무료 티어. **현재 미연결** — 키 발급 후 env 설정하면 즉시 활성. 필요 시점에 붙임.

---

## 3. Insight 추출 (3계층)

### 3-1. 히어로 AI 브리핑 — `claude-sonnet-4-5` (`aiSummary`)
출력 JSON: `hero` · `consume` · `cost` · `newsSummary` · `news[]`.
- **히어로 = '오늘의 한 줄'** (2026-07-06 개편): 대응방안·손익영향 평가는 넣지 않고, **시장 동향과 그 의미를 1~2문장으로 압축**. (구 '오늘의 맥락'의 3축 종합·대응평가 방식 폐기)
- 2026-07-05 연동: 히어로 AI 요약이 **CI(경쟁사 전략 추적) 보드의 검증된 최근 동향을 참고**.
- **해석 기준**: 6개월 추이 1차. 시장지표(환율·유가·구리·철강·금리·홈빌더ETF·美CPI·기존주택)는 6M 델타로 큰 그림, 전일/전월은 단기 가속·되돌림 보조. 유럽/한국 CPI·심리·주간지표·운임은 발표주기상 전년/전월/전주.
- `consume`/`cost`: 각 섹션 의미 1문장(명사형, 75자) + 괄호 근거 지표 병기.
- 프록시 해석: 홈빌더ETF↑/모기지↓ = 주택·빌트인 수요 개선 / 실업수당↑ = 소비여력 둔화. '~신호'까지만.
- **환율(원가 관점 전용, 매출·수출 채산성 금지)**: 원화 강세 = 수입 원가 하락 / **생산거점 통화(페소·바트·동·루피·즈워티) 강세 = 현지 조달비 상승 = 원가 상승**(방향 뒤집기 금지).
- **추론 규율**: 제공 데이터만. '지속'·'추세'·'회복'은 델타로 뒷받침될 때만. 키 없으면 규칙 폴백(`ruleSummary`).

### 3-2. 누적 신호 — `analyzeSignals`
- `signals/history.json` 일별 스냅샷(최대 90일). **preview 미기록, 실발송·cron만 `persistSignals`**.
- 5영업일 전 대비 주간 누적 델타·bp 델타·연속 스트릭. 임계 돌파만 표시(환율 ±1.5% · 美10Y ±15bp · 홈빌더ETF ±3% 등).
- **수요 분화**: 홈빌더 ITB ↔ 소비재 XLY 방향 갈림 + 각 ≥2%.
- 축적 3일 미만 `ready:false`. 최대 6건.

### 3-3. CI 라우팅 — `buildCiCandidates`
- MI뉴스 중 LG전자 + LG 전략축(A1~A6) 키워드 매칭 → 축 뱃지 + `signals/ci-candidates.json` 스테이징(최대 10). **evidence.json 자동 커밋 없음**(사람 검토용).
- 축: A1 구독/서비스 · A2 HVAC·AIDC · A3 AI홈 · A4 볼륨존·원가 · A5 지역 포트폴리오 · A6 로봇.

---

## 4. 기사(뉴스) 정리 방법

- `getNews()` → MI `news.json` 상위 5건, og:image 썸네일. 등급 가중 `긴급3·주요2·주시1·참고0`.
- **`newsSummary`**: 오늘 뉴스 관통 공통 메시지 1문장(명사형, 75자). 나열 아님.
- **뉴스별 3필드**(첫 줄 불릿 + 기회/위협 오른쪽 화살표, AI 생성):
  - `content`: 소식 핵심 1문장(60자, 시장·정책·경쟁 구도). 항상 채움.
  - `opportunity`: 당사 강점·포지션 관점 유리 지점(80자). 화면에서는 오른쪽 화살표(`→`)로 표시. **'기회:' 라벨 금지, 서술식**. 시작말('당사도'·'우리 DA엔'·'당사 관점에선')·맺음말 매 항목 변주. 근거 약하면 "제한적" 서술.
  - `threat`: 경쟁·시장·정책 압박(80자). 화면에서는 오른쪽 화살표(`→`)로 표시. **'위협:' 라벨 금지**. 대비 접속('다만'·'한편'·'경쟁 측면에선'·'그러나') 변주.
- 공통: **사실·방향 서술만**. 실행 제안·액션 권고 금지. 헤드라인·요약 밖 사실·수치 창작 금지.
- LG 전략축 관련이면 어느 축(예: A1 구독·서비스)에 닿는지 한 번 태깅. 범위 밖 축 진행 창작 금지.

---

## 5. 화면 구조 (발송 순서 · 2026-07-06 개편본)

| 순서 | 라벨 | 부제 |
|---|---|---|
| 헤더 | 기획 데일리 | `{날짜} ({요일}) · SAMSUNG DA 기획 도구모음` / 메뉴 스트립 `수요 시그널 · 원가 시그널 · 시장 동향 · 기획 인사이트` |
| 1 | **오늘의 한 줄** | 히어로 (시장 동향+의미 1~2문장 압축) |
| — | 누적 신호 · 주간 임계 돌파 | 돌파분 있을 때만 |
| 2 | **🛒 수요 시그널** | CPI·금리·주택 6개월 추이 · 물가 전년 · 심리 전월 |
| 3 | **💰 원가 시그널** | 유가·철강·SCFI 6개월 추이 · 원자재·환율 |
| 4 | **📰 시장 동향** | newsSummary + 가전 주요뉴스 5건 |
| 5 | **🆕 기획 인사이트** | 아이디어뱅크 링크 |

푸터 출처: Yahoo Finance · FRED · SCFI · ECOS(한국은행) · McKinsey.

> **명칭 이력**: (구) 소비·원가·경쟁사·뉴스·아이디어·보고서 / 오늘의 맥락 / 🛒소비 · 💰원가 · 📰가전 주요뉴스 · 🆕New 아이디어·보고서 → (현, 07-06) 위 표.

---

## 변경 이력
- **2026-07-22 08:08 (KST)** — Refactor HTML email template and unsubscribe logic (`e970d72`)
- **2026-07-22 07:20 (KST)** — [nl] 헬스체크 자동복구 — 미발송 감지 시 스스로 재발송 (#125) (`59ccee2`)
- **2026-07-22 07:15 (KST)** — [nl] cron 3분할 — 06:30 제작 / 07:00 발송 / 10:00 헬스체크 (#124) (`0bc5653`)
- **2026-07-22 07:14 (KST)** — index.js 업데이트 (`bc55e1b`)
- **2026-07-21 23:47 (KST)** — [nl] 제작(06:30)과 발송(07:00) 실행 분리 — 서브리퀘스트 한도 대응 (#123) (`ed4d909`)
- **2026-07-17 13:09 (KST)** — Update index.js (`b248830`)
- **2026-07-16 12:09 (KST)** — index.js 업데이트 (`f3b8de5`)
- **2026-07-14 08:03 (KST)** — fix: 기획 인사이트 소스 정합성 — usage CSV 제외 + 최신 3건 상시 노출 + 헤더 아이콘 무채색화 (#119) (`0c58182`)
- **2026-07-10 22:27 (KST)** — feat: LG전자 표시 뉴스 상한 3건으로 제한 (#117) (`4793baa`)
- **2026-07-10 07:18 (KST)** — feat: 자동 발송 게이트 ON (SEND_ENABLED=true) — 다음 cron(내일 06:30 KST)부터 발송 (#114) (`5836ccb`)
- **2026-07-10 07:13 (KST)** — docs: 편성 변경 이력 추가(리서치 인사이트 preview 전용) + 07-09 문구 정정 [skip-changelog] (#113) (`006e4db`)
- **2026-07-09 08:54 (KST)** — 뉴스레터 본문 너비 26% 확대 (600px → 756px) (`2d1374c`)
- **2026-07-09 08:40 (KST)** — fix: Resend 2 req/s 레이트리밋 스로틀 + 429 백오프 재시도 (리포트 유실 방지) (#110) (`18aafe3`)
- **2026-07-09 00:27 (KST)** — feat(insights): Deloitte Korea 허브(deloitte.com/kr) 우선 탐색 지침 추가 (#109) (`4df7acd`)
- **2026-07-09 00:21 (KST)** — fix(newsletter): 뉴스 헤드라인 LG 전략축 코드(A1~A6) 노출 제거 (`178a46a`)
- **2026-07-09 00:06 (KST)** — 하드코딩 CHANGELOG를 changelog.js import로 전환 (#107) (`3f707bd`)
- **2026-07-09 00:05 (KST)** — 소스 인벤토리 §2-7에 Deloitte Korea 인사이트 허브(`deloitte.com/kr`, 한국어) 추가. 인사이트 리포트·월간 Trend Tracker·주간 글로벌 경제리뷰·Consumer Signals. 리스트에 발행일 미표기 → Trend Tracker(월)·경제리뷰(주차)로 발간 시점 앵커링.
- **2026-07-08 23:53 (KST)** — feat: CHANGELOG를 changelog.js로 분리 (자동 적립 마커 포함) (#105) (`13c9cbc`)
- **2026-07-08 23:16 (KST)** — Merge pull request #97 from SimpleorNothing/codex/cost-signal-icon (`9ff6489`)
- **2026-07-08 23:15 (KST)** — Merge pull request #104 from SimpleorNothing/fix/remove-lg-axis-badges (`98b78e9`)
- **2026-07-08 23:01 (KST)** — 리서치 인사이트 자동수집(insights.js) index.js 연결 (#103) (`8d1b2fd`)
- **2026-07-08 22:56 (KST)** — feat: 리서치 인사이트 자동수집 모듈 (McKinsey RSS + Claude 큐레이션 → R2) (#102) (`244c971`)
- **2026-07-08 22:49 (KST)** — preview에서는 요일 무관하게 리서치 인사이트 항상 노출 (#101) (`10fb71a`)
- **2026-07-08 22:31 (KST)** — 리서치 인사이트 섹션 추가 (수/금 노출) (#100) (`e5e6894`)
- **2026-07-08 22:20 (KST)** — feat: 발송리포트 gmail 병행 발송 + 수신처 전체 리스트 + 전체/성공/실패 요약 (#99) (`b9d719c`)
- **2026-07-08 22:17 (KST)** — 발송 2-pass 재대조 재발송 + 구독자 read 하드닝 + 일일 발송리포트 (#98) (`35d5362`)
- **2026-07-08 00:16 (KST)** — Use arrows for news opportunity and threat (`5903fc4`)
- **2026-07-07 11:48 (KST)** — fix: 수신거부 2단계 처리 — 메일 스캐너 GET 오탈퇴 방지 (#96) (`ba7c55f`)
- **2026-07-06 23:11 (KST)** — 선택 소스(§2-10) 추가: EIA API(美 휘발유 가격)·NewsAPI(실시간 뉴스). 무료 티어, 현재 미연결 — 필요 시 활성.
- **2026-07-06 20:28 (KST)** — 소스 인벤토리에 가전 기술 트렌드(§2-8: CES/CTA·GlobalSpec·HomeWorld·ukwhitegoods RSS·OEM 뉴스룸)·연관 영향 산업(§2-9: ACHR News 냉매규제·NIQ/GfK·SupplyChainBrain·DOE/ENERGY STAR) 추가. 자동수집 우선순위 명시.
- **2026-07-06 20:19 (KST)** — 데이터 소스 인벤토리에 한국은행(§2-6, ECOS 오픈API + 게시판 폴링)·글로벌 컨설팅사 인사이트(§2-7, McKinsey RSS 백본 + 8개사 부정기) 추가. C 유형(기술/경쟁)·수요/원가 보강 소스.
- **2026-07-06 12:31 (KST)** — 배포 항목 정정: 수동 `wrangler deploy` → `deploy.yml` Actions 자동 배포(실제 상태 반영). 사이트 업데이트 시 이 가이드 스탬프·이력을 자동 적립하는 `guide-sync.yml` 워크플로 도입.
- **2026-07-06 07:13 (KST)** — 최초 저장. 07-05~06 발송본 개편 반영: 섹션 명칭(수요/원가 시그널·시장 동향·기획 인사이트), 히어로 '오늘의 맥락'→'오늘의 한 줄'(대응평가 제거·1~2문장 압축), CI 보드 연동, 추이 그래프 유불리 색·헤드룸.
