// src/insights.js — 리서치 인사이트 자동수집 (RSS 후보 + Claude API 큐레이션)
//
// McKinsey RSS로 최근 인사이트 후보를 확보하고, Claude(claude-sonnet-4-5 + web_search)로
// 삼성 DA 기획 관점(가전·스마트홈·HVAC·구독·소비·원가) 관련 리포트 6개를 선별·카드화하여
// R2 signals/insights-feed.json 에 저장한다. index.js의 loadInsights가 이 파일을 우선 읽고,
// 없거나 실패하면 코드 내장 SEED로 폴백한다. 주간 1회 신선도 가드(같은 ISO주차면 skip).
//
// 중복 발행 방지(2026-09-04 추가): 최근 발행 이력을 R2 signals/insights-feed.history.json에
// 누적 저장(최대 INSIGHTS_HISTORY_MAX개)하고, 매 회차 큐레이션 프롬프트에 이 이력을 넣어
// "이미 나온 리포트·같은 정기지표의 구 발표치 재사용" 금지를 지시한다. AI가 지시를 놓친 경우를
// 대비해 dedupeAgainstHistory()로 URL·정규화 제목이 겹치는 카드를 기계적으로도 한 번 더 거른다.
//
// 트리거: index.js 라우트 /refresh-insights?key=... (수동/외부 스케줄러) · /preview?refresh=insights&key=...
//         발송(run)과 독립적인 데이터 갱신이라 실발송 hold와 무관하게 안전.

const INSIGHTS_KEY = "signals/insights-feed.json";
const INSIGHTS_STAMP_KEY = "signals/insights-feed.stamp.json"; // 주간 신선도 스탬프
const INSIGHTS_HISTORY_KEY = "signals/insights-feed.history.json"; // 중복 방지용 최근 발행 이력(제목·URL)
const INSIGHTS_HISTORY_MAX = 60; // 주 6개 기준 약 10주치까지 이력 보관 — 그 이전 것은 자연 소멸(재사용 허용)
const MCKINSEY_RSS = "https://www.mckinsey.com/insights/rss";
const UA = { headers: { "User-Agent": "Mozilla/5.0" } };

function isoWeek(d) {
  const dt = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = dt.getUTCDay() || 7;
  dt.setUTCDate(dt.getUTCDate() + 4 - day);
  const yStart = new Date(Date.UTC(dt.getUTCFullYear(), 0, 1));
  const wk = Math.ceil((((dt - yStart) / 86400000) + 1) / 7);
  return `${dt.getUTCFullYear()}-W${String(wk).padStart(2, "0")}`;
}

// 카드 date 문자열("2026.06"·"2026.06.23"·"2026-06"·"2025")에서 연·월을 뽑아 월 인덱스로 변환.
// 월을 특정할 수 없으면(연도만 표기 등) null → 보수적으로 노출 대상에서 제외한다.
function parseCardMonth(s) {
  if (typeof s !== "string") return null;
  const m = s.match(/(20\d{2})\s*[.\-/\uB144]\s*(\d{1,2})/);
  if (!m) return null;
  const y = Number(m[1]), mo = Number(m[2]);
  if (!(mo >= 1 && mo <= 12)) return null;
  return y * 12 + (mo - 1);
}

// 리서치 인사이트 카드 노출 필터: 당월 포함 최근 N개월(기본 3) 발행분만 통과.
// 예) 오늘이 2026-08이면 2026.06 ~ 2026.08 카드만 남긴다. 월 미상 카드는 제외.
// index.js의 loadInsights(R2 피드·SEED 양쪽)와 curateInsights(저장 직전) 두 지점에서 함께 사용.
export function filterRecentInsights(cards, months = 3, now = new Date()) {
  if (!Array.isArray(cards)) return [];
  const kst = new Date(now.getTime() + 9 * 36e5); // KST 기준 당월 산정
  const cur = kst.getUTCFullYear() * 12 + kst.getUTCMonth();
  const min = cur - (Math.max(1, months) - 1);
  return cards.filter(c => {
    const k = parseCardMonth(c && c.date);
    return k !== null && k >= min && k <= cur + 1; // 미래 표기 1개월까지는 오차 허용
  });
}

// 원문 링크 실시간 검증 — 큐레이션 모델이 지어낸 게시판 코드(존재하지 않는 board id)나
// 죽은 링크, 같은 게시판의 엉뚱한 과거 글, 또는 (확신 없을 때 도망치는) 목록/검색/메인 페이지로
// 잘못 연결하는 사례를 잡아낸다.
// 정책(2026-09-02 개정, 2026-09-04 강화): 링크를 대체 URL(게시판 목록 등)로 강등하지 않는다 —
// 확인 안 되면 카드 자체를 뉴스레터에서 제외한다.
// bok.or.kr(전자정부 표준프레임워크, view.do/list.do/search.do류) 도메인은 상세글(nttId 파라미터가
// 있는 view.do) 형태여야만 "검증 대상"으로 인정한다 — list.do·search.do·main.do 등 게시판
// 목록/검색/인덱스류는 특정 글을 가리키지 않으므로 즉시 검증 실패 처리한다.
// (구버전 버그: bok.or.kr인데도 상세글 형태가 아니면 연도 대조 없이 그냥 true를 반환해
// list.do가 통과됨.) McKinsey·Deloitte·BCG 등 다른 도메인은 애초에 view.do/nttId 패턴을
// 쓰지 않으므로 이 제약을 적용하지 않고 기존처럼 200 응답 + (있다면) 연도 대조만 확인한다.
async function verifyUrl(url, dateHint = "") {
  if (!url) return false;
  const isBok = /(^|\.)bok\.or\.kr\//i.test(url) || /bok\.or\.kr/i.test(url);
  const isDetailPage = /[?&]nttId=/i.test(url) || /\/view\.do/i.test(url);
  if (isBok && !isDetailPage) return false; // bok.or.kr인데 list.do/search.do 등 → 즉시 실패
  try {
    const res = await fetch(url, { headers: UA.headers, redirect: "follow" });
    if (!res.ok) return false; // 404/410/500 등 = 연결 안 됨
    if (isDetailPage) {
      const ym = typeof dateHint === "string" ? dateHint.match(/(20\d{2})/) : null;
      if (ym) {
        const text = await res.text();
        if (!text.includes(ym[1])) return false; // 카드 발행연도가 본문에 없음 → 오연결 의심, 제외
      }
    }
    return true;
  } catch {
    return false; // 타임아웃/네트워크 오류도 "연결 안 됨"과 동일하게 취급
  }
}

// 최근 발행 이력 로드/저장 — R2 signals/insights-feed.history.json.
// {title,url,source,date,week}[] 형태로, refreshInsights가 매 회차 성공 시 append한다.
async function loadInsightsHistory(env) {
  try {
    const o = await env.RESEARCH.get(INSIGHTS_HISTORY_KEY);
    if (!o) return [];
    const arr = await o.json();
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}
async function saveInsightsHistory(env, history) {
  try {
    await env.RESEARCH.put(INSIGHTS_HISTORY_KEY, JSON.stringify(history), { httpMetadata: { contentType: "application/json" } });
  } catch { /* 이력 저장 실패는 카드 발행 자체를 막지 않음(best-effort) */ }
}

// 제목 비교용 정규화 — 공백·구두점·대소문자 차이로 같은 리포트가 다른 문자열로 인식되는 것을 방지.
// (예: "AI 도입은 생산성을 높이는가? 초기 3년" vs "AI 도입, 생산성 향상 지표 아직 불명확"처럼
//  같은 리포트를 제목만 바꿔 재포장한 경우까지는 문자열 정규화만으론 못 잡으므로, 이건 프롬프트
//  지시(이력 목록 대조)로 1차 방어하고 여기서는 완전/거의 동일 제목·URL 재사용만 기계적으로 차단한다.)
function normTitle(s) {
  return (s || "").toLowerCase().replace(/[\s.,'"()·\-–—:;/?!]/g, "");
}

// 큐레이션 결과에서 최근 이력과 URL 또는 정규화 제목이 겹치는 카드를 제거한다.
// AI가 프롬프트의 "중복 금지" 지시를 놓쳤을 때의 2차(기계적) 방어선.
function dedupeAgainstHistory(cards, history) {
  const histUrls = new Set((history || []).map(h => h.url).filter(Boolean));
  const histTitles = new Set((history || []).map(h => normTitle(h.title)).filter(Boolean));
  return (cards || []).filter(c => !(c.url && histUrls.has(c.url)) && !histTitles.has(normTitle(c.title)));
}

// McKinsey 전사 RSS → [{title,url,date,summary}] (URL 경로로 DA 인접 토픽 우선 정렬)
async function fetchMckinseyRss(limit = 20) {
  try {
    const res = await fetch(MCKINSEY_RSS, UA);
    if (!res.ok) return [];
    const xml = await res.text();
    const items = [];
    const re = /<item>([\s\S]*?)<\/item>/g;
    let m;
    while ((m = re.exec(xml)) && items.length < limit) {
      const b = m[1];
      const pick = tag => {
        const r = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`).exec(b);
        return r ? r[1].replace(/<!\[CDATA\[|\]\]>/g, "").replace(/<[^>]+>/g, "").trim() : "";
      };
      const url = pick("link") || pick("guid");
      items.push({ title: pick("title"), url, date: pick("pubDate"), summary: pick("description").slice(0, 400) });
    }
    // DA 인접 토픽(소비재·리테일·산업·스마트홈·성장마케팅) URL·제목 우선
    const kw = /consumer|retail|industrial|growth-marketing|operations|semiconductor|smart|home|appliance|packaged/i;
    return items.filter(x => x.title && x.url)
      .sort((a, b) => (kw.test(b.url + b.title) ? 1 : 0) - (kw.test(a.url + a.title) ? 1 : 0));
  } catch { return []; }
}

// Claude(claude-sonnet-4-5 + web_search)로 RSS 후보 + 한국은행·타 컨설팅 최근분을 DA 카드 6개로 큐레이션.
// fetchFreightViaSearch와 동일 패턴(JSON만 반환). 실패 시 null → 기존 피드/SEED 유지.
async function curateInsights(env, candidates, history) {
  const cand = (candidates || []).slice(0, 12)
    .map((c, i) => `${i + 1}. [${c.date || ""}] ${c.title} — ${c.url}`).join("\n");
  const hist = (history || []).slice(-INSIGHTS_HISTORY_MAX)
    .map((h, i) => `${i + 1}. [${h.week || h.date || ""}] ${h.title} — ${h.url}`).join("\n");
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({
      model: "claude-sonnet-4-5",
      max_tokens: 3000,
      tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 6 }],
      system: [
        "삼성전자 생활가전(DA) 기획팀 데일리 뉴스레터의 '리서치 인사이트' 카드를 큐레이션한다.",
        "글로벌 컨설팅사(McKinsey·BCG·Deloitte·Bain·Accenture·PwC·Kearney·Roland Berger·Oliver Wyman)와 한국은행(경제전망·금융안정보고서·BOK 이슈노트·소비자동향조사)의 '최근 약 1개월 내' 발행물 중, DA 기획에 유용한 것 6개를 고른다.",
        "DA 관련 우선순위: 생활가전·스마트홈·AI가전·HVAC/공조·빌트인·구독/렌탈(HaaS)·소비지출·소비심리·내구재수요·프리미엄·D2C·미국주택시장·관세/공급망·원자재·경쟁사(LG전자 등).",
        "제공된 McKinsey RSS 후보를 우선 검토하고, web_search로 한국은행 최근 발표(소비자심리 CCSI·기업경기 BSI·수입물가·이슈노트)와 타 컨설팅 최신분을 보강해 발행일·수치를 확인한다. 발행일이 오래됐거나 불확실하면 제외한다.",
        "한국은행(bok.or.kr) 카드는 web_search로 실제로 확인한 정확한 원문 상세 링크(view.do?nttId=...)를 써라. board id·menuNo·nttId 어느 것도 추측·창작하지 말 것 — 검색 결과에 실제로 뜬 URL을 그대로 사용한다. list.do·search.do 등 게시판 목록/검색 페이지는 어떤 경우에도 대체 URL로 쓰지 말 것 — 시스템이 이런 목록형 URL은 무조건 검증 실패로 처리해 카드째 제외한다. web_search로 nttId를 끝내 확정하지 못하면 그 리포트는 포기하고, 후보에서 nttId를 확정할 수 있는 다른 한국은행 발표(또는 다른 컨설팅사 리포트)로 교체하라 — 6개를 채우는 것보다 링크 정확성이 우선이다.",
        "★발행일 상한★: 카드의 date는 반드시 오늘 기준 당월 포함 최근 3개월 이내여야 하며(예: 오늘이 2026-08이면 2026.06 이후), 그 밖은 제외한다. 연도만 쓰지 말고 반드시 'YYYY.MM' 또는 'YYYY.MM.DD'로 표기한다.",
        "★수치 기준 시점 검증(발행일과 별개)★: 카드의 stat·cap이 인용하는 수치가 실제로 가리키는 기준 시점(예: CCSI라면 몇 월 자료인지)을 확인해, 오늘 기준 최근 3개월 이내(예: 오늘이 2026-07이면 2026-05 이후) 자료가 아니면 그 카드는 제외한다. 보고서·기사의 발행일이 최근이어도, 인용된 수치 자체가 3개월을 넘는 과거 자료(재게시·구버전 캐시 등)이면 동일하게 제외한다.",
        "Deloitte는 한국어 허브(deloitte.com/kr)를 우선 탐색한다 — 월간 Trend Tracker(/kr/ko/our-thinking/Monthly-Trend-Tracker/, '이번 달 발간분' 인덱스)·주간 글로벌 경제리뷰(/kr/ko/our-thinking/global-economic-review/, 매주 금요일·발행일 명확)·Consumer Signals(분기, 국내 소비심리)에서 최근 1개월 발행분을 확인하고, 국내 시사점이 담긴 한국어 리포트를 우선한다. domain은 deloitte.com으로 표기.",
        "★중복 발행 금지★: 사용자 메시지의 '최근 발행 이력'에 이미 나온 리포트는 절대 다시 고르지 않는다. 제목·URL이 완전히 같은 경우는 물론, 같은 리포트를 제목만 바꿔 재포장한 경우, 같은 정기 지표(예: 한국은행 CCSI·BSI)를 새 발표치 없이 지난 수치 그대로 다시 쓰는 경우도 모두 중복으로 간주해 제외한다. 정기 지표는 web_search로 '지난 이력의 기준월보다 더 최근 발표'가 있는지 반드시 확인하고, 더 최근 발표가 없다면 그 지표는 이번 회차에서 아예 빼고 다른 리포트로 대체한다 — 지표가 없다는 이유로 옛 카드를 재사용하지 않는다.",
        "6개 중 최소 1개는 source를 '균형 관점'으로 두어, 나머지 카드의 낙관적 서술에 대한 반대·신중 근거(예: 'AI 생산성 효과는 아직 불명확')를 담는다.",
        "각 카드는 아래 JSON 스키마. 배열만 반환(코드펜스·설명·인사말 금지):",
        '[{"source":"McKinsey","domain":"mckinsey.com","date":"2026.06","title":"리포트 요지 한 줄","stat":"79%","cap":"수치 설명 한 구","impl":"DA 시사점 한 문장","url":"https://...","image":""}]',
        "- source: 발행기관명(또는 '균형 관점'). domain: 로고용 도메인(mckinsey.com·deloitte.com·bcg.com·bok.or.kr 등).",
        "- title: 리포트 핵심을 한 줄로(40자 내외). stat: 강조 수치(예 '79%'·'106.6'·'초기'). cap: stat 부연 한 구(60자 이내).",
        "- impl: 이 인사이트가 DA 기획에 갖는 의미 한 문장(80자 이내). 시작말을 카드마다 변주('당사도'·'우리 DA엔'·'당사 관점에선'·'경쟁 측면에선'·'한편'). 실행 지시가 아니라 시사점 서술.",
        "- url: 실제 리포트 원문 링크(후보 URL 또는 web_search로 찾은 정확한 주소). image: og:image를 알면 https URL, 모르면 빈 문자열.",
        "- 수치·발행일은 창작하지 말고 확인된 것만. 확인 안 되면 그 카드를 빼고 다른 리포트로 채운다. 정확히 6개.",
      ].join("\n"),
      messages: [{ role: "user", content: `McKinsey RSS 최근 후보:\n${cand || "(후보 없음 — web_search로 직접 탐색)"}\n\n최근 발행 이력(아래와 동일·사실상 동일한 리포트는 절대 재선택 금지):\n${hist || "(이력 없음 — 첫 회차)"}\n\n위를 참고하고 web_search로 보강해 DA 리서치 인사이트 카드 6개를 스키마대로 JSON 배열만 반환.` }],
    }),
  });
  if (!res.ok) return null;
  const j = await res.json();
  const t = (j.content || []).filter(b => b.type === "text").map(b => b.text).join("").trim();
  const mm = t.replace(/```json|```/g, "").match(/\[[\s\S]*\]/);
  if (!mm) return null;
  let arr; try { arr = JSON.parse(mm[0]); } catch { return null; }
  if (!Array.isArray(arr)) return null;
  // 스키마 정규화·방어 (필드 클램프, https만 허용)
  const clamp = (v, n) => typeof v === "string" ? v.trim().slice(0, n) : "";
  const https = u => (typeof u === "string" && /^https:\/\//i.test(u)) ? u : "";
  const cards = arr.map(c => ({
    source: clamp(c.source, 20) || "리서치",
    domain: clamp(c.domain, 40),
    date: clamp(c.date, 12),
    title: clamp(c.title, 80),
    stat: clamp(c.stat, 16),
    cap: clamp(c.cap, 90),
    impl: clamp(c.impl, 120),
    url: https(c.url),
    image: https(c.image),
  })).filter(c => c.title && c.url);
  // 프롬프트 지시를 놓쳤을 경우의 2차 방어선 — 최근 이력과 URL/제목이 겹치는 카드를 기계적으로 제거.
  const deduped = dedupeAgainstHistory(cards, history);
  // 원문 링크 실시간 검증 — 연결 안 되거나(404/타임아웃) 상세글 본문이 발행연도와 안 맞으면
  // 대체 링크로 강등하지 않고 카드 자체를 제외한다(정책 2026-09-02).
  const checked = await Promise.all(deduped.map(async c => (await verifyUrl(c.url, c.date)) ? c : null));
  const verified = checked.filter(Boolean);
  // 발행일 최근 3개월(당월 포함) 이내만 저장 — 프롬프트 준수 실패 시의 2차 방어선.
  const fresh = filterRecentInsights(verified).slice(0, 6);
  return fresh.length ? fresh : null;
}

// 메인: 주간 가드 → RSS 후보 → Claude 큐레이션 → R2 저장. opts.force로 가드 무시.
export async function refreshInsights(env, opts = {}) {
  if (!env || !env.RESEARCH) return { ok: false, reason: "no_r2" };
  if (!env.ANTHROPIC_API_KEY) return { ok: false, reason: "no_api_key" };
  const wk = isoWeek(new Date());
  if (!opts.force) {
    try {
      const o = await env.RESEARCH.get(INSIGHTS_STAMP_KEY);
      if (o) { const s = await o.json(); if (s && s.week === wk) return { ok: true, skipped: true, week: wk }; }
    } catch { /* 계속 진행 */ }
  }
  const rss = await fetchMckinseyRss();
  const history = await loadInsightsHistory(env);
  const cards = await curateInsights(env, rss, history);
  if (!cards) return { ok: false, reason: "curate_failed" };
  try {
    await env.RESEARCH.put(INSIGHTS_KEY, JSON.stringify(cards), { httpMetadata: { contentType: "application/json" } });
    await env.RESEARCH.put(INSIGHTS_STAMP_KEY, JSON.stringify({ week: wk, at: Date.now(), count: cards.length, rss: rss.length }), { httpMetadata: { contentType: "application/json" } });
    // 이번 회차 카드를 이력에 append(URL 기준 dedupe) 후 최근 INSIGHTS_HISTORY_MAX개만 보관.
    const nextHistory = [...history, ...cards.map(c => ({ title: c.title, url: c.url, source: c.source, date: c.date, week: wk }))]
      .filter((h, i, arr) => !h.url || arr.findIndex(x => x.url === h.url) === i)
      .slice(-INSIGHTS_HISTORY_MAX);
    await saveInsightsHistory(env, nextHistory);
  } catch (e) { return { ok: false, reason: "store_failed" }; }
  return { ok: true, count: cards.length, week: wk, rssCandidates: rss.length };
}
