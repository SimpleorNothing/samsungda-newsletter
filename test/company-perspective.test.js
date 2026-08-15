import test from "node:test";
import assert from "node:assert/strict";
import { COMPANY_PERSPECTIVE_POLICY, injectCompanyPerspective } from "../src/company-perspective.js";

const targetPayload = () => ({
  model: "claude-sonnet-4-5",
  system: [
    "삼성전자 생활가전(DA) 기획자를 위한 데일리 브리핑을 쓴다.",
    "수치 나열이 아니라 맥락을 담는다.",
  ],
  messages: [{ role: "user", content: "test" }],
});

test("뉴스 AI 프롬프트에 당사=삼성전자 관점을 주입한다", () => {
  const src = targetPayload();
  const out = injectCompanyPerspective(src);

  assert.notEqual(out, src);
  assert.deepEqual(src.system, targetPayload().system, "원본 payload는 변경하지 않아야 한다");
  assert.ok(out.system.some(line => line.includes("'당사'는 항상 삼성전자")));
  assert.ok(out.system.some(line => line.includes("경쟁사 시점") && line.includes("opportunity")));
  assert.ok(COMPANY_PERSPECTIVE_POLICY.some(line => line.includes("LG 포지셔닝 기회")));
});

test("JSON.stringify 경로에서도 정책이 실제 Anthropic payload에 반영된다", () => {
  const serialized = JSON.stringify(targetPayload());
  const parsed = JSON.parse(serialized);
  assert.ok(parsed.system.some(line => line.includes("'당사'는 항상 삼성전자")));
  assert.ok(parsed.system.some(line => line.includes("삼성전자에 유리한 시장 단서")));
});

test("운임·인사이트 등 다른 요청에는 정책을 주입하지 않는다", () => {
  const other = {
    model: "claude-sonnet-4-5",
    system: ["컨테이너 해상운임 지수 최신치를 웹에서 조사해 JSON 한 덩어리로만 답한다."],
  };
  const out = injectCompanyPerspective(other);
  assert.equal(out, other);
  assert.deepEqual(JSON.parse(JSON.stringify(other)), other);
});

test("중복 호출에도 관점 정책을 한 번만 넣는다", () => {
  const once = injectCompanyPerspective(targetPayload());
  const twice = injectCompanyPerspective(once);
  const count = twice.system.filter(line => line.includes("'당사'는 항상 삼성전자")).length;
  assert.equal(count, 1);
});
