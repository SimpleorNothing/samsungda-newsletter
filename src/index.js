// samsungda-newsletter — 기획 도구모음 일간 뉴스레터 (Cloudflare Worker + Cron)
//
// 소스 4종:
//  1) 가전뉴스(MI)   : https://mi.samsungda.net/data/news.json
//  2) 시장지표       : Yahoo(^IXIC·^TNX·CL=F·^KS11) + F&G(ten-bagger/signals.json)
//  3) 아이디어뱅크   : R2 samsungda-research, prefix "idea-bank/*.json" (저장된 것 그대로)
//  4) 클로드 보고서  : R2 samsungda-research 루트 업로드(docx), customMetadata.title
//
// 발송: Resend API.  R2 바인딩: RESEARCH → samsungda-research
// 트리거: Cron(매일) → scheduled().  수동/미리보기: fetch() 라우트.

const MI_NEWS = "https://mi.samsungda.net/data/news.json";
const SIGNALS = "https://raw.githubusercontent.com/SimpleorNothing/ten-bagger/main/signals.json";
const BANK_PREFIX = "idea-bank/";
const NL_PREFIX = "newsletter/";
const UA = { headers: { "User-Agent": "Mozilla/5.0" } };
const GRADE_W = { "긴급": 3, "주요": 2, "주시": 1, "참고": 0 };

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
    if (url.pathname === "/preview") {
      const html = await buildEmail(env);
      return htmlResp(html);
    }
    if (url.pathname === "/send") {
      if (env.TRIGGER_KEY && url.searchParams.get("key") !== env.TRIGGER_KEY)
        return new Response("forbidden", { status: 403 });
      const r = await run(env, { send: true });
      return new Response(JSON.stringify(r), { headers: { "content-type": "application/json" } });
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

async function run(env, { send }) {
  const html = await buildEmail(env);
  const dateKey = kstDate();
  try {
    const meta = { httpMetadata: { contentType: "text/html; charset=utf-8" } };
    await env.RESEARCH.put(`${NL_PREFIX}${dateKey}.html`, html, meta);
    await env.RESEARCH.put(`${NL_PREFIX}latest.html`, html, meta);
  } catch (e) { /* 아카이브 실패는 발송을 막지 않음 */ }

  if (!send) return { ok: true, sent: false };
  const to = (env.RECIPIENTS || "").split(",").map(s => s.trim()).filter(Boolean);
  if (!env.RESEND_API_KEY || !to.length)
    return { ok: false, error: "RESEND_API_KEY 또는 RECIPIENTS 미설정" };

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "Authorization": `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: env.FROM || "기획 도구모음 <newsletter@samsungda.net>",
      to,
      subject: `📊 기획 데일리 · ${dateKey}`,
      html,
    }),
  });
  const j = await res.json().catch(() => ({}));
  return { ok: res.ok, id: j.id, error: j.message };
}

// ---------- 데이터 수집 ----------
async function buildEmail(env) {
  const [market, news, ideas, reports] = await Promise.all([
    getMarket(), getNews(), getIdeas(env), getReports(env),
  ]);
  return renderEmail({ market, news, ideas, reports, date: kstDate() });
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
  } catch { /* signals 실패 시 F&G 생략 */ }
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
        try { const rec = await obj.json(); if (rec && rec.id) items.push(rec); } catch { /* 손상 skip */ }
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
      .filter(o => !o.key.startsWith(BANK_PREFIX) && !o.key.startsWith(NL_PREFIX))
      .map(o => ({
        title: o.customMetadata?.title ? safeDecode(o.customMetadata.title) : o.key,
        uploaded: o.uploaded,
      }))
      .sort((a, b) => new Date(b.uploaded) - new Date(a.uploaded))
      .slice(0, 5);
  } catch { return []; }
}

function safeDecode(s) { try { return decodeURIComponent(s); } catch { return s; } }

// ---------- 렌더 (이메일 HTML: table + inline CSS) ----------
export function renderEmail({ market, news, ideas, reports, date }) {
  const esc = s => String(s == null ? "" : s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const pct = (n, p) => {
    if (n == null || p == null) return "";
    const d = (n - p) / p * 100;
    const up = d >= 0;
    return `<span style="color:${up ? "#d13b3b" : "#1257d6"};font-weight:600">${up ? "▲" : "▼"}${Math.abs(d).toFixed(2)}%</span>`;
  };
  const num = n => (n == null ? "—" : n.toLocaleString());

  // 시장지표
  const m = market;
  const marketRows = [
    m.ndx ? `나스닥 <b>${num(m.ndx.price)}</b> ${pct(m.ndx.price, m.ndx.prev)}` : null,
    m.tnx ? `美 10Y <b>${m.tnx.price.toFixed(2)}%</b>` : null,
    m.wti ? `WTI <b>$${m.wti.price.toFixed(2)}</b> ${pct(m.wti.price, m.wti.prev)}` : null,
    m.ks ? `코스피 <b>${num(m.ks.price)}</b> ${pct(m.ks.price, m.ks.prev)}` : null,
    m.fg ? `CNN F&amp;G <b>${m.fg.score}</b> <span style="color:${T.muted}">(${esc(m.fg.label)})</span>` : null,
  ].filter(Boolean).map(x => `<div style="padding:4px 0;font-size:14px;color:${T.text}">• ${x}</div>`).join("");

  // 가전뉴스
  const newsRows = news.length
    ? news.map(i => `
      <div style="padding:8px 0;border-bottom:1px solid ${T.border}">
        <a href="${esc(i.url)}" style="color:${T.text};text-decoration:none;font-size:14px;font-weight:600;line-height:1.4">${esc(i.headline)}</a>
        <div style="margin-top:3px;font-size:12px;color:${T.muted}">${esc(i.grade)} · ${esc(i.lens)} · ${esc(i.source?.name || "")}</div>
      </div>`).join("")
    : `<div style="font-size:13px;color:${T.muted}">최근 24시간 신규 없음</div>`;

  // 아이디어뱅크
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

  // 클로드 보고서
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
      <div style="margin-top:10px;font-size:11px;color:${T.muted}">본 메일은 기획 도구모음에서 자동 발송되었습니다.</div>
    </td></tr>
  </table>
</td></tr>
</table>
</body></html>`;
}

// ---------- 유틸 ----------
function kstDate(ts = Date.now()) {
  const k = new Date(ts + 9 * 3600 * 1000);
  const p = n => String(n).padStart(2, "0");
  return `${k.getUTCFullYear()}.${p(k.getUTCMonth() + 1)}.${p(k.getUTCDate())}`;
}
