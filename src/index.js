// samsungda-newsletter — 기획 데일리 (Cloudflare Worker + Cron)
//
// 콘텐츠: [원가] 환율(원·페소·바트·동·루피·즈워티 — 생산거점 통화, 원가 관점 전용)·유가(전일)·원자재(전월)·운임 FBX(일간, R2 갱신)
//         [소비] 금리 美10Y(전일)·수요 홈빌더ITB/소비재XLY(전일)·주간 실업수당청구/30Y모기지(전주)·물가 美CPI/PCE·韓CPI(YoY)·주택 착공/기존판매(MoM)·소비심리 UMich(MoM)
//         [도구모음] MI뉴스·아이디어뱅크·보고서
// 편성: 월~금 데일리. cron 45 22 * * 1-5 (07:45 KST).
// 데이터: Yahoo(range=3mo → 전일·1개월전)·FRED CSV(무키 월간지표)·R2 samsungda-research.
// 히어로: Claude API(claude-sonnet-4-5) 맥락 브리핑 — '오늘의 맥락'(지표·뉴스를 연결한 2~3문장)
//         + 소비/원가 섹션별 해석 한 줄 + 뉴스별 내용·기회·위협 각 한 줄. 모든 해석에 근거 지표 병기. 키 없으면 규칙 폴백. CTA 없음.
// 구독: R2 "subscribers/<sha256(email)>.json". 발송: Resend(수신자별 개별).
// 라우트: POST /subscribe · GET /unsubscribe · GET /subscribers?key= · /preview · /send?key= · /latest

const MI_NEWS = "https://mi.samsungda.net/data/news.json";
const BANK_PREFIX = "idea-bank/";
const NL_PREFIX = "newsletter/";
const SUB_PREFIX = "subscribers/";
const FBX_KEY = "signals/fbx.json";  // FBX(Freightos Baltic Index) 일간 운임지수 — R2 수동/외부 갱신
const UA = { headers: { "User-Agent": "Mozilla/5.0" } };
const GRADE_W = { "긴급": 3, "주요": 2, "주시": 1, "참고": 0 };
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DAY = 864e5;
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

// FRED 시리즈
const FRED = {
  cpiUS: "CPIAUCSL", pce: "PCEPI", cpiKR: "KORCPIALLMINMEI",
  houst: "HOUST", exhome: "EXHOSLUSM495S", umich: "UMCSENT", ironore: "PIORECRUSDM",
};
// FRED 주간 시리즈 (전주 대비 델타로 매일-근접 신선분 확보)
const FRED_WEEKLY = {
  icsa: "ICSA",            // 신규 실업수당청구 (목 릴리스) — 소비여력 선행
  mortgage30: "MORTGAGE30US", // 30Y 고정 모기지 금리 (목 릴리스) — 주택 매수여력
};

// CI 팔레트 (competitor_intelligence 상속)
const T = {
  bg: "#EDEFEC", surface: "#FFFFFF", text: "#17222D",
  muted: "#5C6B79", border: "#D3D9D6", brand: "#46647E",
  up: "#B02E24", down: "#46647E",
};

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(run(env, { send: true }));
  },
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });

    if (url.pathname === "/subscribe" && request.method === "POST") return handleSubscribe(request, env);
    if (url.pathname === "/unsubscribe") return handleUnsub(url, env);

    if (url.pathname === "/preview") return htmlResp(await buildEmail(env));
    if (url.pathname === "/send") {
      if (env.TRIGGER_KEY && url.searchParams.get("key") !== env.TRIGGER_KEY)
        return new Response("forbidden", { status: 403 });
      return json(await run(env, { send: true }));
    }
    if (url.pathname === "/subscribers") {
      if (!env.TRIGGER_KEY || url.searchParams.get("key") !== env.TRIGGER_KEY)
        return new Response("forbidden", { status: 403 });
      const subs = await getSubscribers(env);
      const pub = (env.PUBLIC_URL || "").replace(/\/$/, "");
      const out = [];
      for (const email of subs) {
        const t = await signToken(email, signKey(env));
        out.push({ email, unsubscribe: pub ? `${pub}/unsubscribe?e=${encodeURIComponent(email)}&t=${t}` : null });
      }
      return json({ count: out.length, subscribers: out });
    }
    if (url.pathname === "/" || url.pathname === "/latest") {
      const obj = await env.RESEARCH.get(NL_PREFIX + "latest.html");
      if (obj) return htmlResp(await obj.text());
      return new Response("아직 발행된 뉴스레터가 없습니다.", { status: 404 });
    }
    return new Response("not found", { status: 404 });
  },
};

function htmlResp(html) {
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
}
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", ...CORS } });
}

// ---------- 구독 관리 ----------
const enc = new TextEncoder();
function hex(buf) { return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join(""); }
async function sha256hex(s) { return hex(await crypto.subtle.digest("SHA-256", enc.encode(s))); }
function signKey(env) { return env.UNSUB_SECRET || env.RESEND_API_KEY || "samsungda-newsletter"; }
async function signToken(email, key) {
  const k = await crypto.subtle.importKey("raw", enc.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", k, enc.encode(email.toLowerCase())));
}
async function subKey(email) { return SUB_PREFIX + (await sha256hex(email.toLowerCase())) + ".json"; }

async function handleSubscribe(request, env) {
  let body = {};
  try { body = await request.json(); } catch { /* ignore */ }
  const email = String(body.email || "").trim().toLowerCase();
  if (!EMAIL_RE.test(email)) return json({ ok: false, error: "invalid_email" }, 400);
  const allow = (env.ALLOWED_DOMAINS || "").split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
  if (allow.length && !allow.includes(email.split("@")[1]))
    return json({ ok: false, error: "domain_not_allowed" }, 403);
  try {
    await env.RESEARCH.put(await subKey(email), JSON.stringify({ email, createdAt: Date.now() }),
      { httpMetadata: { contentType: "application/json" } });
  } catch (e) { return json({ ok: false, error: "store_failed" }, 500); }
  return json({ ok: true, email });
}
async function handleUnsub(url, env) {
  const email = String(url.searchParams.get("e") || "").trim().toLowerCase();
  const token = url.searchParams.get("t") || "";
  const good = !!email && !!token && token === (await signToken(email, signKey(env)));
  if (good) { try { await env.RESEARCH.delete(await subKey(email)); } catch { /* ignore */ } }
  return htmlResp(unsubPage(good, email));
}
async function getSubscribers(env) {
  const out = [];
  if (!env.RESEARCH) return out;
  try {
    let cursor;
    do {
      const listed = await env.RESEARCH.list({ prefix: SUB_PREFIX, cursor });
      for (const o of (listed.objects || [])) {
        const obj = await env.RESEARCH.get(o.key);
        if (!obj) continue;
        try { const r = await obj.json(); if (r && r.email) out.push(r.email.toLowerCase()); } catch { /* skip */ }
      }
      cursor = listed.truncated ? listed.cursor : null;
    } while (cursor);
  } catch { /* ignore */ }
  return out;
}
async function allRecipients(env) {
  const stat = (env.RECIPIENTS || "").split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
  const subs = await getSubscribers(env);
  return [...new Set([...stat, ...subs])];
}

// ---------- 발송 ----------
async function run(env, { send }) {
  const data = await gatherData(env);
  const base = renderEmail(data);
  const pub = (env.PUBLIC_URL || "").replace(/\/$/, "");
  try {
    const arc = base.split("__UNSUB__").join(pub ? pub + "/latest" : "#");
    const meta = { httpMetadata: { contentType: "text/html; charset=utf-8" } };
    await env.RESEARCH.put(`${NL_PREFIX}${data.date}.html`, arc, meta);
    await env.RESEARCH.put(`${NL_PREFIX}latest.html`, arc, meta);
  } catch { /* 아카이브 실패 무시 */ }

  if (!send) return { ok: true, sent: false };
  if (!env.RESEND_API_KEY) return { ok: false, error: "RESEND_API_KEY 미설정" };
  const to = await allRecipients(env);
  if (!to.length) return { ok: false, error: "수신자 없음" };

  const subject = `📊 기획 데일리 · ${data.date}`;
  let sent = 0, failed = 0; const errs = [];
  for (const email of to) {
    const token = await signToken(email, signKey(env));
    const link = pub ? `${pub}/unsubscribe?e=${encodeURIComponent(email)}&t=${token}` : "#";
    const html = base.split("__UNSUB__").join(link);
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Authorization": `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: env.FROM || "기획 도구모음 <newsletter@samsungda.net>", to: [email], subject, html }),
    });
    if (res.ok) sent++;
    else { failed++; const j = await res.json().catch(() => ({})); errs.push(j.message || res.status); }
  }
  return { ok: failed === 0, sent, failed, errors: errs.slice(0, 3) };
}

// ---------- 데이터 수집 ----------
async function gatherData(env) {
  const symbols = ["KRW=X", "MXN=X", "THB=X", "VND=X", "INR=X", "PLN=X", "CL=F", "HG=F", "^TNX", "ITB", "XLY"];
  const [yq, macro, freight, news, ideas, reports] = await Promise.all([
    Promise.all(symbols.map(yahoo)),
    getMacro(),
    getFreight(env),
    getNews(),
    getIdeas(env),
    getReports(env),
  ]);
  const q = {}; symbols.forEach((s, i) => q[s] = yq[i]);
  const data = { date: kstDate(), q, macro, freight, news, ideas, reports };
  data.summary = await aiSummary(env, data);
  return data;
}
async function buildEmail(env) {
  return renderEmail(await gatherData(env), { sample: true }).split("__UNSUB__").join("#");
}

// Yahoo 차트: 최근 3개월 일봉 → 최신·전일·1개월전(≈21거래일)
async function yahoo(sym) {
  try {
    const u = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=1d&range=3mo`;
    const r = (await (await fetch(u, UA)).json()).chart.result[0];
    const closes = (r.indicators.quote[0].close || []).filter(x => x != null);
    if (!closes.length) return null;
    return {
      price: closes[closes.length - 1],
      prevDay: closes.length >= 2 ? closes[closes.length - 2] : null,
      prevMonth: closes[Math.max(0, closes.length - 22)],
    };
  } catch { return null; }
}

// FRED 무키 CSV → 월별 [{d,v}] 오름차순
async function fred(id, months = 15) {
  try {
    const cosd = new Date(Date.now() - months * 31 * DAY).toISOString().slice(0, 10);
    const txt = await (await fetch(`https://fred.stlouisfed.org/graph/fredgraph.csv?id=${id}&cosd=${cosd}`, UA)).text();
    return txt.trim().split("\n").slice(1)
      .map(l => { const [d, v] = l.split(","); return { d, v: parseFloat(v) }; })
      .filter(r => r.d && !isNaN(r.v));
  } catch { return []; }
}
function fredStat(rows) {
  if (!rows.length) return null;
  const n = rows.length, last = rows[n - 1];
  return {
    val: last.v, date: last.d,
    mom: n >= 2 ? (last.v / rows[n - 2].v - 1) * 100 : null,
    yoy: n >= 13 ? (last.v / rows[n - 13].v - 1) * 100 : null,
  };
}
async function getMacro() {
  const mIds = Object.values(FRED), wIds = Object.values(FRED_WEEKLY);
  const [mRows, wRows] = await Promise.all([
    Promise.all(mIds.map(id => fred(id))),
    Promise.all(wIds.map(id => fred(id, 3))),  // 주간: 최근 3개월이면 전주 델타 확보
  ]);
  const s = {}; Object.keys(FRED).forEach((k, i) => s[k] = fredStat(mRows[i]));
  Object.keys(FRED_WEEKLY).forEach((k, i) => s[k] = fredStat(wRows[i]));  // mom = 전주比
  return s;
}
async function getFreight(env) {
  if (!env.RESEARCH) return null;
  try { const o = await env.RESEARCH.get(FBX_KEY); if (o) return await o.json(); } catch { /* ignore */ }
  return null;
}
async function getNews() {
  try {
    const j = await (await fetch(MI_NEWS, UA)).json();
    const items = j.items || [];
    const cut = Date.now() - DAY;
    const recent = items.filter(i => new Date(i.publishedAt).getTime() >= cut);
    const pool = recent.length ? recent : items;
    return pool.sort((a, b) => (GRADE_W[b.grade] - GRADE_W[a.grade]) || (b.impact - a.impact)).slice(0, 5);
  } catch { return []; }
}
async function getIdeas(env) {
  const items = [];
  if (!env.RESEARCH) return items;
  try {
    let cursor;
    do {
      const listed = await env.RESEARCH.list({ prefix: BANK_PREFIX, cursor });
      for (const o of (listed.objects || [])) {
        const obj = await env.RESEARCH.get(o.key);
        if (!obj) continue;
        try { const rec = await obj.json(); if (rec && rec.id) items.push(rec); } catch { /* skip */ }
      }
      cursor = listed.truncated ? listed.cursor : null;
    } while (cursor);
  } catch { return []; }
  items.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  return items.slice(0, 5);
}
async function getReports(env) {
  if (!env.RESEARCH) return [];
  try {
    const listed = await env.RESEARCH.list({ include: ["customMetadata", "httpMetadata"] });
    return (listed.objects || [])
      .filter(o => !o.key.startsWith(BANK_PREFIX) && !o.key.startsWith(NL_PREFIX) && !o.key.startsWith(SUB_PREFIX) && !o.key.startsWith("signals/"))
      .map(o => ({ title: o.customMetadata?.title ? safeDecode(o.customMetadata.title) : o.key, uploaded: o.uploaded }))
      .sort((a, b) => new Date(b.uploaded) - new Date(a.uploaded))
      .slice(0, 5);
  } catch { return []; }
}
function safeDecode(s) { try { return decodeURIComponent(s); } catch { return s; } }

// ---------- AI 맥락 브리핑 ----------
const pctOf = (c, b) => (c == null || b == null || !b) ? null : (c - b) / b * 100;
function sPct(v) { return v == null ? "—" : `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`; }
function summaryContext(data) {
  const q = data.q, m = data.macro, s = data.freight, L = [];
  if (q["KRW=X"]) L.push(`원/달러 ${q["KRW=X"].price.toFixed(1)} (전일 ${sPct(pctOf(q["KRW=X"].price, q["KRW=X"].prevDay))})`);
  if (q["MXN=X"]) L.push(`페소 ${q["MXN=X"].price.toFixed(2)} (전일 ${sPct(pctOf(q["MXN=X"].price, q["MXN=X"].prevDay))})`);
  if (q["THB=X"]) L.push(`바트 ${q["THB=X"].price.toFixed(2)} (전일 ${sPct(pctOf(q["THB=X"].price, q["THB=X"].prevDay))})`);
  if (q["VND=X"]) L.push(`동 ${q["VND=X"].price.toFixed(0)} (전일 ${sPct(pctOf(q["VND=X"].price, q["VND=X"].prevDay))})`);
  if (q["INR=X"]) L.push(`루피 ${q["INR=X"].price.toFixed(2)} (전일 ${sPct(pctOf(q["INR=X"].price, q["INR=X"].prevDay))})`);
  if (q["PLN=X"]) L.push(`즈워티 ${q["PLN=X"].price.toFixed(2)} (전일 ${sPct(pctOf(q["PLN=X"].price, q["PLN=X"].prevDay))})`);
  if (q["CL=F"]) L.push(`WTI ${q["CL=F"].price.toFixed(1)} (전일 ${sPct(pctOf(q["CL=F"].price, q["CL=F"].prevDay))})`);
  if (q["HG=F"]) L.push(`구리 ${q["HG=F"].price.toFixed(2)} (전월 ${sPct(pctOf(q["HG=F"].price, q["HG=F"].prevMonth))})`);
  if (m.ironore) L.push(`철광석 전월 ${sPct(m.ironore.mom)}`);
  if (s && s.value != null) L.push(`FBX(운임) ${s.value}${s.mom != null ? ` (전일 ${sPct(s.mom)})` : ""}`);
  if (q["^TNX"]) L.push(`美10Y ${q["^TNX"].price.toFixed(2)}% (전일 ${sPct(pctOf(q["^TNX"].price, q["^TNX"].prevDay))})`);
  if (q["ITB"]) L.push(`홈빌더ETF(ITB) ${q["ITB"].price.toFixed(2)} (전일 ${sPct(pctOf(q["ITB"].price, q["ITB"].prevDay))})`);
  if (q["XLY"]) L.push(`소비재ETF(XLY) ${q["XLY"].price.toFixed(2)} (전일 ${sPct(pctOf(q["XLY"].price, q["XLY"].prevDay))})`);
  if (m.icsa) L.push(`美신규실업수당청구 ${Math.round(m.icsa.val / 1000)}K (전주 ${sPct(m.icsa.mom)})`);
  if (m.mortgage30) L.push(`美30Y모기지 ${m.mortgage30.val.toFixed(2)}% (전주 ${sPct(m.mortgage30.mom)})`);
  if (m.cpiUS) L.push(`美CPI 전년 ${sPct(m.cpiUS.yoy)}`);
  if (m.cpiKR) L.push(`韓CPI 전년 ${sPct(m.cpiKR.yoy)}`);
  if (m.umich) L.push(`美소비심리 ${m.umich.val.toFixed(1)}`);
  const heads = (data.news || []).map((n, i) => {
    const meta = [n.grade, n.lens, (n.products || []).join("/"), (n.competitors || []).join("/")].filter(Boolean).join("·");
    return `${i}. 「${n.headline}」 (${meta})\n   요약: ${n.summary || "-"}`;
  }).join("\n");
  return `[오늘 지표]\n- ${L.join("\n- ")}\n\n[가전 주요뉴스]\n${heads || "없음"}`;
}
function ruleSummary(data) {
  const q = data.q, seg = [];
  const add = (nm, v) => { if (v != null) seg.push(`${nm} ${v >= 0 ? "▲" : "▼"}${Math.abs(v).toFixed(1)}%`); };
  if (q["KRW=X"]) add("원/달러", pctOf(q["KRW=X"].price, q["KRW=X"].prevDay));
  if (q["CL=F"]) add("WTI", pctOf(q["CL=F"].price, q["CL=F"].prevDay));
  if (q["HG=F"]) add("구리", pctOf(q["HG=F"].price, q["HG=F"].prevMonth));
  if (q["ITB"]) add("홈빌더ETF", pctOf(q["ITB"].price, q["ITB"].prevDay));
  const macro = seg.length ? `${seg.slice(0, 3).join(" · ")} — 원가·소비 지표 점검` : "원가·소비 지표 데이터 수집 지연";
  const nc = (data.news || []).length, top = (data.news || [])[0];
  const news = nc ? `가전뉴스 ${nc}건${top ? ` — 「${top.headline}」` : ""}` : "최근 24시간 신규 가전뉴스 없음";
  return { hero: `${macro}. ${news}`, sec: { consume: "", cost: "" }, newsWhy: {} };
}
async function aiSummary(env, data) {
  if (env && env.ANTHROPIC_API_KEY) {
    try {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "claude-sonnet-4-5",
          max_tokens: 1400,
          system: [
            "삼성전자 생활가전(DA) 기획자를 위한 데일리 브리핑을 쓴다.",
            "수치 나열이 아니라 '왜 움직였고 DA 기획에 무엇을 뜻하는지' 맥락을 담는다.",
            "아래 JSON 스키마 한 덩어리로만 답한다 (코드펜스·설명·인사말 금지):",
            '{"hero":"...","consume":"...","cost":"...","news":[{"idx":0,"content":"...","opportunity":"...","threat":"..."}]}',
            "- hero: 오늘 지표·뉴스를 관통하는 맥락 브리핑 2~3문장(전체 200자 이내). 인과 고리를 수치와 함께 문장 안에 드러낸다(예: '원/달러 +0.4%로 수입 부품 원가 압력이 커진 가운데…').",
            "- consume: 소비 환경(금리·수요ETF·주간지표·물가·주택·심리)이 가전 수요에 갖는 의미 한 문장(명사형 마무리) + 괄호로 근거 지표 병기. 전체 75자 이내. 예: '고금리 고착으로 교체 수요 관망 (10Y 4.37%·기존판매 ▼2.1%)'.",
            "  · 물가·주택·심리가 월간이라 당일 신선한 델타가 없으면, 일간 프록시(10Y 전일·홈빌더ETF ITB 전일·소비재ETF XLY 전일)나 주간 지표(신규 실업수당청구·30Y 모기지 전주)를 근거로 소비 방향을 서술한다. 매일 최소 하나의 신선 신호를 담는다.",
            "  · 프록시 해석: 홈빌더ETF(ITB) 상승/모기지 하락 = 주택·빌트인 수요 개선 신호 / 실업수당청구 증가 = 소비여력 둔화 신호. 프록시는 시장 기대의 대리지표이므로 '~신호'·'~여건' 수준으로 서술하고 확정적 수요 단정은 피한다.",
            "- cost: 원가 환경(환율·유가·원자재·운임 FBX)이 손익에 갖는 의미 한 문장(명사형 마무리) + 괄호로 근거 지표 병기. 전체 75자 이내. FBX(운임)는 컨테이너 수출 물류비 방향 신호로 해석.",
            "- news: 제공된 뉴스 각각에 대해 세 필드를 작성(idx는 뉴스 번호). 뉴스가 없으면 빈 배열.",
            "  · content: 기사 내용 — 이 소식이 무엇인지 시장·정책·경쟁 구도 차원의 핵심 한 문장(60자 이내). 항상 채운다.",
            "  · opportunity: 당사(DA) 기회 — 이 소식이 열어주는 기회 요인(수요·원가·제품 포트폴리오·역외 거점 관점) 한 문장(60자 이내). 기회 요인이 불분명하면 빈 문자열.",
            "  · threat: 당사(DA) 위협 — 이 소식이 가하는 위협 요인(경쟁 심화·원가 상승·규제·수요 둔화 관점) 한 문장(60자 이내). 위협 요인이 불분명하면 빈 문자열.",
            "  · 세 필드 모두 사실·방향 서술만 담는다. '검토 필요'·'대응해야'·'추진 여지' 等 실행 제안·액션 권고 금지 (실행 판단은 사람의 몫).",
            "  · 헤드라인·요약에 없는 사실·수치 창작 금지. content는 항상, opportunity·threat는 근거가 있을 때만 채운다.",
            "- 환율 해석 원칙 (원가 관점 전용 — 매출·수출 채산성 언급 금지):",
            "  · 모든 환율은 USD 대비 표기이며 수치 하락 = 해당 통화 강세.",
            "  · 원/달러 하락(원화 강세) = 달러 결제 원자재·부품의 원화 환산 구매원가 하락 요인.",
            "  · 생산거점 통화(페소=멕시코, 바트=태국, 동=베트남, 루피=인도, 즈워티=폴란드) 강세 = 현지 인건비·조달비의 달러 환산 상승 → 원가 '상승' 요인. 이 방향을 절대 뒤집지 말 것.",
            "  · 원화 강세와 생산거점 통화 강세는 원가에 반대 방향으로 작용 — 함께 움직일 때 '전방위 원가 하락'으로 뭉뚱그리지 말고 구분해 서술.",
            "- 추론 규율: 제공된 데이터만 근거로 하고 추측·과장 금지. 데이터가 부족한 항목은 빈 문자열.",
            "  · 지표에 직접 없는 수요·판매·점유율은 단정하지 말 것. 거시지표에서 유추한 판단은 근거 지표를 반드시 괄호 병기.",
            "  · '지속'·'추세'·'회복' 같은 시계열 표현은 제공된 전일/전월/전년 델타로 뒷받침될 때만 사용. 스냅샷 하나로 추세를 단정하지 않는다.",
          ].join("\n"),
          messages: [{ role: "user", content: summaryContext(data) }],
        }),
      });
      if (res.ok) {
        const j = await res.json();
        const t = (j.content || []).filter(b => b.type === "text").map(b => b.text).join("").trim();
        const raw = t.replace(/```json|```/g, "").trim();
        const parsed = JSON.parse(raw);
        const str = (v, n) => typeof v === "string" ? v.trim().slice(0, n) : "";
        const newsWhy = {};
        for (const it of (Array.isArray(parsed.news) ? parsed.news : [])) {
          if (!it || !Number.isInteger(it.idx)) continue;
          const content = typeof it.content === "string" ? it.content.trim().slice(0, 110) : "";
          const opportunity = typeof it.opportunity === "string" ? it.opportunity.trim().slice(0, 110) : "";
          const threat = typeof it.threat === "string" ? it.threat.trim().slice(0, 110) : "";
          const legacy = typeof it.why === "string" ? it.why.trim().slice(0, 110) : "";
          if (content || opportunity || threat || legacy) newsWhy[it.idx] = { content: content || legacy, opportunity, threat };
        }
        const hero = str(parsed.hero, 280);
        if (hero) return {
          hero,
          sec: { consume: str(parsed.consume, 120), cost: str(parsed.cost, 120) },
          newsWhy,
        };
      }
    } catch { /* 폴백 */ }
  }
  return ruleSummary(data);
}

// ---------- 렌더 ----------
export function renderEmail(data, opts = {}) {
  const esc = s => String(s == null ? "" : s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const arrow = d => d == null ? "" : ` <span style="color:${d >= 0 ? T.up : T.down};font-weight:600">${d >= 0 ? "▲" : "▼"}${Math.abs(d).toFixed(2)}%</span>`;
  const chg = (cur, base) => (cur == null || base == null || !base) ? "" : arrow((cur - base) / base * 100);
  const mom = q => q ? chg(q.price, q.prevMonth) : "";   // 원가: 1개월전 대비(MoM)
  const dchg = q => q ? chg(q.price, q.prevDay) : "";     // 일간: 전일 대비
  const fmt = (n, d = 2) => n == null ? "—" : Number(n).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
  const line = html => `<div style="padding:4px 0;font-size:14px;color:${T.text};line-height:1.55">• ${html}</div>`;
  const lbl = t => `<span style="color:${T.muted}">${t}</span>`;
  const dot = ' <span style="color:' + T.border + '">·</span> ';
  const q = data.q, m = data.macro, s = data.freight;
  const sm0 = (data.summary && typeof data.summary === "object") ? data.summary : { hero: String(data.summary || "") };
  const sm = { hero: sm0.hero || [sm0.macro, sm0.news].filter(Boolean).join(". "), sec: sm0.sec || {}, newsWhy: sm0.newsWhy || {} };
  const insight = t => t ? `<div style="margin-top:8px;padding:8px 12px;background:${T.bg};border-left:3px solid ${T.brand};font-size:13px;color:${T.muted};line-height:1.55">${esc(t)}</div>` : "";

  // 원가 (전부 MoM)
  const fxParts = [
    q["KRW=X"] ? `원/달러 <b>${fmt(q["KRW=X"].price, 1)}</b>${dchg(q["KRW=X"])}` : null,
    q["MXN=X"] ? `페소 <b>${fmt(q["MXN=X"].price)}</b>${dchg(q["MXN=X"])}` : null,
    q["THB=X"] ? `바트 <b>${fmt(q["THB=X"].price)}</b>${dchg(q["THB=X"])}` : null,
    q["VND=X"] ? `동 <b>${fmt(q["VND=X"].price, 0)}</b>${dchg(q["VND=X"])}` : null,
    q["INR=X"] ? `루피 <b>${fmt(q["INR=X"].price)}</b>${dchg(q["INR=X"])}` : null,
    q["PLN=X"] ? `즈워티 <b>${fmt(q["PLN=X"].price)}</b>${dchg(q["PLN=X"])}` : null,
  ].filter(Boolean).join(dot);
  const matParts = [
    q["HG=F"] ? `구리 <b>$${fmt(q["HG=F"].price)}/lb</b>${mom(q["HG=F"])}` : null,
    m.ironore ? `철광석 <b>$${fmt(m.ironore.val, 1)}/t</b>${arrow(m.ironore.mom)} <span style="color:${T.muted};font-size:12px">(${m.ironore.date})</span>` : null,
  ].filter(Boolean).join(dot);
  const fbxVal = s && s.value != null
    ? `<b>${fmt(s.value, 0)}</b>${s.mom != null ? arrow(s.mom) : ""} <span style="color:${T.muted};font-size:12px">(${s.asof ? esc(s.asof) : "수동 갱신"})</span>`
    : `<b>—</b> <span style="color:${T.muted};font-size:12px">(수동 갱신)</span>`;
  const cost = [
    fxParts ? line(`${lbl("환율")} ${fxParts}`) : "",
    q["CL=F"] ? line(`${lbl("유가")} WTI <b>$${fmt(q["CL=F"].price)}</b>${dchg(q["CL=F"])}`) : "",
    matParts ? line(`${lbl("원자재")} ${matParts}`) : "",
    line(`${lbl("운임")} FBX ${fbxVal}`),
  ].join("");

  // 소비
  const bp = q["^TNX"] && q["^TNX"].prevDay != null ? Math.round((q["^TNX"].price - q["^TNX"].prevDay) * 100) : null;
  const yoyTxt = st => st && st.yoy != null ? `<b>${st.yoy >= 0 ? "+" : ""}${st.yoy.toFixed(1)}%</b> <span style="color:${T.muted};font-size:12px">(${st.date})</span>` : "<b>—</b>";
  // 주간 지표: fredStat.mom = 전주比. 릴리스일(목) 외에도 최신 발표치를 항상 표기.
  const wkTxt = (st, unit, dg = 0) => st && st.val != null
    ? `<b>${fmt(st.val, dg)}${unit}</b>${st.mom != null ? arrow(st.mom) : ""} <span style="color:${T.muted};font-size:12px">(${st.date})</span>`
    : "<b>—</b>";
  const demandParts = [
    q["ITB"] ? `홈빌더(ITB) <b>$${fmt(q["ITB"].price)}</b>${dchg(q["ITB"])}` : null,
    q["XLY"] ? `소비재(XLY) <b>$${fmt(q["XLY"].price)}</b>${dchg(q["XLY"])}` : null,
  ].filter(Boolean).join(dot);
  const consume = [
    q["^TNX"] ? line(`${lbl("금리")} 美 10Y <b>${fmt(q["^TNX"].price)}%</b>${bp != null ? ` <span style="color:${bp >= 0 ? T.up : T.down};font-weight:600">${bp >= 0 ? "▲" : "▼"}${Math.abs(bp)}bp</span>` : ""}`) : "",
    demandParts ? line(`${lbl("수요")} ${demandParts}`) : "",
    (m.icsa || m.mortgage30) ? line(`${lbl("주간")} ${[
      m.icsa ? `실업수당청구 ${m.icsa.val != null ? `<b>${fmt(m.icsa.val / 1000, 0)}K</b>${m.icsa.mom != null ? arrow(m.icsa.mom) : ""} <span style="color:${T.muted};font-size:12px">(${m.icsa.date})</span>` : "<b>—</b>"}` : null,
      m.mortgage30 ? `30Y 모기지 ${wkTxt(m.mortgage30, "%", 2)}` : null,
    ].filter(Boolean).join(dot)}`) : "",
    line(`${lbl("물가")} 美 CPI ${yoyTxt(m.cpiUS)}${dot}PCE ${yoyTxt(m.pce)}${dot}韓 CPI ${yoyTxt(m.cpiKR)}`),
    m.houst || m.exhome ? line(`${lbl("주택")} ${[
      m.houst ? `착공 <b>${fmt(m.houst.val, 0)}K</b>${arrow(m.houst.mom)}` : null,
      m.exhome ? `기존판매 <b>${fmt(m.exhome.val / 1e6, 2)}M</b>${arrow(m.exhome.mom)}` : null,
    ].filter(Boolean).join(dot)} <span style="color:${T.muted};font-size:12px">(${(m.houst || m.exhome).date})</span>`) : "",
    m.umich ? line(`${lbl("심리")} 美 소비심리(UMich) <b>${fmt(m.umich.val, 1)}</b>${arrow(m.umich.mom)} <span style="color:${T.muted};font-size:12px">(${m.umich.date})</span>`) : "",
  ].join("");

  // 콘텐츠
  const newsWhyRows = w => {
    if (!w) return "";
    const o = typeof w === "string" ? { content: w, opportunity: "", threat: "" } : w;
    const row = (label, text, color) => text ? `<div style="margin-top:4px;font-size:13px;color:${T.text};line-height:1.5"><span style="color:${color};font-weight:700">${label}</span> ${esc(text)}</div>` : "";
    return row("내용", o.content, T.text) + row("기회", o.opportunity, T.brand) + row("위협", o.threat, T.up);
  };
  const newsRows = data.news.length
    ? data.news.map((i, ni) => `<div style="padding:8px 0;border-bottom:1px solid ${T.border}">
        <a href="${esc(i.url)}" style="color:${T.text};text-decoration:none;font-size:14px;font-weight:600;line-height:1.4">${esc(i.headline)}</a>
        ${newsWhyRows(sm.newsWhy[ni])}
        <div style="margin-top:3px;font-size:12px;color:${T.muted}">${esc(i.grade)} · ${esc(i.lens)} · ${esc(i.source?.name || "")}</div></div>`).join("")
    : `<div style="font-size:13px;color:${T.muted}">최근 24시간 신규 없음</div>`;
  const ideaRows = data.ideas.length
    ? data.ideas.map(i => {
        const dir = i.dir === "profit" ? "수익" : "매출";
        const memo = i.memo ? `<div style="margin-top:3px;font-size:12px;color:${T.muted}">${esc(i.memo).slice(0, 90)}</div>` : "";
        return `<div style="padding:8px 0;border-bottom:1px solid ${T.border}">
          <span style="font-size:11px;color:${T.brand};font-weight:700">[${dir}${i.topic ? " · " + esc(i.topic) : ""}]</span>
          <span style="font-size:14px;font-weight:600;color:${T.text}">${esc(i.title)}</span>${memo}</div>`;
      }).join("")
    : `<div style="font-size:13px;color:${T.muted}">저장된 아이디어 없음</div>`;
  const reportRows = data.reports.length
    ? data.reports.map(r => `<div style="padding:6px 0;border-bottom:1px solid ${T.border};font-size:14px;color:${T.text}">📄 ${esc(r.title)}
        <span style="font-size:12px;color:${T.muted}"> · ${esc(kstDate(new Date(r.uploaded).getTime()))}</span></div>`).join("")
    : `<div style="font-size:13px;color:${T.muted}">최근 신규 보고서 없음</div>`;

  const section = (title, body, extra, first, ins) => `<tr><td style="padding:${first ? "16" : "20"}px 22px 0;${first ? "" : `border-top:1px solid ${T.border}`}">
      <div style="font-size:13px;font-weight:700;color:${T.brand};letter-spacing:.02em">${title}${extra ? ` <span style="color:${T.muted};font-weight:500">${extra}</span>` : ""}</div>${insight(ins)}
      <div style="margin-top:8px">${body}</div></td></tr>`;

  return `<!DOCTYPE html>
<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/static/pretendard.min.css"></head>
<body style="margin:0;padding:0;background:${T.bg};font-family:'Pretendard','Apple SD Gothic Neo','Malgun Gothic',system-ui,-apple-system,sans-serif">
${opts.sample ? `<div style="position:fixed;top:12px;left:12px;z-index:100;background:${T.text};color:${T.bg};font-size:11px;font-weight:700;letter-spacing:.14em;padding:4px 10px">SAMPLE</div>` : ""}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${T.bg};padding:24px 0">
<tr><td align="center">
  <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:${T.surface};border:1px solid ${T.border};border-top:3px solid ${T.text};overflow:hidden">
    <tr><td style="padding:24px 22px 16px;border-bottom:2px solid ${T.text};text-align:center">
      <div style="font-size:20px;font-weight:800;color:${T.text};letter-spacing:-.01em">기획 데일리</div>
      <div style="margin-top:4px;font-size:12px;color:${T.muted};letter-spacing:.04em">${esc(data.date)} · SAMSUNG DA 기획 도구모음</div>
      <div style="margin-top:10px;font-size:11px;color:${T.muted};letter-spacing:.05em">소비 · 원가 · 뉴스 · 아이디어 · 보고서</div>
    </td></tr>
    <tr><td style="padding:18px 22px 2px">
      <div style="background:${T.bg};border:1px solid ${T.border};border-left:3px solid ${T.brand};padding:16px 18px">
        <div style="font-size:10px;font-weight:800;color:${T.brand};letter-spacing:.12em;text-align:center">오늘의 맥락</div>
        <div style="margin-top:9px;font-size:14px;font-weight:600;color:${T.text};line-height:1.65;text-align:left">${esc(sm.hero)}</div>
      </div>
    </td></tr>
    ${section("소비", consume, "금리·수요 전일 · 주간지표 전주 · 물가 전년 · 주택·심리 전월", true, sm.sec.consume)}
    ${section("원가", cost, "환율·유가·운임 전일 · 원자재 전월", false, sm.sec.cost)}
    ${section("가전 주요뉴스", newsRows)}
    ${section("아이디어 뱅크", ideaRows)}
    ${section("보고서", reportRows)}
    <tr><td style="padding:22px;border-top:1px solid ${T.border};text-align:center">
      <div style="font-size:11px;color:${T.muted};line-height:1.7">samsungda.net · 기획 도구모음 자동 발송<br><a href="__UNSUB__" style="color:${T.muted};text-decoration:underline">수신거부</a></div>
    </td></tr>
  </table>
  <div style="max-width:600px;margin:10px auto 0;font-size:11px;color:${T.muted};text-align:center;line-height:1.6">
    지표 출처: Yahoo Finance(환율·유가·구리·금리·홈빌더/소비재ETF), FRED(실업수당청구·모기지·CPI·PCE·주택·소비심리·철광석), FBX(Freightos Baltic Index·운임). 비교시점: 환율·유가·수요ETF·운임 전일, 주간지표 전주, 원자재 전월, 물가 전년, 주택·심리 전월. 주간/월간지표는 최신 발표치 기준.
  </div>
</td></tr>
</table>
</body></html>`;
}

function unsubPage(ok, email) {
  const msg = ok
    ? `<b>${email.replace(/[&<>"]/g, "")}</b> 님의 뉴스레터 수신이 해지되었습니다.`
    : `유효하지 않은 링크입니다. 이미 해지되었거나 링크가 만료되었을 수 있습니다.`;
  return `<!DOCTYPE html><html lang="ko"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/static/pretendard.min.css"><title>수신거부</title></head>
<body style="margin:0;background:${T.bg};font-family:'Pretendard','Apple SD Gothic Neo','Malgun Gothic',system-ui,-apple-system,sans-serif;color:${T.text}">
<div style="max-width:420px;margin:80px auto;padding:32px 28px;background:${T.surface};border:1px solid ${T.border};border-top:3px solid ${T.text};text-align:center">
  <div style="font-size:17px;font-weight:800;margin-bottom:10px">기획 데일리</div>
  <div style="font-size:14px;color:${T.muted};line-height:1.7">${msg}</div>
  <a href="https://samsungda.net" style="display:inline-block;margin-top:20px;color:${T.brand};font-size:13px;font-weight:600;text-decoration:none">도구모음으로 →</a>
</div></body></html>`;
}

function kstDate(ts = Date.now()) {
  const k = new Date(ts + 9 * 3600 * 1000);
  const p = n => String(n).padStart(2, "0");
  return `${k.getUTCFullYear()}.${p(k.getUTCMonth() + 1)}.${p(k.getUTCDate())}`;
}
