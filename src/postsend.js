// 발송 + 재대조 재발송 + 일일 리포트 — index.js run()에서 위임 호출.
// 목적:
//  (1) 수신자 목록 대비 실제 발송을 대조해 "어떤 이유로든" 발송 안 된 주소를 재발송(2-pass).
//  (2) 발송결과 요약 리포트를 매일 아침 관리자(REPORT_TOS)에게 메일 — 수신처 전체 리스트 + 전체/성공/실패.
//  (3) 동일 날짜·수신자 중복 발송은 Idempotency-Key로 방지(수동 /send 재실행 안전).
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

// 발송결과 일일 리포트 — 관리자(REPORT_TOS 전원)에게 요약 메일. 실패해도 발송 흐름엔 영향 없음.
async function sendDailyReport(env, report, kstWeekday) {
  if (!env.RESEND_API_KEY) return;
  const dow = kstWeekday(report.date);
  const total = report.intended;
  const success = report.sent;
  const fail = (report.stillMissing || []).length;

  // 수신처 전체 리스트(실패 먼저, 그다음 성공). 각 행에 상태 배지.
  const recs = (report.recipients || []).slice().sort((a, b) => (a.ok === b.ok ? a.email.localeCompare(b.email) : (a.ok ? 1 : -1)));
  const recRows = recs.map((r, i) => `<tr>`
    + `<td style="padding:5px 8px;border-top:1px solid #eee;color:#888;font-variant-numeric:tabular-nums">${i + 1}</td>`
    + `<td style="padding:5px 8px;border-top:1px solid #eee;font-family:monospace">${r.email}</td>`
    + `<td style="padding:5px 8px;border-top:1px solid #eee;font-weight:700;color:${r.ok ? '#0a0' : '#b00'}">${r.ok ? '성공' : '실패'}</td>`
    + `</tr>`).join("");
  const recTable = recRows
    ? `<p style="margin:16px 0 4px;color:#666;font-weight:600">수신처 전체 (${total}명)</p>`
      + `<table style="border-collapse:collapse;font-size:13px;width:100%">`
      + `<tr><th style="text-align:left;padding:5px 8px;color:#888">#</th><th style="text-align:left;padding:5px 8px;color:#888">주소</th><th style="text-align:left;padding:5px 8px;color:#888">상태</th></tr>`
      + `${recRows}</table>`
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
    + recTable
    + (errLines ? `<p style="margin:16px 0 4px;color:#666;font-weight:600">오류 상세</p><table style="border-collapse:collapse;font-size:13px;width:100%"><tr><th style="text-align:left;padding:4px 8px;color:#888">주소</th><th style="text-align:left;padding:4px 8px;color:#888">오류</th></tr>${errLines}</table>` : "")
    + `<p style="margin:18px 0 0;color:#999;font-size:12px">samsungda-newsletter · 자동 생성</p></body></html>`;

  const subject = `기획 데일리 발송 리포트 · ${report.date} (${dow}) — 전체 ${total}·성공 ${success}·실패 ${fail}`;
  for (const to of REPORT_TOS) {
    try {
      await sendResendIdem(env, { to, subject, html, idem: `report-${report.date}-${to}` });
    } catch { /* 리포트 실패 무시 */ }
  }
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
    return sendResendIdem(env, { to: email, subject, html, idem });
  };

  // 1차 발송
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
  const report = {
    date: data.date,
    intended: allTargets.length,
    sent: okSet.size,
    recovered: missedAfterFirst.filter(e => okSet.has(e)).length,
    stillMissing,
    recipients: allTargets.map(e => ({ email: e, ok: okSet.has(e) })),
    firstErrors: firstErrs.slice(0, 10),
    resendErrors: resendErrs.slice(0, 10),
  };
  await sendDailyReport(env, report, deps.kstWeekday);  // 발송결과 리포트 → 관리자 메일

  return { ok: stillMissing.length === 0, ...report };
}
