// samsungda-newsletter — 기획 데일리 (Cloudflare Worker + Cron)
//
// 콘텐츠: [원가] 환율(원·페소·바트·동·루피·즈워티 — 생산거점 통화, 원가 관점 전용)·유가(전일)·원자재(전월)·운임 FBX(일간, R2 갱신)
//         [소비] 금리 美10Y(전일)·수요 홈빌더ITB/소비재XLY(전일)·주간 실업수당청구/30Y모기지(전주)·물가 美CPI/PCE·韓CPI(YoY)·주택 착공/기존판매(MoM)·소비심리 UMich(MoM)
//         [도구모음] MI뉴스·아이디어뱅크·보고서
// 편성: 월~금 데일리. cron 45 22 * * 1-5 (07:45 KST).
// 데이터: Yahoo(range=6mo → 전일·1개월전·6M추이 스파크라인)·FRED CSV(무키 월간지표)·R2 samsungda-research.
// 히어로: Claude API(claude-sonnet-4-5) 맥락 브리핑 — '오늘의 맥락'(지표·뉴스를 연결한 2~3문장)
//         + 소비/원가 섹션별 해석 한 줄 + 뉴스별 내용·기회·위협 각 한 줄. 모든 해석에 근거 지표 병기. 키 없으면 규칙 폴백. CTA 없음.
// 구독: R2 "subscribers/<sha256(email)>.json". 발송: Resend(수신자별 개별).
// 라우트: POST /subscribe · GET /unsubscribe · GET /subscribers?key= · /preview · /send?key= · /latest
// 인사이트: [누적신호] R2 signals/history.json 일별 스냅샷 축적 → 주간 델타·연속 스트릭·수요 분화(ITB↔XLY) 임계 감지. preview는 읽기전용, 실발송/cron만 기록.
//           [CI라우팅] MI뉴스 → LG 전략축(A1~A6) 키워드 매칭 → LG 관련건 축 뱃지 + signals/ci-candidates.json 스테이징(사람 검토용, evidence.json 자동커밋 없음).

const MI_NEWS = "https://mi.samsungda.net/data/news.json";
const BANK_PREFIX = "idea-bank/";
const NL_PREFIX = "newsletter/";
const SUB_PREFIX = "subscribers/";
const FBX_KEY = "signals/fbx.json";  // FBX(Freightos Baltic Index) 일간 운임지수 — R2 수동/외부 갱신
const SIG_KEY = "signals/history.json";        // 일별 지표 스냅샷 누적(최대 90일) — 누적 신호 감지용
const CI_CAND_KEY = "signals/ci-candidates.json"; // LG 전략축 관련 뉴스 스테이징(CI 센싱 inbox 후보, 사람 검토)
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

// LG 전략축 카탈로그 — competitor_intelligence strategies.json (lg-a1~a6) 동기화. 뉴스→축 라우팅 키워드.
const CI_AXES = [
  { code: "A1", id: "lg-a1", title: "구독/서비스 수익모델 확장", kw: ["구독", "렌탈", "케어", "멤버십", "구독료", "가전구독", "서비스매출", "d2x"] },
  { code: "A2", id: "lg-a2", title: "HVAC·AIDC 확장", kw: ["공조", "hvac", "칠러", "히트펌프", "냉난방", "시스템에어컨", "데이터센터", "aidc", "냉각", "에어컨", "공조기", "공조사업"] },
  { code: "A3", id: "lg-a3", title: "AI홈 플랫폼", kw: ["ai홈", "씽큐", "thinq", "스마트홈", "생성형", "ai가전", "온디바이스", "홈허브", "ai에이전트", "ai 홈"] },
  { code: "A4", id: "lg-a4", title: "볼륨존·원가구조 재편", kw: ["볼륨존", "보급형", "원가구조", "저가", "가격경쟁", "희망퇴직", "고정비", "중국계", "생산지 최적화"] },
  { code: "A5", id: "lg-a5", title: "지역 포트폴리오 재편", kw: ["인도", "관세", "글로벌사우스", "글로벌 사우스", "역내생산", "현지생산", "멕시코", "베트남", "동남아", "신흥시장", "ipo", "리쇼어링"] },
  { code: "A6", id: "lg-a6", title: "로봇 사업 본격화", kw: ["로봇", "휴머노이드", "액추에이터", "로보틱스", "협동로봇", "로보스타", "로보티즈", "베어로보틱스", "글로이드"] },
];
// 뉴스 항목 → 매칭된 축 배열(점수 내림차순). headline·summary·tags·products 표면 검색.
function matchAxes(item) {
  const hay = [item.headline, item.summary, (item.tags || []).join(" "), (item.products || []).join(" ")].join(" ").toLowerCase();
  const out = [];
  for (const ax of CI_AXES) {
    let hits = 0;
    for (const k of ax.kw) if (hay.includes(k)) hits++;
    if (hits) out.push({ code: ax.code, id: ax.id, title: ax.title, score: hits });
  }
  return out.sort((a, b) => b.score - a.score);
}
// LG전자 관련 + 축 매칭된 뉴스만 CI 센싱 후보로 추림(중복 제거, 최대 10). evidence.json 자동커밋 아님 — 사람 검토용 스테이징.
function buildCiCandidates(pool) {
  const seen = new Set(), out = [];
  for (const it of (pool || [])) {
    if (!(it.competitors || []).includes("LG전자")) continue;
    const ax = matchAxes(it);
    if (!ax.length || seen.has(it.id)) continue;
    seen.add(it.id);
    out.push({
      id: it.id, headline: it.headline, url: it.url, grade: it.grade,
      summary: it.summary, publishedAt: it.publishedAt,
      axes: ax.slice(0, 2).map(a => ({ code: a.code, id: a.id, title: a.title })),
    });
    if (out.length >= 10) break;
  }
  return out;
}
async function persistCiCandidates(env, data) {
  if (!env.RESEARCH) return;
  try {
    await env.RESEARCH.put(CI_CAND_KEY,
      JSON.stringify({ date: data.date, generatedAt: Date.now(), items: data.ciCand || [] }),
      { httpMetadata: { contentType: "application/json" } });
  } catch { /* 무시 */ }
}

// ---------- 누적 신호(시계열 축적 + 임계 감지) ----------
// 오늘 핵심 지표를 한 줄 스냅샷으로 환원.
function snapshotSignals(data) {
  const q = data.q, s = data.freight;
  const g = k => q[k] ? q[k].price : null;
  return {
    date: data.date,
    krw: g("KRW=X"), mxn: g("MXN=X"), thb: g("THB=X"), vnd: g("VND=X"), inr: g("INR=X"), pln: g("PLN=X"),
    wti: g("CL=F"), copper: g("HG=F"), tnx: g("^TNX"), itb: g("ITB"), xly: g("XLY"),
    fbx: s && s.value != null ? s.value : null,
  };
}
async function loadSignalHistory(env) {
  if (!env.RESEARCH) return [];
  try { const o = await env.RESEARCH.get(SIG_KEY); if (o) { const a = await o.json(); return Array.isArray(a) ? a : []; } } catch { /* 무시 */ }
  return [];
}
async function persistSignals(env, data) {
  if (!env.RESEARCH) return;
  try {
    let hist = await loadSignalHistory(env);
    const snap = snapshotSignals(data);
    hist = hist.filter(x => x.date !== snap.date);  // 같은 날 재실행 upsert
    hist.push(snap);
    hist.sort((a, b) => (a.date < b.date ? -1 : 1));
    if (hist.length > 90) hist = hist.slice(hist.length - 90);
    await env.RESEARCH.put(SIG_KEY, JSON.stringify(hist), { httpMetadata: { contentType: "application/json" } });
  } catch { /* 무시 */ }
}
// 축적분 대비 주간 누적 델타 + 연속 스트릭 → 임계 돌파 신호. 데이터 얕으면 조용히 비활성.
function analyzeSignals(history, data) {
  const breaches = [];
  const past = (history || []).filter(x => x.date < data.date);
  if (past.length < 3) return { breaches, ready: false };
  const snap = snapshotSignals(data);
  const ref = past.length >= 5 ? past[past.length - 5] : past[0];   // ≈1주 전(저장 5영업일)
  const cum = k => (snap[k] != null && ref[k] != null && ref[k]) ? (snap[k] - ref[k]) / ref[k] * 100 : null;
  const bpd = k => (snap[k] != null && ref[k] != null) ? (snap[k] - ref[k]) * 100 : null;
  const streak = k => {
    const seq = [...past.slice(-6).map(x => x[k]), snap[k]].filter(v => v != null);
    if (seq.length < 3) return 0;
    let dir = 0, run = 0;
    for (let i = seq.length - 1; i > 0; i--) {
      const d = Math.sign(seq[i] - seq[i - 1]);
      if (d === 0) break;
      if (dir === 0) { dir = d; run = 1; } else if (d === dir) run++; else break;
    }
    return dir * run;
  };
  const sp = v => `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`;
  // 환율(생산거점 통화 강세 = 원가 상승, 원화 강세 = 원가 하락)
  const fx = [["krw", "원/달러"], ["mxn", "페소"], ["thb", "바트"], ["vnd", "동"], ["inr", "루피"], ["pln", "즈워티"]];
  for (const [k, nm] of fx) {
    const c = cum(k), st = streak(k);
    if (c != null && Math.abs(c) >= 1.5) {
      const detail = k === "krw"
        ? (c < 0 ? "원화 강세 — 달러 결제 부품·원자재 원화환산 원가 하락 요인" : "원화 약세 — 수입 부품 원가 상승 요인")
        : (c >= 0 ? "현지통화 약세 — 현지 조달·인건비 달러환산 하락 요인" : "현지통화 강세 — 현지 원가 상승 요인");
      breaches.push({ label: `${nm} 주간 ${sp(c)}`, detail, dir: Math.sign(c) });
    } else if (Math.abs(st) >= 4) {
      breaches.push({ label: `${nm} ${Math.abs(st)}일 연속 ${st > 0 ? "상승" : "하락"}`, detail: "방향성 지속 — 추세 형성 구간", dir: Math.sign(st) });
    }
  }
  const cWti = cum("wti");
  if (cWti != null && Math.abs(cWti) >= 3) breaches.push({ label: `WTI 주간 ${sp(cWti)}`, detail: cWti >= 0 ? "유가 상승 — 물류·수지원가 압력" : "유가 하락 — 원가 완화 요인", dir: Math.sign(cWti) });
  const cCu = cum("copper");
  if (cCu != null && Math.abs(cCu) >= 3) breaches.push({ label: `구리 주간 ${sp(cCu)}`, detail: cCu >= 0 ? "원자재 상승 — 모터·배선 원가 압력" : "원자재 하락 — 원가 완화 요인", dir: Math.sign(cCu) });
  const bTnx = bpd("tnx");
  if (bTnx != null && Math.abs(bTnx) >= 15) breaches.push({ label: `美10Y 주간 ${bTnx >= 0 ? "+" : ""}${Math.round(bTnx)}bp`, detail: bTnx >= 0 ? "금리 상승 — 교체·주택 수요 위축 신호" : "금리 하락 — 수요 여건 개선 신호", dir: Math.sign(bTnx) });
  const cItb = cum("itb"), cXly = cum("xly");
  if (cItb != null && Math.abs(cItb) >= 3) breaches.push({ label: `홈빌더ETF 주간 ${sp(cItb)}`, detail: cItb >= 0 ? "주택·빌트인 수요 기대 개선 신호" : "주택·빌트인 수요 기대 위축 신호", dir: Math.sign(cItb) });
  // 다이버전스: 주택 vs 일반소비 방향 갈림
  if (cItb != null && cXly != null && Math.sign(cItb) !== Math.sign(cXly) && Math.abs(cItb) >= 2 && Math.abs(cXly) >= 2)
    breaches.push({ label: "수요 분화", detail: `홈빌더 ${sp(cItb)} vs 소비재 ${sp(cXly)} — 주택·빌트인과 일반소비 방향 갈림`, dir: Math.sign(cItb) });
  return { breaches: breaches.slice(0, 6), ready: true, refDate: ref.date };
}

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
    if (url.pathname === "/recipients") {
      if (!env.TRIGGER_KEY || url.searchParams.get("key") !== env.TRIGGER_KEY)
        return new Response("forbidden", { status: 403 });
      const stat = (env.RECIPIENTS || "").split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
      const subs = await getSubscribers(env);
      const statSet = new Set(stat), subSet = new Set(subs);
      const all = [...new Set([...stat, ...subs])];
      const recipients = all.map(email => ({
        email,
        source: (statSet.has(email) && subSet.has(email)) ? "both"
              : statSet.has(email) ? "fixed" : "subscribed",
      }));
      return json({ count: recipients.length, fixed: stat.length, subscribed: subs.length, recipients });
    }
    if (url.pathname === "/" || url.pathname === "/archive") return htmlResp(await archivePage(env));
    if (url.pathname === "/latest") {
      const obj = await env.RESEARCH.get(NL_PREFIX + "latest.html");
      if (obj) return htmlResp(await obj.text());
      return new Response("아직 발행된 뉴스레터가 없습니다.", { status: 404 });
    }
    if (url.pathname === "/issue") {
      const d = url.searchParams.get("d") || "";
      if (!/^\d{4}\.\d{2}\.\d{2}$/.test(d)) return new Response("bad request", { status: 400 });
      const obj = await env.RESEARCH.get(`${NL_PREFIX}${d}.html`);
      if (obj) return htmlResp(await obj.text());
      return new Response("해당 호를 찾을 수 없습니다.", { status: 404 });
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
  await sendWelcome(env, email);  // 확인 메일 발송(실패해도 구독 성공엔 영향 없음)
  return json({ ok: true, email });
}
// Resend 단건 발송 헬퍼(구독 확인·데일리 공용). ok/에러를 반환.
async function sendResend(env, { to, subject, html }) {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "Authorization": `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: env.FROM || "기획 도구모음 <newsletter@samsungda.net>", to: [to], subject, html }),
  });
  if (res.ok) return { ok: true };
  const j = await res.json().catch(() => ({}));
  return { ok: false, error: j.message || res.status };
}
// 구독 신청 확인 메일 — Resend 로 즉시 발송. 키/네트워크 실패는 조용히 무시(구독은 이미 저장됨).
async function sendWelcome(env, email) {
  if (!env.RESEND_API_KEY) return;
  const pub = (env.PUBLIC_URL || "").replace(/\/$/, "");
  const token = await signToken(email, signKey(env));
  const unsub = pub ? `${pub}/unsubscribe?e=${encodeURIComponent(email)}&t=${token}` : "#";
  try {
    await sendResend(env, {
      to: email,
      subject: "📊 기획 데일리 · 구독 신청이 완료되었습니다",
      html: welcomeEmail(pub, unsub),
    });
  } catch { /* 확인 메일 실패 무시 */ }
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
  // 누적 신호 스냅샷 + CI 센싱 후보 기록(실발송·cron 경로에서만 — preview는 오염 방지 위해 미기록)
  await persistSignals(env, data);
  await persistCiCandidates(env, data);

  if (!send) return { ok: true, sent: false };
  if (!env.RESEND_API_KEY) return { ok: false, error: "RESEND_API_KEY 미설정" };
  const to = await allRecipients(env);
  if (!to.length) return { ok: false, error: "수신자 없음" };

  const subject = `📊 기획 데일리 · ${data.date} (${kstWeekday(data.date)})`;
  let sent = 0, failed = 0; const errs = [];
  for (const email of to) {
    const token = await signToken(email, signKey(env));
    const link = pub ? `${pub}/unsubscribe?e=${encodeURIComponent(email)}&t=${token}` : "#";
    const html = base.split("__UNSUB__").join(link);
    const r = await sendResend(env, { to: email, subject, html });
    if (r.ok) sent++;
    else { failed++; errs.push(r.error); }
  }
  return { ok: failed === 0, sent, failed, errors: errs.slice(0, 3) };
}

// ---------- 데이터 수집 ----------
async function gatherData(env) {
  const symbols = ["KRW=X", "MXN=X", "THB=X", "VND=X", "INR=X", "PLN=X", "CL=F", "HG=F", "^TNX", "ITB", "XLY"];
  const [yq, macro, freight, newsPool, ideas, reports, sigHist] = await Promise.all([
    Promise.all(symbols.map(yahoo)),
    getMacro(),
    getFreight(env),
    getNews(),
    getIdeas(env),
    getReports(env),
    loadSignalHistory(env),
  ]);
  const q = {}; symbols.forEach((s, i) => q[s] = yq[i]);
  const news = (newsPool || []).slice(0, 5);
  const data = { date: kstDate(), q, macro, freight, news, ideas, reports };
  data.signals = analyzeSignals(sigHist, data);
  data.ciCand = buildCiCandidates(newsPool);
  data.summary = await aiSummary(env, data);
  return data;
}
async function buildEmail(env) {
  return renderEmail(await gatherData(env), { sample: true }).split("__UNSUB__").join("#");
}

// ---------- 뉴스레터 모음 (아카이브 + 구독) ----------
async function listIssues(env) {
  const out = [];
  if (!env.RESEARCH) return out;
  try {
    let cursor;
    do {
      const listed = await env.RESEARCH.list({ prefix: NL_PREFIX, cursor });
      for (const o of (listed.objects || [])) {
        const m = o.key.match(/^newsletter\/(\d{4}\.\d{2}\.\d{2})\.html$/);
        if (m) out.push(m[1]);
      }
      cursor = listed.truncated ? listed.cursor : null;
    } while (cursor);
  } catch { /* ignore */ }
  out.sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
  return out;
}
async function archivePage(env) {
  const pub = (env.PUBLIC_URL || "").replace(/\/$/, "");
  const issues = await listIssues(env);
  const UPDATES = [
    { d: "2026.07.04", t: "페이지 하단 업데이트 이력 표시 추가" },
  ];
  const updLatest = UPDATES.length ? UPDATES[0].d : "";
  const updRows = UPDATES.map(function (u) {
    return '<li><span class="ld">' + u.d + '</span><span class="lt">' + u.t + '</span></li>';
  }).join("");
  const rows = issues.map(function (d) {
    return '<a class="iss" href="' + pub + '/issue?d=' + encodeURIComponent(d) + '"><span class="d">' + d.replace(/\./g, ". ") + ' <span class="dow">(' + kstWeekday(d) + ')</span></span><span class="go">기획 데일리 &rarr;</span></a>';
  }).join("");
  const list = issues.length
    ? '<div class="list">' + rows + '</div>'
    : '<div class="empty"><b>아직 발행된 뉴스레터가 없습니다.</b><br>구독해 두시면 첫 호부터 메일로 받아보실 수 있습니다.</div>';
  return `<!DOCTYPE html>
<html lang="ko"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>뉴스레터 모음 · 기획 데일리</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/static/pretendard.min.css">
<style>
:root{--bg:#EDEFEC;--surface:#fff;--ink:#17222D;--muted:#5C6B79;--line:#D3D9D6;--brand:#46647E;--insight:#B02E24}
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:"Pretendard",-apple-system,"Apple SD Gothic Neo","Malgun Gothic",sans-serif;background:var(--bg);color:var(--ink);padding:56px 20px;line-height:1.6}
.wrap{max-width:620px;margin:0 auto}
header{position:relative;border-bottom:2px solid var(--ink);padding-bottom:16px;margin-bottom:24px}
.eyebrow{font-size:12px;font-weight:700;letter-spacing:.14em;color:var(--brand);margin-bottom:8px}
h1{font-size:28px;font-weight:800;letter-spacing:-.5px}
.sub{font-size:14px;color:var(--muted);margin-top:8px}
.subscribe{margin-top:28px}
.lead{font-size:13px;color:var(--muted);margin-bottom:14px}
.form{display:flex;gap:8px}
.form input{flex:1;font:inherit;font-size:14px;padding:10px 12px;border:1px solid var(--line);background:#fff;color:var(--ink)}
.form input:focus{outline:none;border-color:var(--brand)}
.form button{font:inherit;font-size:14px;font-weight:700;padding:10px 18px;border:none;background:var(--brand);color:#fff;cursor:pointer;white-space:nowrap}
.form button:hover{background:var(--ink)}
.form button:disabled{opacity:.5;cursor:default}
.msg{font-size:13px;margin-top:10px;min-height:18px}
.msg.ok{color:var(--brand);font-weight:600}
.msg.err{color:var(--insight);font-weight:600}
h2.sec{font-size:16px;font-weight:700;margin-bottom:12px;letter-spacing:-.2px}
.list{display:flex;flex-direction:column}
.iss{display:flex;align-items:center;justify-content:space-between;gap:12px;text-decoration:none;color:inherit;background:var(--surface);border:1px solid var(--line);padding:14px 16px;margin-bottom:8px;transition:border-color .15s,box-shadow .15s}
.iss:hover{border-color:var(--ink);box-shadow:0 2px 0 var(--brand)}
.iss .d{font-size:15px;font-weight:700;font-variant-numeric:tabular-nums}
.iss .dow{color:var(--muted);font-weight:600}
.iss .go{font-size:13px;color:var(--muted)}
.empty{background:var(--surface);border:1px dashed var(--line);padding:26px 20px;text-align:center;font-size:14px;color:var(--muted);line-height:1.9}
.tools{position:absolute;top:0;right:0;display:inline-flex;align-items:center;gap:5px;font-size:13px;font-weight:500;color:var(--muted);text-decoration:none;transition:color .15s}
.tools:hover{color:var(--ink)}
.tools svg{width:15px;height:15px;flex:0 0 auto}
.foot{position:relative;margin-top:32px;padding-top:16px;border-top:1px solid var(--line);display:flex;flex-direction:column;align-items:flex-start}
.upd{font:inherit;font-size:12px;color:var(--muted);background:none;border:none;padding:0;cursor:pointer;user-select:none;display:inline-flex;align-items:center;gap:6px;font-variant-numeric:tabular-nums}
.upd:hover{color:var(--ink)}
.upd .cev{font-size:10px;transition:transform .15s}
.upd.open .cev{transform:rotate(180deg)}
.log{position:absolute;left:0;bottom:calc(100% + 10px);width:340px;max-width:80vw;max-height:52vh;overflow:auto;background:var(--surface);border:1px solid var(--line);box-shadow:0 12px 28px rgba(23,34,45,.16);padding:14px 14px 8px;z-index:50;display:none;animation:logrise .14s ease-out}
.log.open{display:block}
@keyframes logrise{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
.log-h{display:flex;justify-content:space-between;align-items:center;font-size:13px;font-weight:700;color:var(--muted);margin-bottom:6px}
.log-x{font:inherit;border:none;background:none;color:var(--muted);font-size:18px;line-height:1;cursor:pointer;padding:0 2px}
.log-x:hover{color:var(--ink)}
.log ul{list-style:none;display:flex;flex-direction:column}
.log li{display:flex;gap:12px;font-size:12.5px;color:var(--muted);line-height:1.5;padding:9px 0;border-top:1px solid var(--line)}
.log li:first-child{border-top:0;padding-top:2px}
.log .ld{flex:0 0 auto;font-weight:700;color:var(--ink);font-variant-numeric:tabular-nums}
.log .lt{flex:1}
</style></head><body>
<div class="wrap">
  <header>
    <a class="tools" href="https://samsungda.net"><svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><g stroke="currentColor" stroke-width="1.8"><rect x="3.8" y="3.8" width="7" height="7" rx="1.2"/><rect x="13.2" y="3.8" width="7" height="7" rx="1.2"/><rect x="3.8" y="13.2" width="7" height="7" rx="1.2"/><rect x="13.2" y="13.2" width="7" height="7" rx="1.2"/></g></svg>도구모음</a>
    <div class="eyebrow">기획 데일리</div>
    <h1>뉴스레터 모음</h1>
    <p class="sub">지표와 뉴스에 의미를 더한 데일리 브리핑입니다. 구독하면 매일 아침 메일로 받으실 수 있습니다.</p>
  </header>

  <h2 class="sec">지난 호</h2>
  ${list}

  <section class="subscribe">
    <h2 class="sec">구독 신청</h2>
    <div class="form">
      <input id="email" type="email" inputmode="email" placeholder="name@samsung.com" autocomplete="email">
      <button id="sub" type="button">구독</button>
    </div>
    <div class="msg" id="msg" aria-live="polite"></div>
  </section>

  <footer class="foot" id="updFoot">
    <button type="button" class="upd" id="updBtn" aria-expanded="false" aria-controls="updLog">update : ${updLatest} <span class="cev">&#9662;</span></button>
    <div class="log" id="updLog" role="dialog" aria-label="업데이트 내역">
      <div class="log-h"><span>업데이트 내역</span><button type="button" class="log-x" id="updClose" aria-label="닫기">&times;</button></div>
      <ul>${updRows}</ul>
    </div>
  </footer>
</div>
<script>
(function(){
  var btn=document.getElementById("sub"),inp=document.getElementById("email"),msg=document.getElementById("msg");
  function show(t,cls){msg.textContent=t;msg.className="msg "+(cls||"");}
  function looksEmail(e){var at=e.indexOf("@");return at>0 && e.indexOf(".",at)>at+1;}
  function submit(){
    var email=(inp.value||"").trim();
    if(!looksEmail(email)){show("올바른 이메일 주소를 입력해 주세요.","err");return;}
    btn.disabled=true;show("신청 중...","");
    fetch(location.origin+"/subscribe",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({email:email})})
      .then(function(r){return r.json().catch(function(){return {};});})
      .then(function(j){
        if(j&&j.ok){show("구독 신청이 완료되었습니다.","ok");inp.value="";}
        else if(j&&j.error==="domain_not_allowed"){show("허용되지 않은 도메인입니다.","err");}
        else if(j&&j.error==="invalid_email"){show("올바른 이메일 주소를 입력해 주세요.","err");}
        else{show("신청에 실패했습니다. 잠시 후 다시 시도해 주세요.","err");}
      })
      .catch(function(){show("신청에 실패했습니다. 네트워크를 확인해 주세요.","err");})
      .finally(function(){btn.disabled=false;});
  }
  btn.addEventListener("click",submit);
  inp.addEventListener("keydown",function(e){if(e.key==="Enter")submit();});
  var ub=document.getElementById("updBtn"),lg=document.getElementById("updLog"),ft=document.getElementById("updFoot"),xb=document.getElementById("updClose");
  function updOpen(o){lg.classList.toggle("open",o);ub.classList.toggle("open",o);ub.setAttribute("aria-expanded",o?"true":"false");}
  if(ub&&lg){
    ub.addEventListener("click",function(e){e.stopPropagation();updOpen(!lg.classList.contains("open"));});
    if(xb)xb.addEventListener("click",function(){updOpen(false);ub.focus();});
    document.addEventListener("keydown",function(e){if(e.key==="Escape"&&lg.classList.contains("open")){updOpen(false);ub.focus();}});
    document.addEventListener("click",function(e){if(lg.classList.contains("open")&&ft&&!ft.contains(e.target))updOpen(false);});
  }
})();
</script>
</body></html>`;
}

// 시리즈 다운샘플: 스파크라인 URL 압축용(균등 간격 n개 추출)
function downsample(arr, n) {
  if (arr.length <= n) return arr.slice();
  const out = [], step = (arr.length - 1) / (n - 1);
  for (let i = 0; i < n; i++) out.push(arr[Math.round(i * step)]);
  return out;
}
// Yahoo 차트: 최근 6개월 일봉 → 최신·전일·1개월전(≈21거래일)·6M시점·스파크라인 시리즈
async function yahoo(sym) {
  try {
    const u = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=1d&range=6mo`;
    const r = (await (await fetch(u, UA)).json()).chart.result[0];
    const closes = (r.indicators.quote[0].close || []).filter(x => x != null);
    if (!closes.length) return null;
    return {
      price: closes[closes.length - 1],
      prevDay: closes.length >= 2 ? closes[closes.length - 2] : null,
      prevMonth: closes[Math.max(0, closes.length - 22)],
      first6m: closes[0],
      spark: downsample(closes, 26).map(v => Number(v.toPrecision(4))),
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
    return pool.sort((a, b) => (GRADE_W[b.grade] - GRADE_W[a.grade]) || (b.impact - a.impact)); // 후보 산출 위해 풀 반환(표시용 5건은 gatherData에서 slice)
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
  const sig = (data.signals && data.signals.ready) ? data.signals.breaches : [];
  const sigTxt = sig.length ? sig.map(b => `- ${b.label}: ${b.detail}`).join("\n") : "없음 (누적 데이터 축적 중이거나 임계 미돌파)";
  const ciTxt = (data.ciCand || []).length
    ? data.ciCand.map(c => `- [${c.axes.map(a => a.code).join("/")}] 「${c.headline}」`).join("\n")
    : "없음";
  return `[오늘 지표]\n- ${L.join("\n- ")}\n\n[누적 신호(주간 축적 대비)]\n${sigTxt}\n\n[LG 전략축(A1~A6) 관련 뉴스]\n${ciTxt}\n\n[가전 주요뉴스]\n${heads || "없음"}`;
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
            "- [누적 신호(주간 축적 대비)]가 제공되면 hero에서 우선 활용한다 — 오늘 스냅샷이 아니라 '무엇이 며칠에 걸쳐 방향을 틀었는지'가 인사이트의 핵심. 이 블록의 방향·해석을 넘어서는 추가 단정은 하지 않는다.",
            "- [LG 전략축 관련 뉴스]가 제공되면 hero 또는 해당 뉴스의 content/threat에서 어느 전략축(예: A2 HVAC·AIDC)에 닿는 신호인지 한 번 짚어준다. 다만 제공된 헤드라인·요약 범위 안에서만 서술하고 축 진행 상황을 창작하지 않는다.",
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

  // 추이 스트립: 6개월 일봉 시리즈 → QuickChart 라인 PNG(이메일 안전). 이미지 차단 대비 vs 6M 델타 텍스트 병기.
  const sparkUrl = (series, color) => {
    if (!series || series.length < 4) return "";
    const c = { type: "sparkline", data: { datasets: [{ data: series, borderColor: color, borderWidth: 2, pointRadius: 0, fill: false, lineTension: 0.25 }] } };
    return "https://quickchart.io/chart?bkg=transparent&w=132&h=36&c=" + encodeURIComponent(JSON.stringify(c));
  };
  const trendCell = (label, valHtml, qi) => {
    if (!qi) return `<td width="33%" style="padding:10px 8px;vertical-align:top"></td>`;
    const net = (qi.first6m != null && qi.first6m) ? (qi.price / qi.first6m - 1) * 100 : null;
    const col = net == null ? T.muted : (net >= 0 ? T.up : T.down);
    const url = sparkUrl(qi.spark, col);
    const img = url ? `<img src="${url}" width="132" height="36" alt="" style="display:block;width:100%;max-width:150px;height:36px;margin:6px 0 4px">` : `<div style="height:36px;margin:6px 0 4px"></div>`;
    const delta = net == null ? "" : `<span style="color:${col};font-weight:700">${net >= 0 ? "▲" : "▼"}${Math.abs(net).toFixed(1)}%</span>`;
    return `<td width="33%" style="padding:10px 8px;vertical-align:top">
        <div style="font-size:11px;color:${T.muted};font-weight:600">${label}</div>${img}
        <div style="font-size:15px;font-weight:800;color:${T.text};letter-spacing:-.01em">${valHtml}</div>
        <div style="font-size:11px;margin-top:2px">${delta} <span style="color:${T.muted}">6M</span></div>
      </td>`;
  };
  const trendStrip = cells => `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 4px;border-top:1px solid ${T.border}">
      <tr><td colspan="3" style="padding:9px 8px 0;font-size:10px;font-weight:800;color:${T.muted};letter-spacing:.1em">6개월 추이</td></tr>
      <tr>${cells}</tr></table>`;
  const uPct = `<span style="font-size:11px;color:${T.muted}">%</span>`;
  const uLb = `<span style="font-size:11px;color:${T.muted}">/lb</span>`;
  const consumeTrend = trendStrip([
    trendCell("美 10Y 금리", `${fmt(q["^TNX"] ? q["^TNX"].price : null)}${uPct}`, q["^TNX"]),
    trendCell("홈빌더 ITB", `$${fmt(q["ITB"] ? q["ITB"].price : null)}`, q["ITB"]),
    trendCell("소비재 XLY", `$${fmt(q["XLY"] ? q["XLY"].price : null)}`, q["XLY"]),
  ].join(""));
  const costTrend = trendStrip([
    trendCell("원/달러", fmt(q["KRW=X"] ? q["KRW=X"].price : null, 1), q["KRW=X"]),
    trendCell("WTI 유가", `$${fmt(q["CL=F"] ? q["CL=F"].price : null)}`, q["CL=F"]),
    trendCell("구리", `$${fmt(q["HG=F"] ? q["HG=F"].price : null)}${uLb}`, q["HG=F"]),
  ].join(""));

  // 누적 신호 스트립(임계 돌파분만 — 없으면 미표시)
  const sigBreaches = (data.signals && data.signals.ready) ? (data.signals.breaches || []) : [];
  const sigStrip = sigBreaches.length ? `<tr><td style="padding:16px 22px 0">
      <div style="background:${T.surface};border:1px solid ${T.border};border-left:3px solid ${T.up};padding:13px 16px">
        <div style="font-size:10px;font-weight:800;color:${T.up};letter-spacing:.12em">누적 신호 · 주간 임계 돌파</div>
        ${sigBreaches.map(b => `<div style="margin-top:7px;font-size:13px;color:${T.text};line-height:1.5"><b style="color:${b.dir >= 0 ? T.up : T.down}">${esc(b.label)}</b> <span style="color:${T.muted}">${esc(b.detail)}</span></div>`).join("")}
      </div></td></tr>` : "";

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
    ? data.news.map((i, ni) => {
        const axBadges = (i.competitors || []).includes("LG전자")
          ? matchAxes(i).slice(0, 2).map(a => `<span title="${esc(a.title)}" style="display:inline-block;font-size:10px;font-weight:700;color:${T.brand};border:1px solid ${T.brand};padding:0 5px;margin-left:5px;vertical-align:middle;line-height:1.5">${a.code}</span>`).join("")
          : "";
        return `<div style="padding:8px 0;border-bottom:1px solid ${T.border}">
        <a href="${esc(i.url)}" style="color:${T.text};text-decoration:none;font-size:14px;font-weight:600;line-height:1.4">${esc(i.headline)}</a>${axBadges}
        ${newsWhyRows(sm.newsWhy[ni])}
        <div style="margin-top:3px;font-size:12px;color:${T.muted}">${esc(i.grade)} · ${esc(i.lens)} · ${esc(i.source?.name || "")}</div></div>`;
      }).join("")
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
      <div style="margin-top:4px;font-size:12px;color:${T.muted};letter-spacing:.04em">${esc(data.date)} (${kstWeekday(data.date)}) · SAMSUNG DA 기획 도구모음</div>
      <div style="margin-top:10px;font-size:11px;color:${T.muted};letter-spacing:.05em">소비 · 원가 · 뉴스 · 아이디어 · 보고서</div>
    </td></tr>
    <tr><td style="padding:18px 22px 2px">
      <div style="background:${T.bg};border:1px solid ${T.border};border-left:3px solid ${T.brand};padding:16px 18px">
        <div style="font-size:10px;font-weight:800;color:${T.brand};letter-spacing:.12em;text-align:center">오늘의 맥락</div>
        <div style="margin-top:9px;font-size:14px;font-weight:600;color:${T.text};line-height:1.65;text-align:left">${esc(sm.hero)}</div>
      </div>
    </td></tr>
    ${sigStrip}
    ${section("소비", consumeTrend + consume, "금리·수요 전일 · 주간지표 전주 · 물가 전년 · 주택·심리 전월", true, sm.sec.consume)}
    ${section("원가", costTrend + cost, "환율·유가·운임 전일 · 원자재 전월", false, sm.sec.cost)}
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

// 구독 신청 확인 메일 본문(HTML). pub=공개 URL, unsub=수신거부 링크.
function welcomeEmail(pub, unsub) {
  const latest = pub ? `${pub}/latest` : "#";
  return `<!DOCTYPE html><html lang="ko"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/static/pretendard.min.css"></head>
<body style="margin:0;padding:0;background:${T.bg};font-family:'Pretendard','Apple SD Gothic Neo','Malgun Gothic',system-ui,-apple-system,sans-serif">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${T.bg};padding:24px 0"><tr><td align="center">
  <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:${T.surface};border:1px solid ${T.border};border-top:3px solid ${T.text};overflow:hidden">
    <tr><td style="padding:24px 22px 16px;border-bottom:2px solid ${T.text};text-align:center">
      <div style="font-size:20px;font-weight:800;color:${T.text};letter-spacing:-.01em">기획 데일리</div>
      <div style="margin-top:4px;font-size:12px;color:${T.muted};letter-spacing:.04em">SAMSUNG DA 기획 도구모음</div>
    </td></tr>
    <tr><td style="padding:28px 22px 24px">
      <div style="font-size:16px;font-weight:700;color:${T.text};line-height:1.6">구독 신청이 완료되었습니다.</div>
      <div style="margin-top:12px;font-size:14px;color:${T.muted};line-height:1.75">이제 매일 아침(월~금) 지표와 뉴스에 의미를 더한 <b style="color:${T.text}">기획 데일리</b> 브리핑을 이 메일 주소로 받아보실 수 있습니다. 다음 발행 호부터 도착합니다.</div>
      <div style="margin-top:20px"><a href="${latest}" style="display:inline-block;padding:10px 18px;background:${T.brand};color:#fff;font-size:14px;font-weight:700;text-decoration:none">최근 호 보기 →</a></div>
    </td></tr>
    <tr><td style="padding:22px;border-top:1px solid ${T.border};text-align:center">
      <div style="font-size:11px;color:${T.muted};line-height:1.7">samsungda.net · 기획 도구모음 자동 발송<br><a href="${unsub}" style="color:${T.muted};text-decoration:underline">수신거부</a></div>
    </td></tr>
  </table>
</td></tr></table>
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
// YYYY.MM.DD → 한글 요일(월~일). 발송 제목·아카이브 날짜 옆 표기용.
const WEEKDAYS_KO = ["일", "월", "화", "수", "목", "금", "토"];
function kstWeekday(dateStr) {
  const m = /^(\d{4})\.(\d{2})\.(\d{2})$/.exec(dateStr || "");
  if (!m) return "";
  return WEEKDAYS_KO[new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])).getUTCDay()];
}
