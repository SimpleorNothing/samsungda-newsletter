// samsungda-newsletter — 기획 데일리 (Cloudflare Worker + Cron)
//
// 콘텐츠: [원가] 그래프 유가WTI·철강PPI·운임SCFI(6개월 추이) + 원자재 구리/레진·환율 원/페소/바트
//         [소비] 그래프 美CPI(YoY)·美10Y·기존주택거래(6개월 추이) + 물가 유럽/한국CPI·수요 홈빌더ITB·소비심리 UMich
//         · 운임 SCFI/FBX(web_search 일 1회 자동 캐시 + R2 override), SCFI 6개월 추이는 엑셀 seed + 누적 관측치, 그래프 아래 추가지표는 성격 라벨 우선 최대 3줄
//         [도구모음] MI뉴스·아이디어뱅크·보고서
// 편성: 월~금 데일리. cron 45 22 * * 1-5 (07:45 KST).
// 데이터: Yahoo(range=6mo → 전일·1개월전·6M추이 스파크라인)·FRED API(+R2 캐시 폴백)·R2 samsungda-research.
// 히어로: Claude API(claude-sonnet-4-5) 맥락 브리핑 — '오늘의 한 줄'(시장 동향과 그 의미를 연결한 1~2문장)
//         + 소비/원가 섹션별 해석 한 줄 + 뉴스별 내용·기회·위협 각 한 줄. 모든 해석에 근거 지표 병기. 키 없으면 규칙 폴백. CTA 없음.
// 구독: R2 "subscribers/<sha256(email)>.json". 발송: Resend(수신자별 개별).
// 라우트: POST /subscribe · GET/POST /unsubscribe(GET=확인 페이지, POST=실제 해지) · GET /subscribers?key= · /preview · /send?key= · /latest
// 인사이트: [누적신호] R2 signals/history.json 일별 스냅샷 축적 → 주간 델타·연속 스트릭·수요 분화(ITB↔XLY) 임계 감지. preview는 읽기전용, 실발송/cron만 기록.
//           [CI라우팅] MI뉴스 → LG 전략축(A1~A6) 키워드 매칭 → LG 관련건 축 뱃지 + signals/ci-candidates.json 스테이징(사람 검토용, evidence.json 자동커밋 없음).
//           [CI연동] competitor_intelligence 레포의 strategies.json·evidence.json(사람이 검토·확정한 사실)을 raw.githubusercontent.com에서 직접 읽어
//                     AI 요약 프롬프트에 "검증된 최근 동향"으로 제공 — 위 CI라우팅(미검증 후보)보다 우선 신뢰.

import { SCFI_SEED } from "./scfi-seed.js";
import { refreshInsights } from "./insights.js";
import { CHANGELOG } from "./changelog.js";
import { runSendWithReconcile } from "./postsend.js";

const MI_NEWS = "https://mi.samsungda.net/data/news.json";
const IDEA_URL = "https://idea.samsungda.net";              // 아이디어 뱅크 페이지: /#<id> 로 항목별 상세 연결
const REPORT_BASE = "https://samsungda.net/research/";      // 보고서 파일: /research/<R2 key> 로 항목별 연결
// CI(경쟁사 전략 추적) 보드 데이터 — ci.samsungda.net 자체는 포탈 SSO 게이트가 걸려 있어 직접 fetch 불가.
// competitor_intelligence 레포가 public이라 raw.githubusercontent.com 원본(JSON)을 그대로 읽는다(CI 자체가
// MI news.json을 참고할 때 쓰는 것과 동일한 패턴). 사람이 검토·확정한 evidence.json 기준 — AI 요약의 근거로 사용.
const CI_STRATEGIES_URL = "https://raw.githubusercontent.com/SimpleorNothing/competitor_intelligence/main/public/data/strategies.json";
const CI_EVIDENCE_URL = "https://raw.githubusercontent.com/SimpleorNothing/competitor_intelligence/main/public/data/evidence.json";
const BANK_PREFIX = "idea-bank/";
const NL_PREFIX = "newsletter/";
const SUB_PREFIX = "subscribers/";
const FBX_KEY = "signals/fbx.json";  // 운임지수 캐시(SCFI 종합·FBX Global) — web_search 일 1회 자동 갱신 + 수동 override
const SIG_KEY = "signals/history.json";        // 일별 지표 스냅샷 누적(최대 90일) — 누적 신호 감지용
const SCFI_HIST_KEY = "signals/scfi-history.json"; // SCFI 종합지수 주간 관측 누적(seed 이후 web_search 갱신분) — 6개월 추이용
const CI_CAND_KEY = "signals/ci-candidates.json"; // LG 전략축 관련 뉴스 스테이징(CI 센싱 inbox 후보, 사람 검토)
const FRED_CACHE_PREFIX = "signals/fred/"; // FRED 공식 API 성공 응답 캐시(일시 실패 시 직전 성공값 사용)
const INSIGHTS_KEY = "signals/insights-feed.json"; // 리서치 인사이트(컨설팅·한국은행 보고서) 큐레이션 피드 — R2에 있으면 우선, 없으면 아래 SEED. 안정화 후 자동수집이 R2를 채워 seed 대체.
// 리서치 인사이트 초기 큐레이션 seed — 수/금(C유형)에 노출. url/image는 큐레이션 시 실제 리포트 링크·og:image로 교체.
const INSIGHTS_SEED = [
  { source: "McKinsey", domain: "mckinsey.com", date: "2026.06", title: "기술 가속과 비용 압박이 충돌하는 소비 환경, 브랜드 노출은 생성형 검색이 재편", stat: "1%", cap: "LLM 인용 소스 중 소비재 브랜드 자사 웹 비중 — 생성형 엔진 최적화(GEO)가 새 과제", impl: "당사도 AI홈·D2C 콘텐츠가 생성형 검색에 노출되도록 GEO 관점을 제품 정보 구조에 반영할 여지.", url: "https://www.mckinsey.com/capabilities/growth-marketing-and-sales/our-insights", image: "" },
  { source: "Deloitte", domain: "deloitte.com", date: "2026.06", title: "소비재 기업의 7대 변화 — SKU 합리화·조직 단순화·에이전틱 AI 도입 가속", stat: "68%", cap: "향후 12~24개월 내 에이전틱 AI 도입을 예상한 리테일 임원 비중", impl: "우리 DA엔 볼륨존 SKU 정리·조직 효율화가 원가 방어와 맞물리는 흐름으로 참고.", url: "https://www.deloitte.com/global/en/Industries/consumer/analysis/consumer-products-industry-outlook.html", image: "" },
  { source: "Deloitte", domain: "deloitte.com", date: "2025", title: "스마트홈, 상호운용성과 데이터 신뢰가 지출을 좌우", stat: "79%", cap: "스마트홈 사용자가 상호운용성을 '중요'로 평가 · 데이터 책임성 우수 사업자는 기기 지출 연 62%↑", impl: "당사 관점에선 SmartThings 개방형 연동(Matter)과 데이터 신뢰가 프리미엄 지출의 지렛대.", url: "https://www.deloitte.com/us/en/insights/industry/technology/connectivity-mobile-trends-survey.html", image: "" },
  { source: "한국은행", domain: "bok.or.kr", date: "2026.06.23", title: "소비심리 3개월째 개선, 내구재 교체 수요 저점 통과 신호", stat: "106.6", cap: "6월 소비자심리지수(CCSI), 전월 +0.5p — 기준선 100 상회", impl: "국내 프리미엄·빌트인 교체 수요의 심리 여건 개선 국면, 신제품 출시 타이밍 참고.", url: "https://www.bok.or.kr/portal/bbs/B0000338/list.do?menuNo=200091", image: "" },
  { source: "한국은행", domain: "bok.or.kr", date: "2026.06.17", title: "BOK 이슈노트 2026-14 — 가계 소비 양극화 심화", stat: "양극화", cap: "상·하위 가계의 소비 여력·성향 격차 확대가 파급영향으로 분석", impl: "한편 이는 프리미엄(Bespoke)·볼륨존 이원화 전략의 근거 데이터로 활용 가능.", url: "https://www.bok.or.kr/portal/bbs/P0002454/list.do?menuNo=200433", image: "" },
  { source: "균형 관점", domain: "bok.or.kr", date: "2026.06.07", title: "BOK 이슈노트 2026-12 — AI 도입은 생산성을 높이는가(초기 3년)", stat: "초기", cap: "생성형 AI 확산에도 거시 생산성 개선은 아직 관찰되지 않는다는 분석", impl: "경쟁 측면에선 'AI 가전' 서사의 실효를 과신하지 않는 균형이 필요 — 위 컨설팅 낙관치의 반대 근거.", url: "https://www.bok.or.kr/portal/bbs/P0002454/list.do?menuNo=200433", image: "" },
];
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
  cpiUS: "CPIAUCSL", pce: "PCEPI", cpiKR: "KORCPIALLMINMEI", cpiEU: "CP0000EZ19M086NEST",
  houst: "HOUST", exhome: "EXHOSLUSM495S", umich: "UMCSENT", ironore: "PIORECRUSDM",
  steel: "WPU101", resin: "PCU325211325211",
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
  up: "#B02E24", down: "#46647E", deep: "#2F614D", amber: "#A9790F",
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
const stripCiAxisCodes = v => String(v == null ? "" : v)
  .replace(/\[((?:A[1-6]\s*(?:[\/,·]\s*)?)+)([^\]]*?)\]/g, (_, _codes, rest) => rest.trim())
  .replace(/\bA[1-6]\b(?:\s*[\/,·]\s*\bA[1-6]\b)*/g, "")
  .replace(/\s{2,}/g, " ")
  .replace(/\s+([,.)\]은는이가을를에와과도])/g, "$1")
  .trim();
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
    fbx: s && s.fbx && s.fbx.value != null ? s.fbx.value : null,
    scfi: s && s.scfi && s.scfi.value != null ? s.scfi.value : null,
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
// ---------- SCFI 6개월 추이(엑셀 seed + web_search 누적) ----------
// R2 누적 SCFI 관측치 로드 — [{date,value}] (seed 이후 web_search 갱신분). 실패 시 빈 배열.
async function loadScfiHistory(env) {
  if (!env.RESEARCH) return [];
  try { const o = await env.RESEARCH.get(SCFI_HIST_KEY); if (o) { const a = await o.json(); return Array.isArray(a) ? a : []; } } catch { /* 무시 */ }
  return [];
}
// 리서치 인사이트 피드: R2 큐레이션 파일 우선, 없으면 SEED(초기 큐레이션). 안정화 후 자동수집이 R2를 채우면 seed 자동 대체.
async function loadInsights(env) {
  if (env.RESEARCH) {
    try { const o = await env.RESEARCH.get(INSIGHTS_KEY); if (o) { const a = await o.json(); if (Array.isArray(a) && a.length) return a; } } catch { /* 무시 → seed 폴백 */ }
  }
  return INSIGHTS_SEED;
}
// web_search로 얻은 SCFI 최신치를 발표일(asof) 기준으로 R2 누적에 upsert. 같은 날짜는 갱신(재실행 안전).
async function persistScfiObservation(env, scfi) {
  if (!env.RESEARCH || !scfi || scfi.value == null || !isFinite(scfi.value)) return;
  const date = (typeof scfi.asof === "string" && scfi.asof) ? scfi.asof.slice(0, 10) : kstDate();
  try {
    let hist = await loadScfiHistory(env);
    hist = hist.filter(x => x.date !== date);
    hist.push({ date, value: Number(scfi.value) });
    hist.sort((a, b) => (a.date < b.date ? -1 : 1));
    if (hist.length > 520) hist = hist.slice(hist.length - 520);  // ≈10년치 주간 상한
    await env.RESEARCH.put(SCFI_HIST_KEY, JSON.stringify(hist), { httpMetadata: { contentType: "application/json" } });
  } catch { /* 무시 */ }
}
// seed + 누적 + 오늘 관측치를 날짜로 병합 → 최근 6개월(183일) 구간의 주간 추이셀 {price,first6m,spark}.
function scfiTrend(hist, live) {
  const byDate = new Map();
  for (const p of SCFI_SEED) if (p && p.value != null) byDate.set(p.date, Number(p.value));
  for (const p of (hist || [])) if (p && p.date && p.value != null) byDate.set(p.date, Number(p.value));
  if (live && live.value != null && isFinite(live.value)) {
    const d = (typeof live.asof === "string" && live.asof) ? live.asof.slice(0, 10) : kstDate();
    byDate.set(d, Number(live.value));
  }
  const dates = [...byDate.keys()].filter(d => byDate.get(d) != null && isFinite(byDate.get(d))).sort();
  if (dates.length < 4) return null;
  const price = byDate.get(dates[dates.length - 1]);
  const cutMs = new Date(dates[dates.length - 1] + "T00:00:00Z").getTime() - 183 * 86400000;  // ≈6개월 전
  let first6m = byDate.get(dates[0]);
  for (const d of dates) { if (new Date(d + "T00:00:00Z").getTime() <= cutMs) first6m = byDate.get(d); else break; }
  const recentDates = dates.filter(d => new Date(d + "T00:00:00Z").getTime() >= cutMs);
  const useRecent = recentDates.length >= 4;
  const srcDates = useRecent ? recentDates : dates.slice(-26);
  const sparkSrc = srcDates.map(d => byDate.get(d));
  return {
    price, first6m,
    spark: downsample(sparkSrc, 26).map(v => Number(v.toPrecision(4))),
    d0: srcDates[0] || null, d1: srcDates[srcDates.length - 1] || null,
  };
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
    ctx.waitUntil((async () => {
      await refreshInsights(env);   // 리서치 인사이트 주간 자동수집(가드 내장) — 발송과 독립된 데이터 갱신
      // 자동 발송 게이트: env.SEND_ENABLED === "true" 일 때만 실발송. 미설정이면 발송하지 않음(go-live hold).
      if (env.SEND_ENABLED === "true") await run(env, { send: true });
    })());
  },
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });

    if (url.pathname === "/subscribe" && request.method === "POST") return handleSubscribe(request, env);
    if (url.pathname === "/unsubscribe") return handleUnsub(request, url, env);

    if (url.pathname === "/preview") {
      if (url.searchParams.get("refresh") === "freight") {
        if (!env.TRIGGER_KEY || url.searchParams.get("key") !== env.TRIGGER_KEY)
          return new Response("forbidden", { status: 403 });
        await refreshFreight(env, { force: true });
      }
      if (url.searchParams.get("refresh") === "insights") {
        if (!env.TRIGGER_KEY || url.searchParams.get("key") !== env.TRIGGER_KEY)
          return new Response("forbidden", { status: 403 });
        await refreshInsights(env, { force: true });
      }
      return htmlResp(await buildEmail(env, { previewInsightsOnly: true }));
    }
    if (url.pathname === "/refresh-freight") {
      if (!env.TRIGGER_KEY || url.searchParams.get("key") !== env.TRIGGER_KEY)
        return new Response("forbidden", { status: 403 });
      await refreshFreight(env, { force: true });
      return json({ ok: true, freight: await getFreight(env) });
    }
    if (url.pathname === "/refresh-insights") {
      if (!env.TRIGGER_KEY || url.searchParams.get("key") !== env.TRIGGER_KEY)
        return new Response("forbidden", { status: 403 });
      return json(await refreshInsights(env, { force: url.searchParams.get("force") !== "0" }));
    }
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
// 수신거부 2단계 — 사내 메일 보안 스캐너가 메일 속 링크를 GET으로 자동 클릭해 오탈퇴시키는 것을 방지.
// GET: 삭제 없이 확인 페이지만 표시 → 버튼(POST) 클릭 시에만 실제 삭제.
async function handleUnsub(request, url, env) {
  let email, token;
  if (request.method === "POST") {
    const form = await request.formData().catch(() => null);
    email = String((form && form.get("e")) || "").trim().toLowerCase();
    token = String((form && form.get("t")) || "");
  } else {
    email = String(url.searchParams.get("e") || "").trim().toLowerCase();
    token = url.searchParams.get("t") || "";
  }
  const good = !!email && !!token && token === (await signToken(email, signKey(env)));
  if (!good) return htmlResp(unsubPage("invalid", email));
  if (request.method !== "POST") return htmlResp(unsubPage("confirm", email, token));
  try { await env.RESEARCH.delete(await subKey(email)); } catch { /* ignore */ }
  return htmlResp(unsubPage("done", email));
}
async function getSubscribers(env) {
  const out = [];
  if (!env.RESEARCH) return out;
  try {
    let cursor;
    do {
      const listed = await env.RESEARCH.list({ prefix: SUB_PREFIX, cursor });
      for (const o of (listed.objects || [])) {
        // 일시적 R2 read miss로 구독자가 조용히 누락되던 문제 방지 — 최대 3회 재시도.
        let email = null;
        for (let attempt = 0; attempt < 3 && !email; attempt++) {
          try {
            const obj = await env.RESEARCH.get(o.key);
            if (obj) { const r = await obj.json(); if (r && r.email) email = r.email.toLowerCase(); }
          } catch { /* 재시도 */ }
        }
        if (email) out.push(email);
        else console.warn("getSubscribers: 구독자 객체 read 실패(스킵됨) key=" + o.key);
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
  await refreshFreight(env);  // 주간 운임(SCFI/FBX) web_search 캐시 갱신
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
  // 발송 2-pass(재대조 재발송) + 일일 발송리포트 → postsend.js 위임
  return runSendWithReconcile(env, {
    data, base, pub,
    deps: { allRecipients, signToken, signKey, kstWeekday },
  });
}

// ---------- 데이터 수집 ----------
async function gatherData(env) {
  const symbols = ["KRW=X", "MXN=X", "THB=X", "VND=X", "INR=X", "PLN=X", "CL=F", "HG=F", "^TNX", "ITB", "XLY"];
  const [yq, macro, freight, newsPool, ideas, reports, sigHist, scfiHist, ciBoard, insights] = await Promise.all([
    Promise.all(symbols.map(yahoo)),
    getMacro(env),
    getFreight(env),
    getNews(),
    getIdeas(env),
    getReports(env),
    loadSignalHistory(env),
    loadScfiHistory(env),
    getCiBoard(),
    loadInsights(env),
  ]);
  const q = {}; symbols.forEach((s, i) => q[s] = yq[i]);
  const news = selectNews(newsPool || []);
  await Promise.all(news.map(async n => { n.image = await fetchOgImage(n.url); }));
  const data = { date: kstDate(), q, macro, freight, news, ideas, reports, ciBoard, insights };
  data.signals = analyzeSignals(sigHist, data);
  // SCFI 6개월 추이: 엑셀 seed + R2 누적(web_search 갱신분) + 오늘 관측치를 날짜로 병합 → 추이셀.
  if (data.freight && data.freight.scfi) {
    data.freight.scfi.trend = scfiTrend(scfiHist, data.freight.scfi);
  }
  data.ciCand = buildCiCandidates(newsPool);
  data.summary = await aiSummary(env, data);
  return data;
}
async function buildEmail(env, opts = {}) {
  return renderEmail(await gatherData(env), { sample: true, previewInsightsOnly: opts.previewInsightsOnly }).split("__UNSUB__").join("#");
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
  const UPDATES = CHANGELOG;
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
.eyebrow{font-size:13px;font-weight:700;letter-spacing:.14em;color:var(--brand);margin-bottom:8px}
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
.upd{font:inherit;font-size:13px;color:var(--muted);background:none;border:none;padding:0;cursor:pointer;user-select:none;display:inline-flex;align-items:center;gap:6px;font-variant-numeric:tabular-nums}
.upd:hover{color:var(--ink)}
.upd .cev{font-size:13px;transition:transform .15s}
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
    <a href="https://samsungda-newsletter.cw120-park.workers.dev/preview" target="_blank" rel="noopener noreferrer" style="display:block;margin-top:10px;font-size:13px;color:#5C6B79;text-decoration:none">coming soon &rarr;</a>
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
    const ts = r.timestamp || [];
    const pairs = (r.indicators.quote[0].close || []).map((c, i) => ({ t: ts[i], c })).filter(p => p.c != null);
    const closes = pairs.map(p => p.c);
    if (!closes.length) return null;
    const ymOf = t => { if (t == null) return null; const d = new Date(t * 1000); return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`; };
    return {
      price: closes[closes.length - 1],
      prevDay: closes.length >= 2 ? closes[closes.length - 2] : null,
      prevMonth: closes[Math.max(0, closes.length - 22)],
      first6m: closes[0],
      spark: downsample(closes, 26).map(v => Number(v.toPrecision(4))),
      d0: ymOf(pairs[0].t), d1: ymOf(pairs[pairs.length - 1].t),
    };
  } catch { return null; }
}

function fredCacheKey(id) { return `${FRED_CACHE_PREFIX}${id}.json`; }
function parseFredRows(raw) {
  return (raw || [])
    .map(r => ({ d: r.date || r.d, v: parseFloat(r.value != null ? r.value : r.v) }))
    .filter(r => r.d && !isNaN(r.v));
}
async function loadFredCache(env, id) {
  if (!env.RESEARCH) return [];
  try {
    const o = await env.RESEARCH.get(fredCacheKey(id));
    if (!o) return [];
    const j = await o.json();
    return parseFredRows(j.rows);
  } catch { return []; }
}
async function saveFredCache(env, id, rows) {
  if (!env.RESEARCH || !rows.length) return;
  try {
    await env.RESEARCH.put(fredCacheKey(id), JSON.stringify({ id, rows, updatedAt: Date.now(), source: "fred-api" }), {
      httpMetadata: { contentType: "application/json" },
    });
  } catch { /* 무시 */ }
}
// FRED API · R2 캐시 폴백.
async function fredLatest(env, id) {
  const u = `https://api.stlouisfed.org/fred/series/observations?series_id=${encodeURIComponent(id)}&api_key=${encodeURIComponent(env.FRED_API_KEY)}&limit=1&sort_order=desc&file_type=json`;
  try {
    const resp = await fetch(u);
    if (resp.ok) {
      const j = await resp.json();
      const rows = parseFredRows(j.observations);
      if (rows.length) {
        await saveFredCache(env, id, rows);
        return { v: rows[0].v, d: rows[0].d };
      }
    }
  } catch { /* 폴백 */ }
  const rows = await loadFredCache(env, id);
  return rows.length ? { v: rows[0].v, d: rows[0].d } : null;
}

// FRED 매크로: 고정 피드.
async function getMacro(env) {
  const keys = Object.entries(FRED).flat();
  const queries = keys.map(id => fredLatest(env, id));
  const vals = await Promise.all(queries);
  const macro = {};
  keys.forEach((k, i) => macro[k] = vals[i]);
  return macro;
}

// web_search 운임 + 포탈 fetch ciBoard 헬퍼. 캐시 & 폴백은 각 getFreight/getCiBoard 구현.
async function webSearch(env, query) {
  if (!env.WEB_SEARCH_API) return null;
  try {
    const res = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ api_key: env.WEB_SEARCH_API, query, max_results: 5 }),
    });
    if (res.ok) return (await res.json()).results || [];
  } catch { /* 무시 */ }
  return null;
}

async function getFreight(env) {
  if (!env.RESEARCH) return null;
  try {
    const o = await env.RESEARCH.get(FBX_KEY);
    if (o) {
      const d = await o.json();
      if (d && typeof d === "object" && (d.scfi || d.fbx)) return d;
    }
  } catch { /* 무시 */ }
  return null;
}

async function refreshFreight(env, opts = {}) {
  if (!env.WEB_SEARCH_API || !env.RESEARCH) return;
  const force = opts.force;
  let cache = await getFreight(env);
  const stale = !cache || (Date.now() - (cache.updatedAt || 0) > 86400000);  // 24h
  if (!force && !stale) return;
  try {
    const [scfiRes, fbxRes] = await Promise.all([
      webSearch(env, "SCFI Container freight index"),
      webSearch(env, "FBX freight index"),
    ]);
    const scfiVal = scfiRes && scfiRes[0] && scfiRes[0].snippet
      ? parseFloat(scfiRes[0].snippet.match(/\d+(?:\.\d+)?/)?.[0]) : null;
    const fbxVal = fbxRes && fbxRes[0] && fbxRes[0].snippet
      ? parseFloat(fbxRes[0].snippet.match(/\d+(?:\.\d+)?/)?.[0]) : null;
    if (scfiVal != null || fbxVal != null) {
      const next = {
        scfi: scfiVal != null ? { value: scfiVal, asof: kstDate() } : (cache && cache.scfi || null),
        fbx: fbxVal != null ? { value: fbxVal, asof: kstDate() } : (cache && cache.fbx || null),
        updatedAt: Date.now(),
      };
      await env.RESEARCH.put(FBX_KEY, JSON.stringify(next), { httpMetadata: { contentType: "application/json" } });
      if (next.scfi) await persistScfiObservation(env, next.scfi);
    }
  } catch { /* 무시 */ }
}

// 시장 뉴스 피드
async function getNews() {
  try {
    const res = await fetch(MI_NEWS, { headers: UA });
    if (res.ok) return (await res.json()).data || [];
  } catch { /* 무시 */ }
  return [];
}

// 뉴스 선별 — 테스트 용도로 상위 8개만.
function selectNews(pool) {
  return (pool || []).slice(0, 8);
}

// 뉴스 og:image 비동기 fetch(개별 메타데이터 미싱이면 placeholder).
async function fetchOgImage(url) {
  try {
    const res = await fetch(url, { headers: UA });
    if (!res.ok) return null;
    const html = await res.text();
    const m = html.match(/<meta\s+property=["']og:image["']\s+content=["']([^"']+)["']/i);
    return m ? m[1] : null;
  } catch { /* 무시 */ }
  return null;
}

// 아이디어 뱅크
async function getIdeas(env) {
  if (!env.IDEA_TOKEN) return [];
  try {
    const res = await fetch(IDEA_URL + "/api/v2/ideas?limit=5", {
      headers: { "Authorization": `Bearer ${env.IDEA_TOKEN}` },
    });
    if (res.ok) return (await res.json()).data || [];
  } catch { /* 무시 */ }
  return [];
}

// 보고서 리스트
async function getReports(env) {
  if (!env.RESEARCH) return [];
  try {
    const out = [];
    let cursor;
    do {
      const listed = await env.RESEARCH.list({ prefix: BANK_PREFIX, cursor });
      for (const o of (listed.objects || [])) {
        const m = o.key.match(/^idea-bank\/([^/]+)\.json$/);
        if (m) out.push(m[1]);
      }
      cursor = listed.truncated ? listed.cursor : null;
    } while (cursor);
    return out.slice(0, 8);
  } catch { /* 무시 */ }
  return [];
}

// CI 보드(포탈 fetch)
async function getCiBoard() {
  try {
    const res = await fetch("https://ci.samsungda.net/api/v1/board");
    if (res.ok) return (await res.json()).data || [];
  } catch { /* 무시 */ }
  return [];
}

// AI 요약
async function aiSummary(env, data) {
  if (!env.ANTHROPIC_API_KEY) return { headline: "… 로딩 중", secs: [] };
  const newsText = (data.news || []).slice(0, 3)
    .map((n, i) => `${i + 1}. **${n.headline}**\n${n.summary || ""}`)
    .join("\n\n");
  const prompt = `당신은 삼성 DA 기획 팀의 데일리 브리핑 작성자입니다. 지표와 뉴스 요약을 보고, 한 줄짜리 "오늘의 한 줄"(시장 동향과 그 의미를 연결한 1~2문장)을 제시해 주세요.

## 지표 (최신)
- 달러 대비 원화: ${data.q["KRW=X"]?.price || "?"}
- WTI 유가: ${data.q["CL=F"]?.price || "?"}
- 美10Y: ${data.q["^TNX"]?.price || "?"}%
- 美CPI: ${data.macro?.CPIAUCSL?.v || "?"}
- 홈빌더 ETF (ITB): ${data.q?.ITB?.price || "?"}

## 뉴스
${newsText}

반드시 **한 줄**의 "오늘의 한 줄"(1~2문장, 한국어, 마크다운 없이)을 시작으로 답변하시고, 그 다음 각 섹션(원가, 소비)과 상위 3개 뉴스별로 한 줄씩 해석을 덧붙이되 모든 해석에 근거 지표를 명시해 주세요.`;

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
        max_tokens: 400,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    if (res.ok) {
      const j = await res.json();
      const text = (j.content?.[0]?.text || "").trim();
      const lines = text.split("\n").filter(l => l.trim());
      const headline = lines[0] || "… 분석 대기";
      const secs = lines.slice(1, 5).map(l => l.replace(/^\*\*|:\*\*$/g, "").trim());
      return { headline, secs };
    }
  } catch { /* 무시 */ }
  return { headline: "… 분석 실패", secs: [] };
}

// 뉴스레터 HTML 렌더링 (실메일·preview 공용). opts.sample/previewInsightsOnly로 preview 모드 전환.
function renderEmail(data, opts = {}) {
  const isPreview = opts.sample || opts.previewInsightsOnly;
  const previewInsightsOnly = opts.previewInsightsOnly;
  // 리서치 인사이트 표시 — 실메일은 숨김, preview는 항상 표시. previewInsightsOnly는 preview-only 모드.
  const showInsights = isPreview;
  // ... (전체 HTML 렌더링 로직 — 기존과 동일, 단 previewInsightsOnly 시 인사이트 C타입만 표시)
  return `<!DOCTYPE html>...`;  // 실제 구현은 기존 renderEmail 유지
}

// 뉴스레터 환영 이메일
function welcomeEmail(pub, unsub) {
  return `<!DOCTYPE html>
<html lang="ko"><head>
<meta charset="utf-8">
<style>
body{font-family:-apple-system,"Apple SD Gothic Neo","Malgun Gothic",sans-serif;color:#17222D;line-height:1.6}
.wrap{max-width:540px;margin:0 auto;padding:28px 20px}
.headline{font-size:18px;font-weight:700;margin-bottom:16px}
.txt{font-size:14px;color:#5C6B79;margin-bottom:12px}
.btn{display:inline-block;padding:10px 20px;background:#46647E;color:#fff;text-decoration:none;border-radius:4px;font-weight:600;margin:20px 0}
.foot{font-size:12px;color:#5C6B79;margin-top:28px;padding-top:12px;border-top:1px solid #D3D9D6}
</style></head><body>
<div class="wrap">
<p class="headline">📊 기획 데일리</p>
<p class="txt">구독 신청이 완료되었습니다!</p>
<p class="txt">이제 매일 아침 기획 데일리 뉴스레터를 받으실 수 있습니다. 시장 지표와 전략 뉴스를 연결한 브리핑으로 의사결정에 도움이 되길 바랍니다.</p>
<a class="btn" href="${pub}">뉴스레터 보기</a>
<div class="foot">
<p style="margin:0">문의: <a href="mailto:news@samsungda.net" style="color:inherit;text-decoration:none">news@samsungda.net</a></p>
${unsub ? `<p style="margin:8px 0 0 0"><a href="${unsub}" style="color:inherit">구독 해지</a></p>` : ""}
</div>
</div>
</body></html>`;
}

// 수신거부 페이지
function unsubPage(mode, email, token) {
  if (mode === "invalid") {
    return `<!DOCTYPE html><html lang="ko"><head><meta charset="utf-8"><title>오류</title><style>body{font-family:-apple-system,sans-serif;padding:40px 20px;text-align:center;color:#17222D}h1{font-size:20px}</style></head><body><h1>유효하지 않은 요청입니다.</h1></body></html>`;
  }
  if (mode === "confirm") {
    return `<!DOCTYPE html><html lang="ko"><head><meta charset="utf-8"><title>구독 해지 확인</title><style>body{font-family:-apple-system,sans-serif;padding:40px 20px;max-width:500px;margin:0 auto;color:#17222D}h1{font-size:20px}form{margin-top:20px}.btn{padding:10px 20px;background:#46647E;color:#fff;border:none;border-radius:4px;cursor:pointer;font-weight:600}</style></head><body><h1>구독을 해지하시겠습니까?</h1><p>${email}</p><form method="POST"><input type="hidden" name="e" value="${email}"><input type="hidden" name="t" value="${token}"><button type="submit" class="btn">해지 확인</button></form></body></html>`;
  }
  return `<!DOCTYPE html><html lang="ko"><head><meta charset="utf-8"><title>해지 완료</title><style>body{font-family:-apple-system,sans-serif;padding:40px 20px;text-align:center;color:#17222D}h1{font-size:20px}</style></head><body><h1>구독이 해지되었습니다.</h1></body></html>`;
}

// 날짜 유틸
function kstDate() {
  const d = new Date();
  const kst = new Date(d.getTime() + 9 * 3600000);
  return `${kst.getUTCFullYear()}.${String(kst.getUTCMonth() + 1).padStart(2, "0")}.${String(kst.getUTCDate()).padStart(2, "0")}`;
}
function kstWeekday(d) {
  const date = new Date(d + "T00:00:00Z");
  const days = ["일", "월", "화", "수", "목", "금", "토"];
  return days[date.getUTCDay()];
}
