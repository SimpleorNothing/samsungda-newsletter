// samsungda-newsletter — 기획 데일리 (Cloudflare Worker + Cron)
//
// 콘텐츠: [원가] 환율(원/페소/바트)·유가(WTI)·원자재(구리·철광석)·운임(SCFI) — 전부 MoM
//         [소비] 금리 美10Y(전일)·물가 美CPI/PCE·韓CPI(YoY)·주택 착공/기존판매(MoM)·소비심리 UMich(MoM)
//         [경쟁사] 가전(WHR·LG·Midea·Haier·SharkNinja)·HVAC(Carrier·Trane·Daikin) 전일 대비
//         [도구모음] MI뉴스·아이디어뱅크·보고서
// 편성: 월~금 데일리. cron 45 22 * * 1-5 (07:45 KST).
// 데이터: Yahoo(range=3mo → 전일·1개월전)·FRED CSV(무키 월간지표)·R2 samsungda-research.
// 구독: R2 "subscribers/<sha256(email)>.json". 발송: Resend(수신자별 개별).
// 라우트: POST /subscribe · GET /unsubscribe · GET /subscribers?key= · /preview · /send?key= · /latest

const MI_NEWS = "https://mi.samsungda.net/data/news.json";
const BANK_PREFIX = "idea-bank/";
const NL_PREFIX = "newsletter/";
const SUB_PREFIX = "subscribers/";
const SCFI_KEY = "signals/scfi.json";
const UA = { headers: { "User-Agent": "Mozilla/5.0" } };
const GRADE_W = { "긴급": 3, "주요": 2, "주시": 1, "참고": 0 };
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DAY = 864e5;
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

// 경쟁사 바스켓 (Yahoo 심볼)
const COMP_APPLIANCE = [
  { n: "Whirlpool", s: "WHR" }, { n: "LG전자", s: "066570.KS" },
  { n: "Midea", s: "000333.SZ" }, { n: "Haier", s: "600690.SS" },
  { n: "SharkNinja", s: "SN" },
];
const COMP_HVAC = [
  { n: "Carrier", s: "CARR" }, { n: "Trane", s: "TT" }, { n: "Daikin", s: "6367.T" },
];

// FRED 시리즈
const FRED = {
  cpiUS: "CPIAUCSL", pce: "PCEPI", cpiKR: "KORCPIALLMINMEI",
  houst: "HOUST", exhome: "EXHOSLUSM495S", umich: "UMCSENT", ironore: "PIORECRUSDM",
};

// DA 디자인 토큰
const T = {
  bg: "#f6f7f9", surface: "#ffffff", text: "#1a1d21",
  muted: "#5b6470", border: "#e6e9ee", brand: "#1257d6",
  up: "#d13b3b", down: "#1257d6",
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
  const symbols = ["KRW=X", "MXN=X", "THB=X", "CL=F", "HG=F", "^TNX"];
  const compAll = [...COMP_APPLIANCE, ...COMP_HVAC];
  const [yq, comp, macro, scfi, news, ideas, reports] = await Promise.all([
    Promise.all(symbols.map(yahoo)),
    Promise.all(compAll.map(c => yahoo(c.s))),
    getMacro(),
    getScfi(env),
    getNews(),
    getIdeas(env),
    getReports(env),
  ]);
  const q = {}; symbols.forEach((s, i) => q[s] = yq[i]);
  const compData = compAll.map((c, i) => ({ ...c, q: comp[i] }));
  return { date: kstDate(), q, comp: compData, macro, scfi, news, ideas, reports };
}
async function buildEmail(env) {
  return renderEmail(await gatherData(env)).split("__UNSUB__").join("#");
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
  const ids = Object.values(FRED);
  const rows = await Promise.all(ids.map(id => fred(id)));
  const s = {}; Object.keys(FRED).forEach((k, i) => s[k] = fredStat(rows[i]));
  return s;
}
async function getScfi(env) {
  if (!env.RESEARCH) return null;
  try { const o = await env.RESEARCH.get(SCFI_KEY); if (o) return await o.json(); } catch { /* ignore */ }
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

// ---------- 렌더 ----------
export function renderEmail(data) {
  const esc = s => String(s == null ? "" : s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const arrow = d => d == null ? "" : ` <span style="color:${d >= 0 ? T.up : T.down};font-weight:600">${d >= 0 ? "▲" : "▼"}${Math.abs(d).toFixed(2)}%</span>`;
  const chg = (cur, base) => (cur == null || base == null || !base) ? "" : arrow((cur - base) / base * 100);
  const mom = q => q ? chg(q.price, q.prevMonth) : "";   // 원가: 1개월전 대비(MoM)
  const dchg = q => q ? chg(q.price, q.prevDay) : "";     // 경쟁사: 전일 대비
  const fmt = (n, d = 2) => n == null ? "—" : Number(n).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
  const line = html => `<div style="padding:4px 0;font-size:14px;color:${T.text};line-height:1.55">• ${html}</div>`;
  const lbl = t => `<span style="color:${T.muted}">${t}</span>`;
  const dot = ' <span style="color:' + T.border + '">·</span> ';
  const q = data.q, m = data.macro, s = data.scfi;

  // 원가 (전부 MoM)
  const fxParts = [
    q["KRW=X"] ? `원/달러 <b>${fmt(q["KRW=X"].price, 1)}</b>${mom(q["KRW=X"])}` : null,
    q["MXN=X"] ? `페소 <b>${fmt(q["MXN=X"].price)}</b>${mom(q["MXN=X"])}` : null,
    q["THB=X"] ? `바트 <b>${fmt(q["THB=X"].price)}</b>${mom(q["THB=X"])}` : null,
  ].filter(Boolean).join(dot);
  const matParts = [
    q["HG=F"] ? `구리 <b>$${fmt(q["HG=F"].price)}/lb</b>${mom(q["HG=F"])}` : null,
    m.ironore ? `철광석 <b>$${fmt(m.ironore.val, 1)}/t</b>${arrow(m.ironore.mom)} <span style="color:${T.muted};font-size:12px">(${m.ironore.date})</span>` : null,
  ].filter(Boolean).join(dot);
  const scfiVal = s && s.value != null
    ? `<b>${fmt(s.value, 1)}</b>${s.mom != null ? arrow(s.mom) : ""} <span style="color:${T.muted};font-size:12px">(${s.asof ? esc(s.asof) : "수동 갱신"})</span>`
    : `<b>—</b> <span style="color:${T.muted};font-size:12px">(수동 갱신)</span>`;
  const cost = [
    fxParts ? line(`${lbl("환율")} ${fxParts}`) : "",
    q["CL=F"] ? line(`${lbl("유가")} WTI <b>$${fmt(q["CL=F"].price)}</b>${mom(q["CL=F"])}`) : "",
    matParts ? line(`${lbl("원자재")} ${matParts}`) : "",
    line(`${lbl("운임")} SCFI ${scfiVal}`),
  ].join("");

  // 소비
  const bp = q["^TNX"] && q["^TNX"].prevDay != null ? Math.round((q["^TNX"].price - q["^TNX"].prevDay) * 100) : null;
  const yoyTxt = st => st && st.yoy != null ? `<b>${st.yoy >= 0 ? "+" : ""}${st.yoy.toFixed(1)}% YoY</b> <span style="color:${T.muted};font-size:12px">(${st.date})</span>` : "<b>—</b>";
  const consume = [
    q["^TNX"] ? line(`${lbl("금리")} 美 10Y <b>${fmt(q["^TNX"].price)}%</b>${bp != null ? ` <span style="color:${bp >= 0 ? T.up : T.down};font-weight:600">${bp >= 0 ? "▲" : "▼"}${Math.abs(bp)}bp</span>` : ""} <span style="color:${T.muted};font-size:12px">(전일)</span>`) : "",
    line(`${lbl("물가")} 美 CPI ${yoyTxt(m.cpiUS)}${dot}PCE ${yoyTxt(m.pce)}${dot}韓 CPI ${yoyTxt(m.cpiKR)}`),
    m.houst || m.exhome ? line(`${lbl("주택")} ${[
      m.houst ? `착공 <b>${fmt(m.houst.val, 0)}K</b>${arrow(m.houst.mom)}` : null,
      m.exhome ? `기존판매 <b>${fmt(m.exhome.val / 1e6, 2)}M</b>${arrow(m.exhome.mom)}` : null,
    ].filter(Boolean).join(dot)} <span style="color:${T.muted};font-size:12px">(MoM)</span>`) : "",
    m.umich ? line(`${lbl("심리")} 美 소비심리(UMich) <b>${fmt(m.umich.val, 1)}</b>${arrow(m.umich.mom)} <span style="color:${T.muted};font-size:12px">(${m.umich.date}·MoM)</span>`) : "",
  ].join("");

  // 경쟁사 (전일 대비)
  const basket = arr => arr.map(c => `${esc(c.n)}${c.q ? dchg(c.q) || " <span style='color:" + T.muted + "'>—</span>" : " <span style='color:" + T.muted + "'>—</span>"}`).join(" &nbsp;·&nbsp; ");
  const comp = [
    line(`${lbl("가전")} ${basket(data.comp.filter(c => COMP_APPLIANCE.some(a => a.s === c.s)))}`),
    line(`${lbl("HVAC")} ${basket(data.comp.filter(c => COMP_HVAC.some(a => a.s === c.s)))}`),
  ].join("");

  // 콘텐츠
  const newsRows = data.news.length
    ? data.news.map(i => `<div style="padding:8px 0;border-bottom:1px solid ${T.border}">
        <a href="${esc(i.url)}" style="color:${T.text};text-decoration:none;font-size:14px;font-weight:600;line-height:1.4">${esc(i.headline)}</a>
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

  const section = (title, body, extra) => `<tr><td style="padding:18px 22px 0">
      <div style="font-size:13px;font-weight:700;color:${T.brand};letter-spacing:.02em">${title}${extra ? ` <span style="color:${T.muted};font-weight:500">${extra}</span>` : ""}</div>
      <div style="margin-top:8px">${body}</div></td></tr>`;

  return `<!DOCTYPE html>
<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:${T.bg};font-family:'Apple SD Gothic Neo','Malgun Gothic',system-ui,-apple-system,sans-serif">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${T.bg};padding:24px 0">
<tr><td align="center">
  <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:${T.surface};border:1px solid ${T.border};border-radius:14px;overflow:hidden">
    <tr><td style="padding:22px 22px 14px;border-bottom:1px solid ${T.border}">
      <div style="font-size:18px;font-weight:800;color:${T.text}">📊 기획 데일리</div>
      <div style="margin-top:2px;font-size:13px;color:${T.muted}">${esc(data.date)} · 기획 도구모음</div>
    </td></tr>
    ${section("원가", cost, "환율·유가·원자재·물류 · MoM")}
    ${section("소비", consume, "금리·물가·주택·심리")}
    ${section("경쟁사 주가", comp, "전일 대비")}
    ${section("가전 주요뉴스", newsRows)}
    ${section("아이디어 뱅크", ideaRows)}
    ${section("보고서", reportRows)}
    <tr><td style="padding:20px 22px 22px">
      <a href="https://samsungda.net" style="color:${T.brand};text-decoration:none;font-size:13px;font-weight:600">도구모음 열기 →</a>
      <div style="margin-top:10px;font-size:11px;color:${T.muted}">기획 도구모음 자동 발송 · <a href="__UNSUB__" style="color:${T.muted};text-decoration:underline">수신거부</a></div>
    </td></tr>
  </table>
  <div style="max-width:600px;margin:10px auto 0;font-size:11px;color:${T.muted};text-align:center;line-height:1.6">
    지표 출처: Yahoo Finance(환율·유가·구리·금리·주가), FRED(CPI·PCE·주택·소비심리·철광석). 원가는 1개월 전 대비(MoM), 월간 지표는 최신 발표월 기준.
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
<meta name="viewport" content="width=device-width,initial-scale=1"><title>수신거부</title></head>
<body style="margin:0;background:${T.bg};font-family:'Apple SD Gothic Neo','Malgun Gothic',system-ui,sans-serif;color:${T.text}">
<div style="max-width:420px;margin:80px auto;padding:32px 28px;background:#fff;border:1px solid ${T.border};border-radius:14px;text-align:center">
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
