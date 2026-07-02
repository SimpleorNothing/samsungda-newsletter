// samsungda-newsletter — 기획 도구모음 일간 뉴스레터 (Cloudflare Worker + Cron)
//
// 소스 4종:
//  1) 가전뉴스(MI)   : https://mi.samsungda.net/data/news.json
//  2) 시장지표       : Yahoo(^IXIC·^TNX·CL=F·^KS11) + F&G(ten-bagger/signals.json)
//  3) 아이디어뱅크   : R2 samsungda-research, prefix "idea-bank/*.json" (저장된 것 그대로)
//  4) 클로드 보고서  : R2 samsungda-research 루트 업로드(docx), customMetadata.title
//
// 구독: R2 "subscribers/<sha256(email)>.json".  발송: Resend(수신자별 개별 발송).
// 라우트: POST /subscribe · GET /unsubscribe · /preview · /send?key= · /latest
// R2 바인딩: RESEARCH → samsungda-research

const MI_NEWS = "https://mi.samsungda.net/data/news.json";
const SIGNALS = "https://raw.githubusercontent.com/SimpleorNothing/ten-bagger/main/signals.json";
const BANK_PREFIX = "idea-bank/";
const NL_PREFIX = "newsletter/";
const SUB_PREFIX = "subscribers/";
const UA = { headers: { "User-Agent": "Mozilla/5.0" } };
const GRADE_W = { "긴급": 3, "주요": 2, "주시": 1, "참고": 0 };
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

// DA 디자인 토큰
const T = {
  bg: "#f6f7f9", surface: "#ffffff", text: "#1a1d21",
  muted: "#5b6470", border: "#e6e9ee", brand: "#1257d6",
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
  } catch (e) {
    return json({ ok: false, error: "store_failed" }, 500);
  }
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
  } catch { /* 아카이브 실패는 발송을 막지 않음 */ }

  if (!send) return { ok: true, sent: false };
  if (!env.RESEND_API_KEY) return { ok: false, error: "RESEND_API_KEY 미설정" };
  const to = await allRecipients(env);
  if (!to.length) return { ok: false, error: "수신자 없음(RECIPIENTS/구독자 비어있음)" };

  let sent = 0, failed = 0; const errs = [];
  for (const email of to) {
    const token = await signToken(email, signKey(env));
    const link = pub ? `${pub}/unsubscribe?e=${encodeURIComponent(email)}&t=${token}` : "#";
    const html = base.split("__UNSUB__").join(link);
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Authorization": `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: env.FROM || "기획 도구모음 <newsletter@samsungda.net>",
        to: [email],
        subject: `📊 기획 데일리 · ${data.date}`,
        html,
      }),
    });
    if (res.ok) sent++;
    else { failed++; const j = await res.json().catch(() => ({})); errs.push(j.message || res.status); }
  }
  return { ok: failed === 0, sent, failed, errors: errs.slice(0, 3) };
}

// ---------- 데이터 수집 ----------
async function gatherData(env) {
  const [market, news, ideas, reports] = await Promise.all([
    getMarket(), getNews(), getIdeas(env), getReports(env),
  ]);
  return { market, news, ideas, reports, date: kstDate() };
}
async function buildEmail(env) {
  return renderEmail(await gatherData(env)).split("__UNSUB__").join("#");
}

async function yahoo(sym) {
  try {
    const u = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=1d&range=5d`;
    const m = (await (await fetch(u, UA)).json()).chart.result[0].meta;
    return { price: m.regularMarketPrice, prev: m.chartPreviousClose };
  } catch { return null; }
}
async function getMarket() {
  const [ndx, tnx, wti, ks] = await Promise.all(
    [yahoo("^IXIC"), yahoo("^TNX"), yahoo("CL=F"), yahoo("^KS11")]
  );
  let fg = null;
  try {
    const v = (await (await fetch(SIGNALS, UA)).json()).fearGreed;
    if (typeof v === "number") {
      const label = v < 25 ? "극단적 공포" : v < 45 ? "공포" : v <= 55 ? "중립" : v <= 75 ? "탐욕" : "극단적 탐욕";
      fg = { score: v, label };
    }
  } catch { /* F&G 생략 */ }
  return { ndx, tnx, wti, ks, fg };
}
async function getNews() {
  try {
    const j = await (await fetch(MI_NEWS, UA)).json();
    const items = j.items || [];
    const cut = Date.now() - 24 * 3600 * 1000;
    const recent = items.filter(i => new Date(i.publishedAt).getTime() >= cut);
    const pool = recent.length ? recent : items;
    return pool
      .sort((a, b) => (GRADE_W[b.grade] - GRADE_W[a.grade]) || (b.impact - a.impact))
      .slice(0, 5);
  } catch { return []; }
}
async function getIdeas(env) {
  if (!env.RESEARCH) return [];
  const items = [];
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
      .filter(o => !o.key.startsWith(BANK_PREFIX) && !o.key.startsWith(NL_PREFIX) && !o.key.startsWith(SUB_PREFIX))
      .map(o => ({
        title: o.customMetadata?.title ? safeDecode(o.customMetadata.title) : o.key,
        uploaded: o.uploaded,
      }))
      .sort((a, b) => new Date(b.uploaded) - new Date(a.uploaded))
      .slice(0, 5);
  } catch { return []; }
}
function safeDecode(s) { try { return decodeURIComponent(s); } catch { return s; } }

// ---------- 렌더 (이메일 HTML) ----------
export function renderEmail({ market, news, ideas, reports, date }) {
  const esc = s => String(s == null ? "" : s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const pct = (n, p) => {
    if (n == null || p == null) return "";
    const d = (n - p) / p * 100;
    const up = d >= 0;
    return `<span style="color:${up ? "#d13b3b" : "#1257d6"};font-weight:600">${up ? "▲" : "▼"}${Math.abs(d).toFixed(2)}%</span>`;
  };
  const num = n => (n == null ? "—" : n.toLocaleString());
  const m = market;
  const marketRows = [
    m.ndx ? `나스닥 <b>${num(m.ndx.price)}</b> ${pct(m.ndx.price, m.ndx.prev)}` : null,
    m.tnx ? `美 10Y <b>${m.tnx.price.toFixed(2)}%</b>` : null,
    m.wti ? `WTI <b>$${m.wti.price.toFixed(2)}</b> ${pct(m.wti.price, m.wti.prev)}` : null,
    m.ks ? `코스피 <b>${num(m.ks.price)}</b> ${pct(m.ks.price, m.ks.prev)}` : null,
    m.fg ? `CNN F&amp;G <b>${m.fg.score}</b> <span style="color:${T.muted}">(${esc(m.fg.label)})</span>` : null,
  ].filter(Boolean).map(x => `<div style="padding:4px 0;font-size:14px;color:${T.text}">• ${x}</div>`).join("");

  const newsRows = news.length
    ? news.map(i => `
      <div style="padding:8px 0;border-bottom:1px solid ${T.border}">
        <a href="${esc(i.url)}" style="color:${T.text};text-decoration:none;font-size:14px;font-weight:600;line-height:1.4">${esc(i.headline)}</a>
        <div style="margin-top:3px;font-size:12px;color:${T.muted}">${esc(i.grade)} · ${esc(i.lens)} · ${esc(i.source?.name || "")}</div>
      </div>`).join("")
    : `<div style="font-size:13px;color:${T.muted}">최근 24시간 신규 없음</div>`;

  const ideaRows = ideas.length
    ? ideas.map(i => {
        const dir = i.dir === "profit" ? "수익" : "매출";
        const topic = i.topic ? ` · ${esc(i.topic)}` : "";
        const memo = i.memo ? `<div style="margin-top:3px;font-size:12px;color:${T.muted}">${esc(i.memo).slice(0, 90)}</div>` : "";
        return `
      <div style="padding:8px 0;border-bottom:1px solid ${T.border}">
        <span style="display:inline-block;font-size:11px;color:${T.brand};font-weight:700">[${dir}${topic}]</span>
        <span style="font-size:14px;font-weight:600;color:${T.text}">${esc(i.title)}</span>
        ${memo}
      </div>`;
      }).join("")
    : `<div style="font-size:13px;color:${T.muted}">저장된 아이디어 없음</div>`;

  const reportRows = reports.length
    ? reports.map(r => `
      <div style="padding:6px 0;border-bottom:1px solid ${T.border};font-size:14px;color:${T.text}">
        📄 ${esc(r.title)}
        <span style="font-size:12px;color:${T.muted}"> · ${esc(kstDate(new Date(r.uploaded).getTime()))}</span>
      </div>`).join("")
    : `<div style="font-size:13px;color:${T.muted}">최근 신규 보고서 없음</div>`;

  const section = (title, body) => `
    <tr><td style="padding:18px 22px 0">
      <div style="font-size:13px;font-weight:700;color:${T.brand};letter-spacing:.02em">${title}</div>
      <div style="margin-top:8px">${body}</div>
    </td></tr>`;

  return `<!DOCTYPE html>
<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:${T.bg};font-family:'Apple SD Gothic Neo','Malgun Gothic',system-ui,-apple-system,sans-serif">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${T.bg};padding:24px 0">
<tr><td align="center">
  <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:${T.surface};border:1px solid ${T.border};border-radius:14px;overflow:hidden">
    <tr><td style="padding:22px 22px 14px;border-bottom:1px solid ${T.border}">
      <div style="font-size:18px;font-weight:800;color:${T.text}">📊 기획 데일리</div>
      <div style="margin-top:2px;font-size:13px;color:${T.muted}">${esc(date)} · 기획 도구모음</div>
    </td></tr>
    ${section("시장지표", marketRows)}
    ${section("가전 주요뉴스", newsRows)}
    ${section("아이디어 뱅크", ideaRows)}
    ${section("클로드 작성 보고서", reportRows)}
    <tr><td style="padding:20px 22px 22px">
      <a href="https://samsungda.net" style="color:${T.brand};text-decoration:none;font-size:13px;font-weight:600">도구모음 열기 →</a>
      <div style="margin-top:10px;font-size:11px;color:${T.muted}">본 메일은 기획 도구모음에서 자동 발송되었습니다. · <a href="__UNSUB__" style="color:${T.muted};text-decoration:underline">수신거부</a></div>
    </td></tr>
  </table>
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

// ---------- 유틸 ----------
function kstDate(ts = Date.now()) {
  const k = new Date(ts + 9 * 3600 * 1000);
  const p = n => String(n).padStart(2, "0");
  return `${k.getUTCFullYear()}.${p(k.getUTCMonth() + 1)}.${p(k.getUTCDate())}`;
}
