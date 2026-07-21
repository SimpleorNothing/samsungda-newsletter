// 발송 + 재대조 재발송 + 일일 리포트 — index.js run()에서 위임 호출.
// 목적:
//  (1) 수신자 목록 대비 실제 발송을 대조해 "어떤 이유로든" 발송 안 된 주소를 재발송(2-pass).
//  (2) 발송결과 요약 리포트를 매일 아침 관리자(REPORT_TOS)에게 메일 — 수신처 전체 리스트 + 전체/성공/실패.
//  (3) 동일 날짜·수신자 중복 발송은 Idempotency-Key로 방지(수동 /send 재실행 안전).
//  (4) [배달점검] Resend 이벤트 조회로 "접수"가 아닌 실제 배달 상태를 확인 — VERIFY_DELIVERY=true 일 때만 동작(기본 꺼짐).
//  (5) [백업] 리포트 JSON/HTML을 R2에 항상 보관 — 리포트 메일이 유실돼도 나중에 복구·조회 가능.
//  (6) [리포트 재시도] 리포트 메일 발송 실패 시 백오프 재시도, 최종 실패도 R2에 기록.
//  (7) [예외격리] 수신자 1명의 예외가 발송 루프 전체를 끊지 못하게 격리하고, 어떤 경우에도 리포트는 발송.
//  (8) [미발송 감지] checkSendHealth로 리포트 부재(=발송 중단)를 사후 감지해 경보.
// deps 로 index.js 의 { allRecipients, signToken, signKey, kstWeekday } 를 주입받아 순환참조를 피한다.

const REPORT_TOS = ["cw120.park@samsung.com", "cw120.park@gmail.com"];  // 발송결과 일일 리포트 수신 주소

const _enc = new TextEncoder();
async function sha256hex(s) {
  const b = await crypto.subtle.digest("SHA-256", _enc.encode(s));
  return [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, "0")).join("");
}

// Resend는 초당 2건(2 req/s) 제한 — 전 발송(뉴스레터·리포트)을 최소 간격으로 스페이싱하고,
// 429는 Retry-After를 존중해 백오프 재시도한다. 모듈 전역 _lastSendAt로 실행 내내 간격을 강제.
let _lastSendAt = 0;
async function _spaceOut(minGapMs = 600) {
  const wait = _lastSendAt + minGapMs - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  _lastSendAt = Date.now();
}

// Resend 단건 발송 — id 반환 + Idempotency-Key + 레이트리밋 스로틀/429 재시도. 실패 시 { ok:false, error }.
export async function sendResendIdem(env, { to, subject, html, idem }) {
  const headers = { "Authorization": `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" };
  if (idem) headers["Idempotency-Key"] = idem;
  const body = JSON.stringify({ from: env.FROM || "기획 도구모음 <newsletter@samsungda.net>", to: [to], subject, html });
  let lastErr = "미시도";
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      await _spaceOut();
      const res = await fetch("https://api.resend.com/emails", { method: "POST", headers, body });
      if (res.status === 429) {  // 레이트리밋 — Retry-After(초) 존중 후 재시도
        const ra = Number(res.headers.get("retry-after"));
        lastErr = "429 레이트리밋";
        await new Promise((r) => setTimeout(r, Math.max(1200, (ra || 1) * 1000)));
        continue;
      }
      const j = await res.json().catch(() => ({}));
      if (res.ok) return { ok: true, id: j.id };
      return { ok: false, error: j.message || res.status };
    } catch (e) {
      // [예외격리] fetch 자체 예외(네트워크·타임아웃)도 던지지 않고 재시도 → 최종 실패는 값으로 반환.
      // 이 예외가 밖으로 튀면 발송 루프 전체가 끊겨 나머지 수신자와 리포트까지 유실된다.
      lastErr = String((e && e.message) || e);
      await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
    }
  }
  return { ok: false, error: `발송 실패(재시도 초과): ${lastErr}` };
}

// ─────────────────────────────────────────────────────────────
// [배달점검] Resend 이벤트 조회
// Resend가 200을 준 것은 "접수"일 뿐 배달 성공이 아니다. 회사 메일 게이트웨이가
// 보류·격리하는 경우 접수는 성공인데 수신함엔 안 들어온다. 발송 후 잠시 대기했다가
// GET /emails/{id} 로 last_event를 확인해 실제 상태를 리포트에 남긴다.
// 단, 서브리퀘스트를 소모하므로 상시 실행하지 않는다(VERIFY_DELIVERY 게이트).
// ─────────────────────────────────────────────────────────────
const DELIVERY_LABEL = {
  delivered: "배달완료", bounced: "반송", complained: "스팸신고",
  delivery_delayed: "지연", sent: "접수", queued: "대기", canceled: "취소",
};

async function fetchDeliveryEvent(env, id) {
  try {
    await _spaceOut(400);
    const res = await fetch(`https://api.resend.com/emails/${id}`, {
      headers: { "Authorization": `Bearer ${env.RESEND_API_KEY}` },
    });
    if (!res.ok) return null;
    const j = await res.json().catch(() => ({}));
    return j.last_event || null;
  } catch { return null; }
}

// 발송분 전체의 배달 상태 확인. waitMs 대기 후 1회, 미확정분은 재확인 1회.
async function verifyDelivery(env, idMap, { waitMs = 20000 } = {}) {
  const out = {};
  const entries = Object.entries(idMap).filter(([, id]) => id);
  if (!entries.length) return out;
  await new Promise((r) => setTimeout(r, waitMs));
  for (const [email, id] of entries) out[email] = await fetchDeliveryEvent(env, id);
  // 아직 delivered/bounced로 확정 안 된 건만 한 번 더(게이트웨이 지연 흡수)
  const pending = entries.filter(([e]) => !["delivered", "bounced", "complained"].includes(out[e]));
  if (pending.length) {
    await new Promise((r) => setTimeout(r, 20000));
    for (const [email, id] of pending) out[email] = (await fetchDeliveryEvent(env, id)) || out[email];
  }
  return out;
}

// ─────────────────────────────────────────────────────────────
// [백업] 리포트를 R2에 보관 — 메일이 유실돼도 남는 단일 진실 소스
// ─────────────────────────────────────────────────────────────
async function persistReport(env, report, html) {
  if (!env.RESEARCH) return false;
  try {
    await env.RESEARCH.put(`reports/${report.date}.json`, JSON.stringify(report, null, 2), {
      httpMetadata: { contentType: "application/json; charset=utf-8" },
    });
    if (html) {
      await env.RESEARCH.put(`reports/${report.date}.html`, html, {
        httpMetadata: { contentType: "text/html; charset=utf-8" },
      });
    }
    return true;
  } catch { return false; }
}

// ─────────────────────────────────────────────────────────────
// [조회] R2에 백업된 리포트 읽기 — /report?d=YYYY.MM.DD 라우트용
// ─────────────────────────────────────────────────────────────
export async function getStoredReport(env, date) {
  if (!env.RESEARCH) return null;
  try {
    const obj = await env.RESEARCH.get(`reports/${date}.html`);
    if (obj) return { type: "html", body: await obj.text() };
    const j = await env.RESEARCH.get(`reports/${date}.json`);
    if (j) return { type: "json", body: await j.text() };
    return null;
  } catch { return null; }
}

// ─────────────────────────────────────────────────────────────
// [미발송 감지] 발송 몇 시간 뒤 실행하는 헬스체크.
// 오늘자 리포트가 R2에 없다 = 발송 실행이 리포트 단계에 도달조차 못했다(중단·크래시).
// 그 사실 자체를 경보 메일로 알린다. 리포트가 있으면 배달 미확인 건만 재점검해 알린다.
// ─────────────────────────────────────────────────────────────
export async function checkSendHealth(env, { date, kstWeekday }) {
  const dow = kstWeekday ? kstWeekday(date) : "";
  let stored = null;
  if (env.RESEARCH) { try { stored = await env.RESEARCH.get(`reports/${date}.json`); } catch { stored = null; } }

  if (!stored) {
    const html = `<!DOCTYPE html><html lang="ko"><body style="font-family:-apple-system,'Malgun Gothic',sans-serif;color:#222;max-width:560px;margin:0 auto;padding:16px">`
      + `<h2 style="margin:0 0 8px;font-size:18px;color:#b00">⚠️ 발송 리포트 없음 — 발송 실패 의심</h2>`
      + `<p style="margin:0 0 12px;color:#666">${date} (${dow})</p>`
      + `<p style="font-size:14px;line-height:1.6">오늘자 발송 리포트가 R2에 기록되지 않았다. 06:30 발송 실행이 <b>리포트 단계에 도달하지 못하고 중단</b>됐을 가능성이 높다(일부만 발송되거나 전혀 발송되지 않았을 수 있음).</p>`
      + `<p style="font-size:14px;line-height:1.6">확인 순서 — ① Resend 대시보드에서 오늘 06:30 발송 건수 ② Cloudflare Worker 로그의 예외 ③ 필요 시 <code>/send</code> 수동 재발송.</p>`
      + `<p style="margin:18px 0 0;color:#999;font-size:12px">samsungda-newsletter · 발송 헬스체크</p></body></html>`;
    for (const to of REPORT_TOS) {
      try { await sendResendIdem(env, { to, subject: `⚠️ 기획 데일리 발송 리포트 없음 · ${date} (${dow}) — 발송 실패 의심`, html, idem: `health-miss-${date}-${to}` }); } catch { /* 경보 실패 무시 */ }
    }
    console.warn(`[헬스체크] ${date} 리포트 없음 — 발송 중단 의심, 경보 발송`);
    return { ok: false, date, reason: "리포트 없음(발송 중단 의심)", alerted: true };
  }

  let report = null;
  try { report = JSON.parse(await stored.text()); } catch { report = null; }
  // 배달점검을 안 돌린 날은 undelivered가 비어 있으므로 자연히 경보 없음(오탐 방지).
  const pending = (report && report.undelivered) || [];
  if (pending.length) {
    const html = `<!DOCTYPE html><html lang="ko"><body style="font-family:-apple-system,'Malgun Gothic',sans-serif;color:#222;max-width:560px;margin:0 auto;padding:16px">`
      + `<h2 style="margin:0 0 8px;font-size:18px;color:#c80">배달 미확인 ${pending.length}건</h2>`
      + `<p style="margin:0 0 12px;color:#666">${date} (${dow})</p>`
      + `<p style="font-size:14px;line-height:1.6">${pending.map(e => `<code>${e}</code> — ${(report.delivery || {})[e] || "확인불가"}`).join("<br>")}</p>`
      + `<p style="font-size:14px;line-height:1.6;color:#666">Resend 접수는 성공했으나 수신 서버 도달이 확인되지 않았다. 사내 메일 게이트웨이 격리·지연 가능성.</p>`
      + `<p style="margin:18px 0 0;color:#999;font-size:12px">samsungda-newsletter · 발송 헬스체크</p></body></html>`;
    for (const to of REPORT_TOS) {
      try { await sendResendIdem(env, { to, subject: `기획 데일리 배달 미확인 ${pending.length}건 · ${date} (${dow})`, html, idem: `health-pending-${date}-${to}` }); } catch { /* 경보 실패 무시 */ }
    }
    return { ok: false, date, reason: "배달 미확인", pending, alerted: true };
  }
  return { ok: true, date, reason: "정상", alerted: false };
}

// 발송결과 일일 리포트 — 관리자(REPORT_TOS 전원)에게 요약 메일. 실패해도 발송 흐름엔 영향 없음.
async function sendDailyReport(env, report, kstWeekday) {
  if (!env.RESEND_API_KEY) return;
  const dow = kstWeekday(report.date);
  const total = report.intended;
  const success = report.sent;
  const fail = (report.stillMissing || []).length;

  // 수신처 전체 리스트(실패 먼저, 그다음 성공). 각 행에 상태 배지.
  const dv = report.delivery || {};
  const dvColor = (ev) => (ev === "delivered" ? "#0a0" : (ev === "bounced" || ev === "complained") ? "#b00" : "#c80");
  const dvText = (ev) => (ev ? (DELIVERY_LABEL[ev] || ev) : "확인불가");

  const recs = (report.recipients || []).slice().sort((a, b) => (a.ok === b.ok ? a.email.localeCompare(b.email) : (a.ok ? 1 : -1)));
  const checked = report.deliveryChecked === true;   // 배달점검을 실제로 돌렸을 때만 배달 열 표기
  const recRows = recs.map((r, i) => `<tr>`
    + `<td style="padding:5px 8px;border-top:1px solid #eee;color:#888;font-variant-numeric:tabular-nums">${i + 1}</td>`
    + `<td style="padding:5px 8px;border-top:1px solid #eee;font-family:monospace">${r.email}</td>`
    + `<td style="padding:5px 8px;border-top:1px solid #eee;font-weight:700;color:${r.ok ? '#0a0' : '#b00'}">${r.ok ? (checked ? '접수' : '성공') : '실패'}</td>`
    + (checked ? `<td style="padding:5px 8px;border-top:1px solid #eee;font-weight:700;color:${dvColor(dv[r.email])}">${dvText(dv[r.email])}</td>` : "")
    + `</tr>`).join("");
  const recTable = recRows
    ? `<p style="margin:16px 0 4px;color:#666;font-weight:600">수신처 전체 (${total}명)</p>`
      + `<table style="border-collapse:collapse;font-size:13px;width:100%">`
      + `<tr><th style="text-align:left;padding:5px 8px;color:#888">#</th><th style="text-align:left;padding:5px 8px;color:#888">주소</th><th style="text-align:left;padding:5px 8px;color:#888">${checked ? 'API' : '상태'}</th>${checked ? '<th style="text-align:left;padding:5px 8px;color:#888">배달</th>' : ''}</tr>`
      + `${recRows}</table>`
      + (checked ? `<p style="margin:6px 0 0;color:#999;font-size:12px">※ 'API 접수'는 Resend 접수 성공, '배달'은 수신 서버 도달 여부. 접수 성공이어도 배달이 '지연/반송'이면 실제로는 도착하지 않은 것.</p>` : `<p style="margin:6px 0 0;color:#999;font-size:12px">※ 배달 확인(Resend 이벤트 조회)은 꺼져 있음. 켜려면 Worker 환경변수 VERIFY_DELIVERY=true.</p>`)
    : "";

  // 배달 미확정·실패 경고 배너 — 접수는 됐는데 배달이 안 된 케이스를 한눈에
  const abortBanner = report.aborted
    ? `<div style="margin:10px 0;padding:10px 12px;background:#ffecec;border-left:3px solid #b00;font-size:13px"><b>발송 중단 감지</b> — ${String(report.aborted)}</div>`
    : "";
  const undelivered = checked ? recs.filter(r => r.ok && dv[r.email] !== "delivered") : [];
  const banner = undelivered.length
    ? `<div style="margin:10px 0;padding:10px 12px;background:#fff6e5;border-left:3px solid #e59a00;font-size:13px">`
      + `<b>배달 미확인 ${undelivered.length}건</b> — ${undelivered.map(r => `${r.email}(${dvText(dv[r.email])})`).join(", ")}`
      + `</div>`
    : "";

  const errLines = [...(report.firstErrors || []), ...(report.resendErrors || [])]
    .map(e => `<tr><td style="padding:4px 8px;border-top:1px solid #eee;font-family:monospace">${e.email}</td><td style="padding:4px 8px;border-top:1px solid #eee;color:#b00">${String(e.error)}</td></tr>`).join("");

  const html = `<!DOCTYPE html><html lang="ko"><body style="font-family:-apple-system,BlinkMacSystemFont,'Malgun Gothic',sans-serif;color:#222;max-width:560px;margin:0 auto;padding:16px">`
    + `<h2 style="margin:0 0 4px;font-size:18px">기획 데일리 발송 리포트</h2>`
    + `<p style="margin:0 0 12px;color:#666">${report.date} (${dow})</p>`
    + `<div style="font-size:15px;font-weight:700;margin:0 0 6px">`
    + `전체 ${total}명 · <span style="color:#0a0">발송 성공 ${success}명</span> · <span style="color:${fail ? '#b00' : '#0a0'}">실패 ${fail}명</span>`
    + `</div>`
    + (report.recovered ? `<p style="margin:0 0 4px;color:#666;font-size:13px">(그중 1차 실패→재발송 복구 ${report.recovered}명)</p>` : "")
    + abortBanner
    + banner
    + recTable
    + (errLines ? `<p style="margin:16px 0 4px;color:#666;font-weight:600">오류 상세</p><table style="border-collapse:collapse;font-size:13px;width:100%"><tr><th style="text-align:left;padding:4px 8px;color:#888">주소</th><th style="text-align:left;padding:4px 8px;color:#888">오류</th></tr>${errLines}</table>` : "")
    + `<p style="margin:18px 0 0;color:#999;font-size:12px">samsungda-newsletter · 자동 생성</p></body></html>`;

  const delivered = recs.filter(r => dv[r.email] === "delivered").length;
  const subject = checked
    ? `기획 데일리 발송 리포트 · ${report.date} (${dow}) — 전체 ${total}·접수 ${success}·배달 ${delivered}·실패 ${fail}`
    : `기획 데일리 발송 리포트 · ${report.date} (${dow}) — 전체 ${total}·성공 ${success}·실패 ${fail}`;

  // [백업] 메일 발송 전에 먼저 R2에 저장 — 메일이 유실돼도 기록은 남는다.
  await persistReport(env, report, html);

  // [리포트 재시도] 리포트 메일은 그동안 실패해도 조용히 사라졌다. 이제 최대 3회 백오프 재시도하고,
  // 결과를 리포트 객체에 기록해 R2에 다시 저장한다.
  const mailResults = [];
  for (const to of REPORT_TOS) {
    let last = { ok: false, error: "미시도" };
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        last = await sendResendIdem(env, { to, subject, html, idem: `report-${report.date}-a${attempt}-${to}` });
      } catch (e) { last = { ok: false, error: String(e) }; }
      if (last.ok) break;
      await new Promise((r) => setTimeout(r, 1500 * attempt));
    }
    mailResults.push({ to, ok: !!last.ok, error: last.ok ? null : String(last.error) });
  }
  report.reportMail = mailResults;
  await persistReport(env, report, html);
  return mailResults;
}

// 데일리 발송 본체(2-pass) + 리포트. index.js run()의 발송 구간을 대체.
// args: { data, base, pub, deps:{ allRecipients, signToken, signKey, kstWeekday } }
export async function runSendWithReconcile(env, { data, base, pub, deps }) {
  if (!env.RESEND_API_KEY) return { ok: false, error: "RESEND_API_KEY 미설정" };
  const to = await deps.allRecipients(env);
  if (!to.length) return { ok: false, error: "수신자 없음" };

  const subject = `📊 기획 데일리 · ${data.date} (${deps.kstWeekday(data.date)})`;
  // 개인화 발송(수신자별 수신거부 링크). phase로 idempotency-key를 분리해
  // 1차 실패분을 재발송 때 확실히 재시도하되, 동일 실행 반복 시 중복은 방지.
  const sendOne = async (email, phase = "") => {
    const token = await deps.signToken(email, deps.signKey(env));
    const link = pub ? `${pub}/unsubscribe?e=${encodeURIComponent(email)}&t=${token}` : "#";
    const html = base.split("__UNSUB__").join(link);
    const idem = `daily-${data.date}-${phase}${await sha256hex(email)}`;
    const r = await sendResendIdem(env, { to: email, subject, html, idem });
    if (r.ok && r.id) idMap[email] = r.id;   // 배달점검용 메시지 ID 보관
    return r;
  };

  // [예외격리] 수신자 1명에서 예외가 나도 나머지 발송이 계속되도록 개별 격리.
  // (기존에는 예외가 루프 밖으로 튀어 나머지 수신자 + 리포트까지 통째로 유실됐다.)
  const safeSend = async (email, phase = "") => {
    try { return await sendOne(email, phase); }
    catch (e) { return { ok: false, error: `예외: ${String((e && e.message) || e)}` }; }
  };

  const idMap = {};                          // email → Resend message id (배달점검용)
  const okSet = new Set(); const firstErrs = [];
  const resendErrs = [];
  let allTargets = [...to];
  let missedAfterFirst = [];
  let delivery = {};
  let deliveryChecked = false;               // 배달점검 실행 여부(리포트 표기 분기용)
  let aborted = null;                        // 예상 못한 중단 사유(리포트에 기록)

  try {
    // 1차 발송
    for (const email of to) {
      const r = await safeSend(email);
      if (r.ok) okSet.add(email);
      else firstErrs.push({ email, error: String(r.error) });
    }

    // 재대조 재발송 — 발송 대상을 다시 산출해, 어떤 이유로든 발송 안 된 주소를 재시도.
    let intended = to;
    try { intended = await deps.allRecipients(env); }
    catch (e) { aborted = `수신자 재조회 실패: ${String((e && e.message) || e)}`; }
    missedAfterFirst = intended.filter(e => !okSet.has(e));
    for (const email of missedAfterFirst) {
      const r = await safeSend(email, "r-");
      if (r.ok) okSet.add(email);
      else resendErrs.push({ email, error: String(r.error) });
    }
    allTargets = [...new Set([...to, ...intended])];

    // [배달점검] 기본 꺼짐 — env.VERIFY_DELIVERY === "true" 일 때만 동작.
    // 이유: Cloudflare 무료 플랜은 한 실행당 서브리퀘스트 50회 상한이 있고,
    // 뉴스레터 실행은 이미 지표·뉴스·AI 호출로 한도에 근접한다. 배달점검은
    // 수신자당 최대 2회 조회를 추가로 소모하므로 상시 켜두면 발송 자체가 끊길 위험이 있다.
    // 게이트웨이 이슈 추적이 필요한 날만 VERIFY_DELIVERY=true 로 켠다.
    if (env.VERIFY_DELIVERY === "true") {
      deliveryChecked = true;
      try { delivery = await verifyDelivery(env, idMap); }
      catch (e) { delivery = {}; console.warn(`[배달점검 실패] ${String((e && e.message) || e)}`); }
    }
  } catch (e) {
    // 예상 못한 중단 — 그래도 아래 리포트는 반드시 나간다.
    aborted = String((e && e.message) || e);
    console.warn(`[발송중단] ${data.date} — ${aborted}`);
  }

  const stillMissing = allTargets.filter(e => !okSet.has(e));
  const undelivered = deliveryChecked
    ? allTargets.filter(e => okSet.has(e) && delivery[e] !== "delivered")
    : [];   // 점검을 안 했으면 '미확인'으로 단정하지 않는다

  const report = {
    date: data.date,
    generatedAt: new Date().toISOString(),
    intended: allTargets.length,
    sent: okSet.size,
    delivered: deliveryChecked ? allTargets.filter(e => delivery[e] === "delivered").length : null,
    recovered: missedAfterFirst.filter(e => okSet.has(e)).length,
    stillMissing,
    undelivered,
    aborted,
    deliveryChecked,
    delivery,
    messageIds: idMap,
    recipients: allTargets.map(e => ({ email: e, ok: okSet.has(e) })),
    firstErrors: firstErrs.slice(0, 10),
    resendErrors: resendErrs.slice(0, 10),
  };
  if (undelivered.length) console.warn(`[배달미확인] ${data.date} — ${undelivered.map(e => `${e}:${delivery[e] || "unknown"}`).join(", ")}`);

  // [리포트 보장] 어떤 경우에도 리포트는 발송·백업한다. 리포트가 실패해도 발송 결과는 반환.
  try { await sendDailyReport(env, report, deps.kstWeekday); }
  catch (e) { console.warn(`[리포트 실패] ${String((e && e.message) || e)}`); }

  return { ok: stillMissing.length === 0 && !aborted, ...report };
}
