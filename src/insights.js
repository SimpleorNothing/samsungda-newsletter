// src/insights.js — 리서치 인사이트 자동수집 (RSS 후보 + Claude API 큐레이션)
//
// McKinsey RSS로 최근 인사이트 후보를 확보하고, Claude(claude-sonnet-4-5 + web_search)로
// 삼성 DA 기획 관점(가전·스마트홈·HVAC·구독·소비·원가) 관련 리포트 6개를 선별·카드화하여
// R2 signals/insights-feed.json 에 저장한다. index.js의 loadInsights가 이 파일을 우선 읽고,
// 없거나 실패하면 코드 내장 SEED로 폴백한다. 주간 1회 신선도 가드(같은 ISO주차면 skip).
//
// 트리거: index.js 라우트 /refresh-insights?key=... (수동/외부 스케줄러) · /preview?refresh=insights&key=...
//         발송(run)과 독립적인 데이터 갱신이라 실발송 hold와 무관하게 안전.

const INSIGHTS_KEY = "signals/insights-feed.json";
const INSIGHTS_STAMP_KEY = "signals/insights-feed.stamp.json"; // 주간 신선도 스탬프
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
async function curateInsights(env, candidates) {
  const cand = (candidates || []).slice(0, 12)
    .map((c, i) => `${i + 1}. [${c.date || ""}] ${c.title} — ${c.url}`).join("\n");
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
        "★수치 기준 시점 검증(발행일과 별개)★: 카드의 stat·cap이 인용하는 수치가 실제로 가리키는 기준 시점(예: CCSI라면 몇 월 자료인지)을 확인해, 오늘 기준 최근 3개월 이내(예: 오늘이 2026-07이면 2026-05 이후) 자료가 아니면 그 카드는 제외한다. 보고서·기사의 발행일이 최근이어도, 인용된 수치 자체가 3개월을 넘는 과거 자료(재게시·구버전 캐시 등)이면 동일하게 제외한다.",
        "Deloitte는 한국어 허브(deloitte.com/kr)를 우선 탐색한다 — 월간 Trend Tracker(/kr/ko/our-thinking/Monthly-Trend-Tracker/, '이번 달 발간분' 인덱스)·주간 글로벌 경제리뷰(/kr/ko/our-thinking/global-economic-review/, 매주 금요일·발행일 명확)·Consumer Signals(분기, 국내 소비심리)에서 최근 1개월 발행분을 확인하고, 국내 시사점이 담긴 한국어 리포트를 우선한다. domain은 deloitte.com으로 표기.",
        "6개 중 최소 1개는 source를 '균형 관점'으로 두어, 나머지 카드의 낙관적 서술에 대한 반대·신중 근거(예: 'AI 생산성 효과는 아직 불명확')를 담는다.",
        "각 카드는 아래 JSON 스키마. 배열만 반환(코드펜스·설명·인사말 금지):",
        '[{"source":"McKinsey","domain":"mckinsey.com","date":"2026.06","title":"리포트 요지 한 줄","stat":"79%","cap":"수치 설명 한 구","impl":"DA 시사점 한 문장","url":"https://...","image":""}]',
        "- source: 발행기관명(또는 '균형 관점'). domain: 로고용 도메인(mckinsey.com·deloitte.com·bcg.com·bok.or.kr 등).",
        "- title: 리포트 핵심을 한 줄로(40자 내외). stat: 강조 수치(예 '79%'·'106.6'·'초기'). cap: stat 부연 한 구(60자 이내).",
        "- impl: 이 인사이트가 DA 기획에 갖는 의미 한 문장(80자 이내). 시작말을 카드마다 변주('당사도'·'우리 DA엔'·'당사 관점에선'·'경쟁 측면에선'·'한편'). 실행 지시가 아니라 시사점 서술.",
        "- url: 실제 리포트 원문 링크(후보 URL 또는 web_search로 찾은 정확한 주소). image: og:image를 알면 https URL, 모르면 빈 문자열.",
        "- 수치·발행일은 창작하지 말고 확인된 것만. 확인 안 되면 그 카드를 빼고 다른 리포트로 채운다. 정확히 6개.",
      ].join("\n"),
      messages: [{ role: "user", content: `McKinsey RSS 최근 후보:\n${cand || "(후보 없음 — web_search로 직접 탐색)"}\n\n위를 참고하고 web_search로 보강해 DA 리서치 인사이트 카드 6개를 스키마대로 JSON 배열만 반환.` }],
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
  })).filter(c => c.title).slice(0, 6);
  return cards.length ? cards : null;
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
  const cards = await curateInsights(env, rss);
  if (!cards) return { ok: false, reason: "curate_failed" };
  try {
    await env.RESEARCH.put(INSIGHTS_KEY, JSON.stringify(cards), { httpMetadata: { contentType: "application/json" } });
    await env.RESEARCH.put(INSIGHTS_STAMP_KEY, JSON.stringify({ week: wk, at: Date.now(), count: cards.length, rss: rss.length }), { httpMetadata: { contentType: "application/json" } });
  } catch (e) { return { ok: false, reason: "store_failed" }; }
  return { ok: true, count: cards.length, week: wk, rssCandidates: rss.length };
}
