// 발송 + 재대조 재발송 + 일일 리포트 — index.js run()에서 위임 호출.
// 목적:
//  (1) 수신자 목록 대비 실제 발송을 대조해 "어떤 이유로든" 발송 안 된 주소를 재발송(2-pass).
//  (2) 발송결과 요약 리포트를 매일 아침 관리자(REPORT_TO)에게 메일.
//  (3) 동일 날짜·수신자 중복 발송은 Idempotency-Key로 방지(수동 /send 재실행 안전).
// deps 로 index.js 의 { allRecipients, signToken, signKey, kstWeekday } 를 주입받아 순환참조를 피한다.

const REPORT_TO = "cw120.park@samsung.com";  // 발송결과 일일 리포트 수신 주소

const _enc = new TextEncoder();
async function sha256hex(s) {
  const b = await crypto.subtle.digest("SHA-256", _enc.encode(s));
  return [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, "0")).join("");
}

// Resend 단건 발송 — id 반환 + Idempotency-Key 지원. 실패 시 { ok:false, error }.
export async function sendResendIdem(env, { to, subject, html, idem }) {
  const headers = { "Authorization": `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" };
  if (idem) headers["Idempotency-Key"] = idem;
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers,
    body: JSON.stringify({ from: env.FROM || "기획 도구모음 <newsletter@samsungda.net>", to: [to], subject, html }),
  });
  const j = await res.json().catch(() => ({}));
  if (res.ok) return { ok: true, id: j.id };
  return { ok: false, error: j.message || res.status };
}

// 발송결과 일일 리포트 — 관리자(REPORT_TO)에게 요약 메일. 실패해도 발송 흐름엔 영향 없음.
async function sendDailyReport(env, report, kstWeekday) {
  if (!env.RESEND_API_KEY) return;
  const dow = kstWeekday(report.date);
  const miss = report.stillMissing || [];
  const errLines = [...(report.firstErrors || []), ...(report.resendErrors || [])]
    .map(e => `<tr><td style="padding:4px 8px;border-top:1px solid #eee">${e.email}</td><td style="padding:4px 8px;border-top:1px solid #eee;color:#b00">${String(e.error)}</td></tr>`).join("");
  const missBlock = miss.length
    ? `<p style="margin:12px 0 4px;color:#b00;font-weight:600">미발송(재시도 후에도 실패) ${miss.length}건</p><p style="margin:0;font-family:monospace;font-size:13px">${miss.join("<br>")}</p>`
    : `<p style="margin:12px 0;color:#0a0;font-weight:600">전원 발송 완료 — 미발송 0건</p>`;
  const html = `<!DOCTYPE html><html lang="ko"><body style="font-family:-apple-system,BlinkMacSystemFont,'Malgun Gothic',sans-serif;color:#222;max-width:560px;margin:0 auto;padding:16px">`
    + `<h2 style="margin:0 0 4px;font-size:18px">기획 데일리 발송 리포트</h2>`
    + `<p style="margin:0 0 12px;color:#666">${report.date} (${dow})</p>`
    + `<table style="border-collapse:collapse;font-size:14px">`
    + `<tr><td style="padding:2px 10px 2px 0;color:#666">대상</td><td style="font-weight:600">${report.intended}명</td></tr>`
    + `<tr><td style="padding:2px 10px 2px 0;color:#666">발송 성공</td><td style="font-weight:600">${report.sent}명</td></tr>`
    + `<tr><td style="padding:2px 10px 2px 0;color:#666">재발송 복구</td><td style="font-weight:600">${report.recovered}명</td></tr>`
    + `<tr><td style="padding:2px 10px 2px 0;color:#666">미발송</td><td style="font-weight:600;color:${miss.length ? '#b00' : '#0a0'}">${miss.length}명</td></tr>`
    + `</table>${missBlock}`
    + (errLines ? `<p style="margin:14px 0 4px;color:#666;font-weight:600">오류 상세</p><table style="border-collapse:collapse;font-size:13px;width:100%"><tr><th style="text-align:left;padding:4px 8px">주소</th><th style="text-align:left;padding:4px 8px">오류</th></tr>${errLines}</table>` : "")
    + `<p style="margin:18px 0 0;color:#999;font-size:12px">samsungda-newsletter · 자동 생성</p></body></html>`;
  try {
    await sendResendIdem(env, {
      to: REPORT_TO,
      subject: `기획 데일리 발송 리포트 · ${report.date} (${dow}) — 성공 ${report.sent}/${report.intended}`,
      html,
      idem: `report-${report.date}`,
    });
  } catch { /* 리포트 실패 무시 */ }
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
    firstErrors: firstErrs.slice(0, 10),
    resendErrors: resendErrs.slice(0, 10),
  };
  await sendDailyReport(env, report, deps.kstWeekday);  // 발송결과 리포트 → 관리자 메일

  return { ok: stillMissing.length === 0, ...report };
}
