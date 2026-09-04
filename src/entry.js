// src/entry.js — 뉴스레터 엔트리 래퍼
//
// B안 리서치 인사이트의 "주1회 15개 풀 → 요일별 3개" 노출을 대형 src/index.js 수정 없이 적용한다.
// 기존 worker의 데이터 수집/발송 로직은 그대로 사용하고, R2에 저장되는 뉴스레터 HTML에서 기존
// 수/금 전용 리서치 섹션을 제거한 뒤 해당 요일 카드 3개로 교체한다.
// 리서치 풀 갱신은 월요일 05:30 KST 전용 cron으로 분리해 제작 cron의 서브리퀘스트 한도와 격리한다.

import worker from "./index.js";
import { refreshInsights, selectDailyInsights } from "./insights.js";

const INSIGHTS_KEY = "signals/insights-feed.json";
const INSIGHTS_CRON = "30 20 * * 0"; // Sunday 20:30 UTC = Monday 05:30 KST
const COLORS = {
  surface: "#FFFFFF", text: "#17222D", muted: "#5C6B79", border: "#D3D9D6",
  brand: "#46647E", deep: "#2F614D", amber: "#A9790F", bg: "#EDEFEC",
};
const DAY_META = {
  mon: "월 · 국내 거시·산업경기",
  tue: "화 · 글로벌 경쟁전략",
  wed: "수 · 소비자·유통 트렌드",
  thu: "목 · 신사업·글로벌 거시",
  fri: "금 · 주간 종합·균형 관점",
};

const esc = s => String(s == null ? "" : s).replace(/[&<>\"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

function dateFromKeyOrHtml(key, html) {
  const km = String(key || "").match(/(?:outbox|newsletter)\/(\d{4}\.\d{2}\.\d{2})\.html$/);
  if (km) return km[1];
  const hm = String(html || "").match(/(20\d{2}\.\d{2}\.\d{2})\s*\([월화수목금토일]\)/);
  return hm ? hm[1] : "";
}

function dayKey(dateStr) {
  const m = /^(\d{4})\.(\d{2})\.(\d{2})$/.exec(dateStr || "");
  if (!m) return "";
  const n = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])).getUTCDay();
  return ({ 1: "mon", 2: "tue", 3: "wed", 4: "thu", 5: "fri" })[n] || "";
}

function sourceColor(src) {
  if (String(src || "").includes("균형")) return COLORS.amber;
  if (/(한국은행|산업연구원|통계청|KIEP|대외경제)/i.test(String(src || ""))) return COLORS.deep;
  return COLORS.brand;
}

function renderCard(it) {
  const col = sourceColor(it.source);
  const logo = it.domain
    ? `<img src="https://www.google.com/s2/favicons?sz=64&domain=${esc(it.domain)}" width="15" height="15" alt="" style="vertical-align:middle;border-radius:3px;margin-right:6px">`
    : "";
  const stat = it.stat
    ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:9px 0"><tr><td style="padding:9px 11px;background:${COLORS.bg};border-radius:8px"><span style="font-size:18px;font-weight:800;color:${col};vertical-align:middle">${esc(it.stat)}</span> <span style="font-size:12px;color:${COLORS.muted};line-height:1.5">${esc(it.cap || "")}</span></td></tr></table>`
    : "";
  const thumb = it.image
    ? `<img src="${esc(it.image)}" alt="" width="100%" style="width:100%;max-height:130px;object-fit:cover;border-radius:8px;margin:9px 0 0;display:block">`
    : "";
  return `<div style="border:1px solid ${COLORS.border};border-radius:11px;padding:14px 15px;margin-bottom:11px">
      <div style="margin-bottom:8px">${logo}<span style="display:inline-block;font-size:10.5px;font-weight:800;color:#fff;background:${col};padding:3px 9px;border-radius:5px;vertical-align:middle">${esc(it.source || "")}</span> <span style="font-size:10.5px;font-weight:600;color:${COLORS.muted};vertical-align:middle">${esc(it.date || "")}</span></div>
      <div style="font-size:13.5px;font-weight:700;color:${COLORS.text};line-height:1.5">${esc(it.title || "")}</div>
      ${stat}${thumb}
      <table role="presentation" cellpadding="0" cellspacing="0" style="margin-top:6px"><tr><td valign="top" style="color:${col};font-weight:700;font-size:12px;padding-right:6px">&rarr;</td><td style="font-size:12px;color:${COLORS.text};line-height:1.6">${esc(it.impl || "")}</td></tr></table>
      <div style="margin-top:9px"><a href="${esc(it.url)}" target="_blank" rel="noopener noreferrer" style="font-size:11.5px;font-weight:600;color:${col};text-decoration:none">원문 보기 &rarr;</a></div>
    </div>`;
}

function renderSection(cards, dateStr) {
  const dk = dayKey(dateStr);
  const body = cards.map(renderCard).join("");
  return `<tr><td style="padding:20px 22px 0;border-top:1px solid ${COLORS.border}">
      <div style="font-size:13px;font-weight:700;color:${COLORS.brand};letter-spacing:.02em">리서치 인사이트 <span style="color:${COLORS.muted};font-weight:500">${esc(DAY_META[dk] || "요일별 리서치")}</span></div>
      <div style="margin-top:8px">${body}</div></td></tr>`;
}

function existingResearchBounds(html) {
  const p = html.indexOf("리서치 인사이트");
  if (p < 0) return null;
  const nextIcon = html.indexOf('aria-label="기획 인사이트"', p);
  if (nextIcon < 0) return null;
  const start = html.lastIndexOf("<tr><td", p);
  const end = html.lastIndexOf("<tr><td", nextIcon);
  return (start >= 0 && end > start) ? { start, end } : null;
}

function insertPoint(html) {
  const icon = html.indexOf('aria-label="기획 인사이트"');
  if (icon < 0) return -1;
  return html.lastIndexOf("<tr><td", icon);
}

function applyDailyInsights(html, key, feed) {
  if (!Array.isArray(feed) || !feed.some(c => c && c.day)) return html;
  const dateStr = dateFromKeyOrHtml(key, html);
  const dk = dayKey(dateStr);
  if (!dk) return html;
  const cards = selectDailyInsights(feed, dk);
  if (cards.length !== 3) return html;

  let base = html;
  const b = existingResearchBounds(base);
  if (b) base = base.slice(0, b.start) + base.slice(b.end);
  const at = insertPoint(base);
  if (at < 0) return html;
  return base.slice(0, at) + renderSection(cards, dateStr) + base.slice(at);
}

function makeRuntimeEnv(env) {
  const target = env.RESEARCH;
  if (!target) return { env, getFeed: async () => [] };
  let cachedFeed = null;

  const getFeed = async () => {
    if (Array.isArray(cachedFeed)) return cachedFeed;
    try {
      const o = await target.get(INSIGHTS_KEY);
      if (!o) return [];
      const a = await o.json();
      cachedFeed = Array.isArray(a) ? a : [];
      return cachedFeed;
    } catch { return []; }
  };

  const bucket = new Proxy(target, {
    get(obj, prop) {
      if (prop === "get") return async (key, ...args) => {
        const o = await obj.get(key, ...args);
        if (key !== INSIGHTS_KEY || !o) return o;
        return new Proxy(o, {
          get(ro, rp) {
            if (rp === "json") return async () => {
              const a = await ro.json();
              cachedFeed = Array.isArray(a) ? a : [];
              return a;
            };
            const v = ro[rp];
            return typeof v === "function" ? v.bind(ro) : v;
          },
        });
      };
      if (prop === "put") return async (key, value, options) => {
        let v = value;
        if (typeof v === "string" && /^(?:newsletter\/(?:latest|\d{4}\.\d{2}\.\d{2})|outbox\/\d{4}\.\d{2}\.\d{2})\.html$/.test(String(key))) {
          v = applyDailyInsights(v, key, await getFeed());
        }
        if (key === INSIGHTS_KEY && typeof value === "string") {
          try { const a = JSON.parse(value); if (Array.isArray(a)) cachedFeed = a; } catch { /* ignore */ }
        }
        return obj.put(key, v, options);
      };
      const v = obj[prop];
      return typeof v === "function" ? v.bind(obj) : v;
    },
  });

  const wrapped = Object.create(env);
  Object.defineProperty(wrapped, "RESEARCH", { value: bucket, enumerable: true, configurable: true });
  return { env: wrapped, getFeed };
}

export default {
  async scheduled(event, env, ctx) {
    const cron = (event && event.cron) || "";
    if (cron === INSIGHTS_CRON) {
      ctx.waitUntil(refreshInsights(env).catch(e => console.warn(`[B안 인사이트 주간 갱신 실패] ${String((e && e.message) || e)}`)));
      return;
    }
    const rt = makeRuntimeEnv(env);
    return worker.scheduled(event, rt.env, ctx);
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const rt = makeRuntimeEnv(env);
    const response = await worker.fetch(request, rt.env, ctx);

    if (url.pathname === "/preview" && (response.headers.get("content-type") || "").includes("text/html")) {
      const html = await response.text();
      const feed = await rt.getFeed();
      const transformed = applyDailyInsights(html, "preview", feed);
      return new Response(transformed, { status: response.status, statusText: response.statusText, headers: response.headers });
    }
    return response;
  },
};
