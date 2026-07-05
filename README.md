# samsungda-newsletter

기획 도구모음 **일간 이메일 뉴스레터** — Cloudflare Worker + Cron Trigger.

## 소스 4종
| 섹션 | 출처 |
| --- | --- |
| 시장지표 | Yahoo(`^IXIC`·`^TNX`·`CL=F`·`^KS11`) + F&G(`ten-bagger/signals.json`) |
| 가전 주요뉴스 | `mi.samsungda.net/data/news.json` (최근 24h, 등급·영향도 상위 5) |
| 아이디어 뱅크 | R2 `samsungda-research` `idea-bank/*.json` (최신 5, 저장된 것 그대로) |
| 클로드 작성 보고서 | R2 `samsungda-research` 루트 업로드(docx) 최신 5 |

보고서·아이디어뱅크는 `report-idea`/포털과 **같은 R2 버킷**을 공유한다(바인딩 `RESEARCH`).

## 동작
- **Cron**(`45 22 * * 1-5` = 07:45 KST 화~토) → `scheduled()` → 수집 → HTML 조립 → Resend 발송 → R2 아카이브
- `GET /preview` : 발송 없이 HTML 미리보기
- `GET /` `GET /latest` : 최신 발행분 열람(R2 아카이브)
- `GET /send?key=<TRIGGER_KEY>` : 수동 발송(테스트)

## 배포 전 세팅 (필수)
1. **Resend**: 가입 → `samsungda.net` 도메인 인증(SPF·DKIM·DMARC DNS, CF DNS에 추가) → API 키
2. **Cloudflare**: 이 repo를 Workers Build에 연결(Production `main`). R2 바인딩·Cron은 `wrangler.jsonc`로 자동.
3. **Secrets** (대시보드 또는 wrangler):
   ```bash
   wrangler secret put RESEND_API_KEY   # re_...
   wrangler secret put RECIPIENTS       # a@x.com,b@y.com (쉼표구분)
   wrangler secret put TRIGGER_KEY      # (선택) /send 보호용 임의 문자열
   wrangler secret put FRED_API_KEY     # FRED 공식 API 키 (CPI·주택·철강 등 거시지표)
   ```
4. **FRED API**: `FRED_API_KEY`가 있으면 공식 API로 조회하고, 성공 응답은 R2 `signals/fred/*.json`에 캐시해 일시 장애 때 직전 성공값을 사용합니다.
5. **발신 주소**: `wrangler.jsonc`의 `vars.FROM` (기본 `newsletter@samsungda.net`) — 인증한 도메인과 일치해야 함.

## 미리보기·아카이브 도메인(선택)
`newsletter.samsungda.net` 커스텀 도메인을 붙이면 `/preview`·`/latest`를 브라우저에서 열람 가능.


## 운임지수 수동 갱신
SCFI/FBX는 cron·발송 시 주 1회 web_search로 갱신해 R2 `signals/fbx.json`에 캐시합니다. 미리보기에서 즉시 갱신하려면 보호 키를 붙여 호출합니다.

```bash
/refresh-freight?key=<TRIGGER_KEY>
/preview?refresh=freight&key=<TRIGGER_KEY>
```

SCFI 공식 페이지는 Shanghai Shipping Exchange 영문 SCFI 페이지(`https://en.sse.net.cn/indices/scfinew.jsp`)를 우선 확인하되, 공개 JSON API가 없어 이미지/로그인 제한으로 직접 추출이 안 되면 신뢰 가능한 해운·물류 보도 최신치를 web_search로 보완합니다.
## 디자인
DA 토큰(흰 배경·`#1257d6`·라운드 카드). 이메일 클라이언트 호환 위해 table+inline CSS, 한글 시스템 폰트 폴백.
