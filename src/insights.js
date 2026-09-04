// src/insights.js — 리서치 인사이트 자동수집 (B안: 주1회 15개 풀 + 요일별 3개 노출)
//
// 주 1회 Claude + web_search로 월~금 각 3개, 총 15개의 리서치 카드를 미리 큐레이션해
// R2 signals/insights-feed.json 에 저장한다. 실제 뉴스레터는 day 태그에 따라 하루 3개만 노출한다.
// 링크 정확도를 카드 수보다 우선하며, 정부/공공기관은 기관별 "상세 페이지" URL 형태를 먼저 검사한 뒤
// 실제 HTTP 응답과 발행연도까지 대조한다. 목록/검색/메인 URL로의 강등은 금지한다.

const INSIGHTS_KEY = "signals/insights-feed.json";
const INSIGHTS_STAMP_KEY = "signals/insights-feed.stamp.json";
const INSIGHTS_HISTORY_KEY = "signals/insights-feed.history.json";
const INSIGHTS_SCHEMA_VERSION = 2;
const INSIGHTS_DAYS = ["mon", "tue", "wed", "thu", "fri"];
const INSIGHTS_DAILY_COUNT = 3;
const INSIGHTS_WEEKLY_COUNT = INSIGHTS_DAYS.length * INSIGHTS_DAILY_COUNT;
const INSIGHTS_HISTORY_MAX = 150; // 15개/주 × 약 10주
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

function parseCardMonth(s) {
  if (typeof s !== "string") return null;
  const m = s.match(/(20\d{2})\s*[.\-/\uB144]\s*(\d{1,2})/);
  if (!m) return null;
  const y = Number(m[1]), mo = Number(m[2]);
  if (!(mo >= 1 && mo <= 12)) return null;
  return y * 12 + (mo - 1);
}

export function filterRecentInsights(cards, months = 3, now = new Date()) {
  if (!Array.isArray(cards)) return [];
  const kst = new Date(now.getTime() + 9 * 36e5);
  const cur = kst.getUTCFullYear() * 12 + kst.getUTCMonth();
  const min = cur - (Math.max(1, months) - 1);
  return cards.filter(c => {
    const k = parseCardMonth(c && c.date);
    return k !== null && k >= min && k <= cur + 1;
  });
}

function weekdayKeyFromDateString(dateStr) {
  const m = /^(\d{4})[.\-/](\d{2})[.\-/](\d{2})$/.exec(String(dateStr || ""));
  if (!m) return "";
  const n = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])).getUTCDay();
  return ({ 1: "mon", 2: "tue", 3: "wed", 4: "thu", 5: "fri" })[n] || "";
}

export function selectDailyInsights(cards, dateOrDay, now = new Date()) {
  const day = INSIGHTS_DAYS.includes(dateOrDay) ? dateOrDay : weekdayKeyFromDateString(dateOrDay);
  if (!day) return [];
  return filterRecentInsights(cards, 3, now)
    .filter(c => c && c.day === day)
    .slice(0, INSIGHTS_DAILY_COUNT);
}

function hostIs(host, domain) {
  const h = String(host || "").toLowerCase();
  return h === domain || h.endsWith(`.${domain}`);
}

// 공공기관 URL의 "상세 글" 형태를 기계적으로 검증한다.
// - BOK: view.do + nttId
// - 통계청: board.es + act=view + list_no
// - KIEP: gallery.es + act=view + list_no
// - KIET: *View 상세 endpoint + 문서 식별자(idx / *_no / list_no / seq 등)
// 일반 컨설팅/리서치 도메인은 이 형태 검증 대상이 아니며 실제 HTTP 응답 검증만 수행한다.
export function validateInstitutionDetailUrl(url) {
  let u;
  try { u = new URL(url); } catch { return false; }
  if (u.protocol !== "https:") return false;
  const host = u.hostname.toLowerCase();
  const path = u.pathname;
  const p = u.searchParams;

  if (hostIs(host, "bok.or.kr")) {
    return /\/view\.do$/i.test(path) && !!p.get("nttId");
  }
  if (hostIs(host, "kostat.go.kr")) {
    return /\/board\.es$/i.test(path) && String(p.get("act") || "").toLowerCase() === "view" && !!p.get("list_no");
  }
  if (hostIs(host, "kiep.go.kr")) {
    return /\/gallery\.es$/i.test(path) && String(p.get("act") || "").toLowerCase() === "view" && !!p.get("list_no");
  }
  if (hostIs(host, "kiet.re.kr")) {
    const detailPath = /View$/i.test(path);
    const idKey = [...p.keys()].find(k => /^(?:idx|list_no|seq|no|[a-z][a-z0-9_]*_no)$/i.test(k) && p.get(k));
    return detailPath && !!idKey;
  }
  return true;
}

function isInstitutionUrl(url) {
  try {
    const h = new URL(url).hostname.toLowerCase();
    return ["bok.or.kr", "kostat.go.kr", "kiep.go.kr", "kiet.re.kr"].some(d => hostIs(h, d));
  } catch { return false; }
}

async function verifyUrl(url, dateHint = "") {
  if (!url || !validateInstitutionDetailUrl(url)) return false;
  try {
    const res = await fetch(url, { headers: UA.headers, redirect: "follow" });
    if (!res.ok) return false;

    // 공공기관 상세글은 "페이지 존재"만으로 부족하므로 카드 발행연도가 실제 본문에 있는지 대조한다.
    if (isInstitutionUrl(url)) {
      const ym = typeof dateHint === "string" ? dateHint.match(/(20\d{2})/) : null;
      if (ym) {
        const text = await res.text();
        if (!text.includes(ym[1])) return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

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
    await env.RESEARCH.put(INSIGHTS_HISTORY_KEY, JSON.stringify(history), {
      httpMetadata: { contentType: "application/json" },
    });
  } catch { /* best effort */ }
}

function normTitle(s) {
  return (s || "").toLowerCase().replace(/[\s.,'"()·\-–—:;/?!]/g, "");
}

function dedupeCards(cards) {
  const urls = new Set(), titles = new Set(), out = [];
  for (const c of cards || []) {
    const u = c && c.url;
    const t = normTitle(c && c.title);
    if (!u || !t || urls.has(u) || titles.has(t)) continue;
    urls.add(u); titles.add(t); out.push(c);
  }
  return out;
}

function dedupeAgainstHistory(cards, history) {
  const histUrls = new Set((history || []).map(h => h.url).filter(Boolean));
  const histTitles = new Set((history || []).map(h => normTitle(h.title)).filter(Boolean));
  return (cards || []).filter(c => !(c.url && histUrls.has(c.url)) && !histTitles.has(normTitle(c.title)));
}

function takeDailyQuota(cards) {
  const out = [];
  for (const day of INSIGHTS_DAYS) {
    const part = (cards || []).filter(c => c.day === day).slice(0, INSIGHTS_DAILY_COUNT);
    if (part.length !== INSIGHTS_DAILY_COUNT) return null;
    out.push(...part);
  }
  return out.length === INSIGHTS_WEEKLY_COUNT ? out : null;
}

async function fetchMckinseyRss(limit = 24) {
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
    const kw = /consumer|retail|industrial|growth-marketing|operations|smart|home|appliance|hvac|robot|subscription|supply/i;
    return items.filter(x => x.title && x.url)
      .sort((a, b) => (kw.test(b.url + b.title) ? 1 : 0) - (kw.test(a.url + a.title) ? 1 : 0));
  } catch { return []; }
}

async function curateInsights(env, candidates, history) {
  const cand = (candidates || []).slice(0, 16)
    .map((c, i) => `${i + 1}. [${c.date || ""}] ${c.title} — ${c.url}`).join("\n");
  const hist = (history || []).slice(-INSIGHTS_HISTORY_MAX)
    .map((h, i) => `${i + 1}. [${h.week || h.date || ""}] ${h.title} — ${h.url}`).join("\n");

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-5",
      max_tokens: 6500,
      tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 15 }],
      system: [
        "삼성전자 생활가전(DA) 기획팀 데일리 뉴스레터의 '리서치 인사이트'를 B안(주1회 풀 큐레이션 + 요일별 부분표시)으로 만든다.",
        "이번 주에 사용할 카드 15개를 정확히 만든다. day는 mon/tue/wed/thu/fri를 각각 정확히 3개씩 배정한다. 같은 URL·같은 리포트를 요일만 바꿔 중복 사용하지 않는다.",
        "요일별 편성은 다음과 같다.",
        "- mon 국내 거시·산업경기: 한국은행(BOK), 산업연구원(KIET), 통계청을 우선. 소비·산업생산·내수·물가·경기·주택·수출입 등 DA 수요와 연결되는 자료.",
        "- tue 글로벌 경쟁전략: McKinsey, BCG, PwC, Accenture, Kearney, Roland Berger. 기업전략·AI·운영·제조·가격·서비스 모델 등. Oliver Wyman은 제외.",
        "- wed 소비자·유통 트렌드: Deloitte, Bain, NielsenIQ, GfK, Circana/NPD, Statista Insights. 소비심리·카테고리 지출·리테일·D2C·프리미엄/가성비·구매행동.",
        "- thu 신사업 기회 + 글로벌 거시: McKinsey/BCG의 AI홈·구독·로보틱스·스마트홈, KIEP, OECD Economic Outlook/관련 분석, IMF Blog/분석. 관세·공급망·무역·신사업을 우선.",
        "- fri 주간 종합 + 균형 관점: 월~목과 URL을 반복하지 않는 독립 리포트 3개로 주간 판단을 보완한다. 최소 1개는 source를 '균형 관점'으로 표기하고, 낙관적 서술의 반대·신중 근거를 담는다.",
        "최근 2개월 발행분을 우선하고, 필요한 경우 최대 최근 3개월까지만 허용한다. date는 반드시 YYYY.MM 또는 YYYY.MM.DD.",
        "DA 관련 우선순위: 생활가전·스마트홈·AI가전·HVAC/공조·빌트인·구독/렌탈(HaaS)·소비지출·내구재수요·프리미엄·D2C·미국주택·관세/공급망·원자재·경쟁사.",
        "수치(stat/cap)는 리포트가 실제로 말하는 수치만 쓰며 그 수치의 기준 시점도 최근 3개월인지 확인한다. 수치가 없으면 stat/cap을 빈 문자열로 둬도 된다. 확인되지 않은 숫자는 만들지 않는다.",
        "★원문 링크 원칙★: URL은 검색 결과에서 실제로 확인한 '개별 원문/상세 글' 주소만 사용한다. 목록·검색·메인·허브 페이지로 대체하지 않는다. 정확한 상세 URL을 못 찾으면 그 카드를 포기하고 다른 리포트로 교체한다.",
        "★BOK★ bok.or.kr은 반드시 /view.do 경로이면서 nttId 파라미터가 있는 실제 상세글 URL이어야 한다. list.do·search.do·main.do 금지.",
        "★통계청★ kostat.go.kr은 반드시 board.es? ... &act=view&list_no=... 형태의 실제 상세글 URL이어야 한다. board 목록·검색 URL 금지.",
        "★KIEP★ kiep.go.kr은 반드시 gallery.es?act=view&...&list_no=... 형태의 실제 발간물 상세 URL을 쓴다. menu.es나 목록 URL 금지.",
        "★KIET★ kiet.re.kr은 검색 결과에서 확인한 *View 상세 endpoint(예: trends/ecolookView?ecolook_no=...)와 고유 문서 식별자가 있는 URL만 사용한다. *List나 상위 메뉴 URL 금지.",
        "McKinsey RSS 후보는 우선 검토하되 RSS URL이 개별 리포트가 아닌 허브면 쓰지 말고 web_search로 개별 원문을 확인한다.",
        "★중복 금지★ 사용자 메시지의 최근 발행 이력에 있는 동일 URL·동일/사실상 동일 리포트는 재선택하지 않는다. 정기지표(BOK CCSI·BSI 등)는 더 최근 발표치가 있을 때만 새 카드로 허용한다.",
        "각 카드는 아래 스키마를 사용한다. JSON 배열만 반환하고 코드펜스·설명·인사말은 쓰지 않는다.",
        '[{"day":"mon","source":"한국은행","domain":"bok.or.kr","date":"2026.08.25","title":"리포트 요지 한 줄","stat":"111.4","cap":"수치 설명 한 구","impl":"삼성전자 DA 관점 시사점 한 문장","url":"https://...","image":""}]',
        "source는 발행기관명(금요일 균형 카드 1개는 '균형 관점'), domain은 favicon용 실제 발행 도메인, image는 og:image를 확실히 알 때만 https URL.",
        "title 60자 내외, cap 90자 이내, impl 120자 이내. impl은 실행 지시가 아니라 삼성전자 DA 관점의 시사점 서술.",
        "15개를 억지로 채우기 위해 부정확한 링크·오래된 자료·낮은 관련성 자료를 쓰지 않는다. 다만 최종 출력은 day별 3개가 필요하므로 불확실한 후보는 검색으로 교체해 정확히 15개를 만든다.",
      ].join("\n"),
      messages: [{
        role: "user",
        content: `McKinsey RSS 최근 후보:\n${cand || "(후보 없음 — web_search로 직접 탐색)"}\n\n최근 발행 이력(동일·사실상 동일 리포트 재선택 금지):\n${hist || "(이력 없음)"}\n\n이번 주 월~금 각 3개, 총 15개를 스키마대로 JSON 배열만 반환.`,
      }],
    }),
  });
  if (!res.ok) return null;

  const j = await res.json();
  const t = (j.content || []).filter(b => b.type === "text").map(b => b.text).join("").trim();
  const mm = t.replace(/```json|```/g, "").match(/\[[\s\S]*\]/);
  if (!mm) return null;
  let arr;
  try { arr = JSON.parse(mm[0]); } catch { return null; }
  if (!Array.isArray(arr)) return null;

  const clamp = (v, n) => typeof v === "string" ? v.trim().slice(0, n) : "";
  const https = u => (typeof u === "string" && /^https:\/\//i.test(u)) ? u.trim() : "";
  const cards = arr.map(c => ({
    day: INSIGHTS_DAYS.includes(c.day) ? c.day : "",
    source: clamp(c.source, 24) || "리서치",
    domain: clamp(c.domain, 50),
    date: clamp(c.date, 12),
    title: clamp(c.title, 90),
    stat: clamp(c.stat, 20),
    cap: clamp(c.cap, 100),
    impl: clamp(c.impl, 140),
    url: https(c.url),
    image: https(c.image),
  })).filter(c => c.day && c.title && c.url);

  const unique = dedupeCards(dedupeAgainstHistory(cards, history));
  const checked = await Promise.all(unique.map(async c => (await verifyUrl(c.url, c.date)) ? c : null));
  const fresh = filterRecentInsights(checked.filter(Boolean));
  return takeDailyQuota(fresh);
}

export async function refreshInsights(env, opts = {}) {
  if (!env || !env.RESEARCH) return { ok: false, reason: "no_r2" };
  if (!env.ANTHROPIC_API_KEY) return { ok: false, reason: "no_api_key" };

  const wk = isoWeek(new Date());
  if (!opts.force) {
    try {
      const o = await env.RESEARCH.get(INSIGHTS_STAMP_KEY);
      if (o) {
        const s = await o.json();
        if (s && s.week === wk && s.version === INSIGHTS_SCHEMA_VERSION && s.count === INSIGHTS_WEEKLY_COUNT)
          return { ok: true, skipped: true, week: wk, count: s.count, version: s.version };
      }
    } catch { /* 계속 */ }
  }

  const rss = await fetchMckinseyRss();
  const history = await loadInsightsHistory(env);
  const cards = await curateInsights(env, rss, history);
  if (!cards || cards.length !== INSIGHTS_WEEKLY_COUNT) return { ok: false, reason: "curate_failed_or_incomplete" };

  try {
    await env.RESEARCH.put(INSIGHTS_KEY, JSON.stringify(cards), {
      httpMetadata: { contentType: "application/json" },
    });
    await env.RESEARCH.put(INSIGHTS_STAMP_KEY, JSON.stringify({
      week: wk,
      at: Date.now(),
      count: cards.length,
      rss: rss.length,
      version: INSIGHTS_SCHEMA_VERSION,
      dailyCount: INSIGHTS_DAILY_COUNT,
    }), { httpMetadata: { contentType: "application/json" } });

    const nextHistory = [...history, ...cards.map(c => ({
      day: c.day, title: c.title, url: c.url, source: c.source, date: c.date, week: wk,
    }))]
      .filter((h, i, a) => !h.url || a.findIndex(x => x.url === h.url) === i)
      .slice(-INSIGHTS_HISTORY_MAX);
    await saveInsightsHistory(env, nextHistory);
  } catch {
    return { ok: false, reason: "store_failed" };
  }

  return {
    ok: true,
    count: cards.length,
    dailyCount: INSIGHTS_DAILY_COUNT,
    week: wk,
    version: INSIGHTS_SCHEMA_VERSION,
    rssCandidates: rss.length,
  };
}
