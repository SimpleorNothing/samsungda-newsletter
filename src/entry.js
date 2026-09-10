// src/entry.js — 뉴스레터 엔트리 래퍼
//
// B안 리서치 인사이트의 "주1회 15개 풀 → 요일별 3개" 노출을 보장한다.
// R2에 구형 6장 피드가 남아 있어도 런타임에서는 사용하지 않고, 정상 B안 피드 또는
// 최근 3개월 내의 검증된 bootstrap 15장으로 치환한다.

import worker from "./index.js";
import { refreshInsights, selectDailyInsights, isCompleteBPlanFeed } from "./insights.js";
import { INSIGHTS_BOOTSTRAP } from "./insights-bootstrap.js";

const INSIGHTS_KEY = "signals/insights-feed.json";
const INSIGHTS_CRON = "30 20 * * SUN"; // Monday 05:30 KST
// 헬스체크를 09:00 KST에서 07:15 KST로 앞당겼다 — 2026-09-10 07:00 발송 cron이 에러 없이
// 미실행돼(Cloudflare 트리거 스킵) 복구까지 2시간이 걸렸다. cron 개수는 무료 플랜 계정당 5개
// 한도가 있어 늘리지 않고 시각만 옹긴다. index.js는 "0 0 * * *"를 헬스체크 분기로 쓰므로,
// index.js를 수정하지 않고 새 시각의 cron을 같은 분기로 재라우팅한다.
const HEALTH_CRON_ACTUAL = "15 22 * * *"; // 07:15 KST — 실제 등록된 헬스체크 트리거
const HEALTH_CRON_BRANCH = "0 0 * * *";   // index.js 내부 헬스체크 분기 식별자
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
  if (/(한국은행|산업연구원|국가데이터처|통계청|KIEP|대외경제)/i.test(String(src || ""))) return COLORS.deep;
  return COLORS.brand;
}

function runtimeFeed(feed) {
  if (isCompleteBPlanFeed(feed)) return feed;
  if (isCompleteBPlanFeed(INSIGHTS_BOOTSTRAP)) return INSIGHTS_BOOTSTRAP;
  return [];
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

export function applyDailyInsights(html, key, feed) {
  const dateStr = dateFromKeyOrHtml(key, html);
  const dk = dayKey(dateStr);
  if (!dk) return html;

  const safeFeed = runtimeFeed(feed);
  let base = html;
  const old = existingResearchBounds(base);
  if (old) base = base.slice(0, old.start) + base.slice(old.end);

  // 신규 B안 피드조차 확보되지 않으면 구형 섹션은 제거한 상태로 반환한다.
  // 잘못된 6장/수금 포맷을 다시 노출하는 것보다 명시적 공백이 안전하다.
  if (!isCompleteBPlanFeed(safeFeed)) return base;

  const cards = selectDailyInsights(safeFeed, dk);
  if (cards.length !== 3) return base;
  const at = insertPoint(base);
  if (at < 0) return base;
  return base.slice(0, at) + renderSection(cards, dateStr) + base.slice(at);
}

function makeRuntimeEnv(env) {
  const target = env.RESEARCH;
  if (!target) return { env, getFeed: async () => runtimeFeed([]) };
  let cachedFeed = null;

  const getFeed = async () => {
    if (Array.isArray(cachedFeed)) return cachedFeed;
    try {
      const o = await target.get(INSIGHTS_KEY);
      if (!o) {
        cachedFeed = runtimeFeed([]);
        return cachedFeed;
      }
      const a = await o.json();
      cachedFeed = runtimeFeed(Array.isArray(a) ? a : []);
      return cachedFeed;
    } catch {
      cachedFeed = runtimeFeed([]);
      return cachedFeed;
    }
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
              cachedFeed = runtimeFeed(Array.isArray(a) ? a : []);
              return cachedFeed;
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
          try {
            const a = JSON.parse(value);
            cachedFeed = runtimeFeed(Array.isArray(a) ? a : []);
          } catch { cachedFeed = runtimeFeed([]); }
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
      ctx.waitUntil((async () => {
        const result = await refreshInsights(env);
        console.log(`[B안 인사이트 주간 갱신] ${JSON.stringify(result)}`);
      })().catch(e => console.warn(`[B안 인사이트 주간 갱신 실패] ${String((e && e.message) || e)}`)));
      return;
    }
    // 리포트가 이미 있으면 R2 읽기 1회로 끝나고, 없을 때만 sendStored로 복구 발송한다.
    // 발송은 수신자별 멱등키를 쓰므로 07:00 발송이 지연 실행 중이어도 중복 수신되지 않는다.
    if (cron === HEALTH_CRON_ACTUAL) {
      const rtHealth = makeRuntimeEnv(env);
      const proxied = { cron: HEALTH_CRON_BRANCH, scheduledTime: (event && event.scheduledTime) || Date.now() };
      return worker.scheduled(proxied, rtHealth.env, ctx);
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
