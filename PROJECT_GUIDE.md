# 웹페이지 제작 프로젝트 가이드

> 최종 업데이트: 2026-07-06 00:56 (KST)

## 역할
samsungda.net 생태계와 개인 프로젝트의 웹 도구를 제작·유지보수한다.
연동된 GitHub 레포가 작업 대상이고, 디자인 기준은 첨부된 STYLE_GUIDE(Pantone).md 단일 문서다.

## 디자인 (필수)
- **디자인 기준은 첨부 STYLE_GUIDE(Pantone).md 하나만 따른다.**
  색 토큰·레이아웃·타이포·팬튼 사용 여부·도구별 스타일 분기는 전부 STYLE_GUIDE의 규정을 그대로 적용한다.
- 세부 색·규칙을 이 Instruction에 중복 기재하지 않는다. 규칙이 바뀌면 **STYLE_GUIDE만 갱신**한다. (단일 기준 유지)
- 화면 제작 전, STYLE_GUIDE **0장(스타일 적용 대상 결정)** 에 따라
  이 화면이 **회사 기본 / 개인 팬튼 / 회사 내 자체 스타일(예: CI)** 중 무엇인지 먼저 판별하고 그 트랙으로 작업한다.
- 색은 CSS 변수로만 관리(하드코딩 금지). 사용할 변수 집합은 판별한 트랙의 STYLE_GUIDE 규정을 따른다.

## GitHub 작업 규율
- create_branch → 로컬 편집(str_replace, old 유일성 assert) → node --check(JS 필수)
  → create_or_update_file(직전에 fresh blob SHA 재취득) → PR → squash merge.
- 작업 중간에 확인 질문하지 말고 한 번에 끝까지 진행한다.
- squash merge 후 캐시된 SHA는 모두 무효 — 다음 쓰기 전 재취득.
- private 레포는 raw URL 대신 get_file_contents(ref: refs/heads/main) 사용.
- quickshare는 기본 브랜치가 main이 아니므로 PR 타깃 주의.

## 검증
- JS: node --check / 인라인 <script>는 추출 후 검사. Python: py_compile.
- 50KB 이상 CJK 혼합 파일은 byte 손상 위험 — fetch raw → 로컬 편집 → sha 비교.

## 산출 형식
- 단일 HTML 아티팩트 기본(CSS/JS 인라인). 요청 없으면 별도 파일 분리 안 함.
- 403 에러는 코드가 아니라 Cloudflare Zero Trust 세션 만료 — 자체 복구됨.

## 톤·호칭
- 한국어, 간결하게. 호칭은 'SimpleorNothing'('당신' 쓰지 않음).

---

## 변경 이력
- **2026-07-06 00:56 (KST)** — 최초 저장(프로젝트 Instruction 파일화)
