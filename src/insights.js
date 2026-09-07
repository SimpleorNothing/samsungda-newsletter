// src/insights.js — 리서치 인사이트 자동수집 (B안: 주1회 15개 풀 + 요일별 3개 노출)
//
// 핵심 원칙
// - 월~금 각 3개, 총 15개를 R2에 저장한다.
// - AI 결과 중 검증에 실패한 카드가 있어도 전체 큐레이션을 폐기하지 않는다.
// - 부족분은 직전의 정상 B안 피드 → 수동 검증 bootstrap 순으로 보완한다.
// - 구형 6장 피드는 B안 보완재로 사용하지 않는다.

import { INSIGHTS_BOOTSTRAP } from "./insights-bootstrap.js";

const INSIGHTS_KEY = "signals/insights-feed.json";
const INSIGHTS_STAMP_KEY = "signals/insights-feed.stamp.json";
const INSIGHTS_HISTORY_KEY = "signals/insights-feed.history.json";
const INSIGHTS_SCHEMA_VERSION = 4;
const INSIGHTS_DAYS = ["mon", "tue", "wed", "thu", "fri"];
const INSIGHTS_DAILY_COUNT = 3;
const INSIGHTS_WEEKLY_COUNT = INSIGHTS_DAYS.length * INSIGHTS_DAILY_COUNT;
const INSIGHTS_HISTORY_MAX = 150;
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

export function validateInstitutionDetailUrl(url) {
  let u;
  try { u = new URL(url); } catch { return false; }
  if (u.protocol !== "https:") return false;
  const host = u.hostname.toLowerCase();
  const path = u.pathname;
  const p = u.searchParams;

  if (hostIs(host, "bok.or.kr"))
    return /\/view\.do$/i.test(path) && !!p.get("nttId");
  if (hostIs(host, "kostat.go.kr") || hostIs(host, "mods.go.kr"))
    return /\/board\.es$/i.test(path) && String(p.get("act") || "").toLowerCase() === "view" && !!p.get("list_no");
  if (hostIs(host, "kiep.go.kr"))
    return /\/gallery\.es$/i.test(path) && String(p.get("act") || "").toLowerCase() === "view" && !!p.get("list_no");
  if (hostIs(host, "kiet.re.kr")) {
    const idKey = [...p.keys()].find(k => /^(?:idx|list_no|seq|no|[a-z][a-z0-9_]*_no)$/i.test(k) && p.get(k));
    return /View$/i.test(path) && !!idKey;
  }
  return true;
}

function isInstitutionUrl(url) {
  try {
    const h = new URL(url).hostname.toLowerCase();
    return ["bok.or.kr", "kostat.go.kr", "mods.go.kr", "kiep.go.kr", "kiet.re.kr"].some(d => hostIs(h, d));
  } catch { return false; }
}

async function verifyUrl(url, dateHint = "") {
  if (!url || !validateInstitutionDetailUrl(url)) return false;
  try {
    const res = await fetch(url, { headers: UA.headers, redirect: "follow" });
    if (!res.ok) return false;
    if (isInstitutionUrl(url)) {
      const ym = typeof dateHint === "string" ? dateHint.match(/(20\d{2})/) : null;
      if (ym) {
        const text = await res.text();
        if (!text.includes(ym[1])) return false;
      }
    }
    return true;
  } catch { return false; }
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

async function loadStoredFeed(env) {
  try {
    const o = await env.RESEARCH.get(INSIGHTS_KEY);
    if (!o) return [];
    const arr = await o.json();
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}

function normTitle(s) {
  return (s || "").toLowerCase().replace(/[\s.,'"()·\-–—:;/?!]/g, "");
}

function dedupeCards(cards) {
  const urls = new Set(), titles = new Set(), out = [];
  for (const c of cards || []) {
    const u = c && c.url;
    const t = normTitle(c && c.title);
    if (!c || !INSIGHTS_DAYS.includes(c.day) || !u || !t || urls.has(u) || titles.has(t)) continue;
    urls.add(u); titles.add(t); out.push(c);
  }
  return out;
}

function dedupeAgainstHistory(cards, history) {
  const histUrls = new Set((history || []).map(h => h.url).filter(Boolean));
  const histTitles = new Set((history || []).map(h => normTitle(h.title)).filter(Boolean));
  return (cards || []).filter(c => !(c.url && histUrls.has(c.url)) && !histTitles.has(normTitle(c.title)));
}

// 새 큐레이션이 일부만 살아남아도 요일별로 부족분만 이전 정상 B안/초기 안전망에서 채운다.
export function composeWeeklyInsights(primary, fallbackFeeds = [], now = new Date()) {
  const pools = [primary, ...(fallbackFeeds || [])]
    .map(cards => dedupeCards(filterRecentInsights(cards || [], 3, now)));
  const out = [], urls = new Set(), titles = new Set();

  for (const day of INSIGHTS_DAYS) {
    let count = 0;
    for (const pool of pools) {
      for (const c of pool) {
        if (c.day !== day || count >= INSIGHTS_DAILY_COUNT) continue;
        const t = normTitle(c.title);
        if (urls.has(c.url) || titles.has(t)) continue;
        out.push(c); urls.add(c.url); titles.add(t); count++;
      }
      if (count >= INSIGHTS_DAILY_COUNT) break;
    }
    if (count !== INSIGHTS_DAILY_COUNT) return null;
  }
  return out.length === INSIGHTS_WEEKLY_COUNT ? out : null;
}

export function isCompleteBPlanFeed(cards, now = new Date()) {
  const composed = composeWeeklyInsights(cards, [], now);
  return Array.isArray(composed) && composed.length === INSIGHTS_WEEKLY_COUNT;
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
        "이번 주 카드 15개를 만든다. day는 mon/tue/wed/thu/fri 각각 정확히 3개. 같은 URL·같은 리포트 중복 금지.",
        "- mon 국내 거시·산업경기: 한국은행(BOK), 산업연구원(KIET), 국가데이터처(구 통계청) 우선.",
        "- tue 글로벌 경쟁전략: McKinsey, BCG, PwC, Accenture, Kearney, Roland Berger. Oliver Wyman 제외.",
        "- wed 소비자·유통: Deloitte, Bain, NielsenIQ, GfK, Circana/NPD, Statista Insights.",
        "- thu 신사업+글로벌 거시: AI홈·구독·로보틱스·스마트홈, KIEP, OECD, IMF.",
        "- fri 주간 종합+균형 관점: 독립 리포트 3개, 최소 1개 source='균형 관점'.",
        "최근 2개월 우선, 최대 당월 포함 최근 3개월. date는 YYYY.MM 또는 YYYY.MM.DD.",
        "DA 우선순위: 생활가전·스마트홈·AI가전·HVAC·빌트인·구독·내구재수요·프리미엄·D2C·미국주택·관세·공급망·원자재·경쟁사.",
        "확인되지 않은 수치를 만들지 않는다. 수치가 없으면 stat/cap은 빈 문자열.",
        "URL은 실제 개별 원문/상세 글만 사용. 목록·검색·메인·허브 금지. 상세 URL을 못 찾으면 다른 리포트로 교체.",
        "BOK는 /view.do + nttId. 국가데이터처/통계청은 board.es + act=view + list_no. KIEP는 gallery.es + act=view + list_no. KIET는 *View + 문서 식별자만 허용.",
        "최근 발행 이력의 동일 URL·동일/사실상 동일 리포트는 재선택하지 않는다. 정기지표는 더 최근 발표치만 허용.",
        "JSON 배열만 반환. 코드펜스·설명 금지.",
        '[{"day":"mon","source":"한국은행","domain":"bok.or.kr","date":"2026.08.25","title":"리포트 요지","stat":"","cap":"","impl":"삼성전자 DA 관점 시사점","url":"https://...","image":""}]',
        "title 60자 내외, cap 90자 이내, impl 120자 이내. image는 og:image를 확실히 알 때만 https URL.",
      ].join("\n"),
      messages: [{
        role: "user",
        content: `McKinsey RSS 최근 후보:\n${cand || "(없음 — web_search로 직접 탐색)"}\n\n최근 발행 이력:\n${hist || "(없음)"}\n\n월~금 각 3개, 총 15개를 JSON 배열만 반환.`,
      }],
    }),
  });
  if (!res.ok) return { cards: [], generated: 0, unique: 0, verified: 0, reason: `anthropic_${res.status}` };

  const j = await res.json();
  const t = (j.content || []).filter(b => b.type === "text").map(b => b.text).join("").trim();
  const mm = t.replace(/```json|```/g, "").match(/\[[\s\S]*\]/);
  if (!mm) return { cards: [], generated: 0, unique: 0, verified: 0, reason: "json_not_found" };

  let arr;
  try { arr = JSON.parse(mm[0]); } catch { return { cards: [], generated: 0, unique: 0, verified: 0, reason: "json_parse" }; }
  if (!Array.isArray(arr)) return { cards: [], generated: 0, unique: 0, verified: 0, reason: "json_not_array" };

  const clamp = (v, n) => typeof v === "string" ? v.trim().slice(0, n) : "";
  const https = u => (typeof u === "string" && /^https:\/\//i.test(u)) ? u.trim() : "";
  const mapped = arr.map(c => ({
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

  const unique = dedupeCards(dedupeAgainstHistory(mapped, history));
  const checked = await Promise.all(unique.map(async c => (await verifyUrl(c.url, c.date)) ? c : null));
  const verified = checked.filter(Boolean);
  const fresh = filterRecentInsights(verified);
  return { cards: fresh, generated: mapped.length, unique: unique.length, verified: verified.length, reason: "" };
}

export async function refreshInsights(env, opts = {}) {
  if (!env || !env.RESEARCH) return { ok: false, reason: "no_r2" };

  const wk = isoWeek(new Date());
  const current = await loadStoredFeed(env);
  if (!opts.force) {
    try {
      const o = await env.RESEARCH.get(INSIGHTS_STAMP_KEY);
      if (o) {
        const s = await o.json();
        if (s && s.week === wk && s.version === INSIGHTS_SCHEMA_VERSION && s.count === INSIGHTS_WEEKLY_COUNT && isCompleteBPlanFeed(current))
          return { ok: true, skipped: true, week: wk, count: s.count, version: s.version };
      }
    } catch { /* 계속 */ }
  }

  const history = await loadInsightsHistory(env);
  const rss = env.ANTHROPIC_API_KEY ? await fetchMckinseyRss() : [];
  const curated = env.ANTHROPIC_API_KEY
    ? await curateInsights(env, rss, history)
    : { cards: [], generated: 0, unique: 0, verified: 0, reason: "no_api_key" };

  const cards = composeWeeklyInsights(curated.cards, [current, INSIGHTS_BOOTSTRAP]);
  if (!cards) {
    return {
      ok: false,
      reason: "curate_failed_and_no_bplan_fallback",
      generated: curated.generated,
      unique: curated.unique,
      verified: curated.verified,
      curateReason: curated.reason,
    };
  }

  const curatedUrls = new Set((curated.cards || []).map(c => c.url));
  const fallbackCount = cards.filter(c => !curatedUrls.has(c.url)).length;

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
      generated: curated.generated,
      unique: curated.unique,
      verified: curated.verified,
      fallbackCount,
      curateReason: curated.reason || "",
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
    curatedCount: curated.cards.length,
    verified: curated.verified,
    fallbackCount,
    degraded: fallbackCount > 0,
    curateReason: curated.reason || "",
  };
}
