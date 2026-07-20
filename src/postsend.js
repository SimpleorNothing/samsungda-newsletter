// 발송 + 재대조 재발송 + 일일 리포트 — index.js run()에서 위임 호출.
// 목적:
//  (1) 수신자 목록 대비 실제 발송을 대조해 "어떤 이유로든" 발송 안 된 주소를 재발송(2-pass).
//  (2) 발송결과 요약 리포트를 매일 아침 관리자(REPORT_TOS)에게 메일 — 수신처 전체 리스트 + 전체/성공/실패.
//  (3) 동일 날짜·수신자 중복 발송은 Idempotency-Key로 방지(수동 /send 재실행 안전).
//  (4) [배달점검] Resend 이벤트 조회로 "접수"가 아닌 실제 배달(delivered/bounced/delayed) 상태를 확인해 리포트에 표기.
//  (5) [백업] 리포트 JSON/HTML을 R2에 항상 보관 — 리포트 메일이 유실돼도 나중에 복구·조회 가능.
//  (6) [리포트 재시도] 리포트 메일 발송 실패 시 백오프 재시도, 최종 실패도 R2에 기록.
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
  for (let attempt = 0; attempt < 4; attempt++) {
    await _spaceOut();
    const res = await fetch("https://api.resend.com/emails", { method: "POST", headers, body });
    if (res.status === 429) {  // 레이트리밋 — Retry-After(초) 존중 후 재시도
      const ra = Number(res.headers.get("retry-after"));
      await new Promise((r) => setTimeout(r, Math.max(1200, (ra || 1) * 1000)));
      continue;
    }
    const j = await res.json().catch(() => ({}));
    if (res.ok) return { ok: true, id: j.id };
    return { ok: false, error: j.message || res.status };
  }
  return { ok: false, error: "레이트리밋 재시도 초과(429)" };
}

// ─────────────────────────────────────────────────────────────
// [배달점검] Resend 이벤트 조회
// Resend가 200을 준 것은 "접수"일 뿐 배달 성공이 아니다. 회사 메일 게이트웨이가
// 보류·격리하는 경우 접수는 성공인데 수신함엔 안 들어온다. 발송 후 잠시 대기했다가
// GET /emails/{id} 로 last_event를 확인해 실제 상태를 리포트에 남긴다.
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
  const recRows = recs.map((r, i) => `<tr>`
    + `<td style="padding:5px 8px;border-top:1px solid #eee;color:#888;font-variant-numeric:tabular-nums">${i + 1}</td>`
    + `<td style="padding:5px 8px;border-top:1px solid #eee;font-family:monospace">${r.email}</td>`
    + `<td style="padding:5px 8px;border-top:1px solid #eee;font-weight:700;color:${r.ok ? '#0a0' : '#b00'}">${r.ok ? '접수' : '실패'}</td>`
    + `<td style="padding:5px 8px;border-top:1px solid #eee;font-weight:700;color:${dvColor(dv[r.email])}">${dvText(dv[r.email])}</td>`
    + `</tr>`).join("");
  const recTable = recRows
    ? `<p style="margin:16px 0 4px;color:#666;font-weight:600">수신처 전체 (${total}명)</p>`
      + `<table style="border-collapse:collapse;font-size:13px;width:100%">`
      + `<tr><th style="text-align:left;padding:5px 8px;color:#888">#</th><th style="text-align:left;padding:5px 8px;color:#888">주소</th><th style="text-align:left;padding:5px 8px;color:#888">API</th><th style="text-align:left;padding:5px 8px;color:#888">배달</th></tr>`
      + `${recRows}</table>`
      + `<p style="margin:6px 0 0;color:#999;font-size:12px">※ 'API 접수'는 Resend 접수 성공, '배달'은 수신 서버 도달 여부. 접수 성공이어도 배달이 '지연/반송'이면 실제로는 도착하지 않은 것.</p>`
    : "";

  // 배달 미확정·실패 경고 배너 — 접수는 됐는데 배달이 안 된 케이스를 한눈에
  const undelivered = recs.filter(r => r.ok && dv[r.email] !== "delivered");
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
    + banner
    + recTable
    + (errLines ? `<p style="margin:16px 0 4px;color:#666;font-weight:600">오류 상세</p><table style="border-collapse:collapse;font-size:13px;width:100%"><tr><th style="text-align:left;padding:4px 8px;color:#888">주소</th><th style="text-align:left;padding:4px 8px;color:#888">오류</th></tr>${errLines}</table>` : "")
    + `<p style="margin:18px 0 0;color:#999;font-size:12px">samsungda-newsletter · 자동 생성</p></body></html>`;

  const delivered = recs.filter(r => dv[r.email] === "delivered").length;
  const subject = `기획 데일리 발송 리포트 · ${report.date} (${dow}) — 전체 ${total}·접수 ${success}·배달 ${delivered}·실패 ${fail}`;

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

  // 1차 발송
  const idMap = {};                          // email → Resend message id (배달점검용)
  const okSet = new Set(); const firstErrs = [];
  for (const email of to) {
    const r = await sendOne(email);
    if (r.ok) okSet.add(email);
    else firstErrs.push({ email, error: String(r.error) });
  }

  // 재대조 재발송 — 발송 대상을 다시 산출해, 어떤 이유로든 발송 안 된 주소를 재시도.
  const intended = await deps.allRecipients(env);
  const missedAfterFirst = intended.filter(e => !okSet.has(e));
  const resendErrs = [];
  for (const email of missedAfterFirst) {
    const r = await sendOne(email, "r-");
    if (r.ok) okSet.add(email);
    else resendErrs.push({ email, error: String(r.error) });
  }

  const allTargets = [...new Set([...to, ...intended])];
  const stillMissing = allTargets.filter(e => !okSet.has(e));

  // [배달점검] 접수 성공분의 실제 배달 상태를 Resend 이벤트로 확인(최대 약 40초 대기).
  const delivery = await verifyDelivery(env, idMap);
  const undelivered = allTargets.filter(e => okSet.has(e) && delivery[e] !== "delivered");

  const report = {
    date: data.date,
    generatedAt: new Date().toISOString(),
    intended: allTargets.length,
    sent: okSet.size,
    delivered: allTargets.filter(e => delivery[e] === "delivered").length,
    recovered: missedAfterFirst.filter(e => okSet.has(e)).length,
    stillMissing,
    undelivered,
    delivery,
    messageIds: idMap,
    recipients: allTargets.map(e => ({ email: e, ok: okSet.has(e) })),
    firstErrors: firstErrs.slice(0, 10),
    resendErrors: resendErrs.slice(0, 10),
  };
  if (undelivered.length) console.warn(`[배달미확인] ${data.date} — ${undelivered.map(e => `${e}:${delivery[e] || "unknown"}`).join(", ")}`);
  await sendDailyReport(env, report, deps.kstWeekday);  // 발송결과 리포트 → 관리자 메일 + R2 백업

  return { ok: stillMissing.length === 0, ...report };
}
