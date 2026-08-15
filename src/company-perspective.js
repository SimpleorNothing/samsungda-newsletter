// 뉴스레터 AI 분석 관점 가드.
//
// 목적: 시장 동향의 opportunity/threat가 기사 주체(예: LG전자) 시점으로 뒤집히지 않도록
//       '당사 = 삼성전자'를 Claude system prompt에 강제 주입한다.
//
// src/index.js는 120KB가 넘는 대형 단일 파일이라 부분 수정 과정에서 truncation 사고가 있었으므로,
// 이 정책은 index.js가 항상 import하는 diversity.js를 통해 초기화되는 독립 모듈로 둔다.
// Anthropic 요청 중 '삼성전자 생활가전(DA) 기획자를 위한 데일리 브리핑' 요청에만 적용하며,
// 운임 조회·리서치 인사이트 큐레이션 등 다른 JSON.stringify 호출에는 영향을 주지 않는다.

export const COMPANY_PERSPECTIVE_POLICY = [
  "- 관점 고정(최우선): 이 뉴스레터에서 '당사'는 항상 삼성전자다. 시장 동향의 news[].opportunity·threat 및 경쟁 구도 해석은 반드시 삼성전자 기준으로 작성한다.",
  "- opportunity는 삼성전자에 유리한 시장 단서만 쓴다. LG전자·Haier·Whirlpool 등 경쟁사의 성장·인수·점유율 상승·프리미엄 경쟁력 강화처럼 '경쟁사에 유리한 효과' 자체를 opportunity로 쓰지 않는다.",
  "- threat는 삼성전자에 불리한 경쟁·시장·정책 압박을 쓴다. 경쟁사가 강화되는 내용은 경쟁사 시점의 '기회'가 아니라 삼성전자 관점의 경쟁 압력으로 threat에 배치한다.",
  "- 'LG 포지셔닝 기회'·'경쟁사 성장 기회'처럼 경쟁사 시점으로 읽히는 opportunity 문구는 금지한다. 기사에서 삼성전자에 유리한 단서가 없으면 opportunity는 '당사에 유리하게 읽을 단서는 제한적'으로 쓴다.",
];

const TARGET_SYSTEM_MARKER = "삼성전자 생활가전(DA) 기획자를 위한 데일리 브리핑";
const POLICY_MARKER = "관점 고정(최우선): 이 뉴스레터에서 '당사'는 항상 삼성전자다";
const GUARD_KEY = Symbol.for("samsungda.newsletter.companyPerspectiveGuard");

export function injectCompanyPerspective(value) {
  if (!value || typeof value !== "object" || !Array.isArray(value.system)) return value;
  if (!value.system.some(line => typeof line === "string" && line.includes(TARGET_SYSTEM_MARKER))) return value;
  if (value.system.some(line => typeof line === "string" && line.includes(POLICY_MARKER))) return value;

  const system = value.system.slice();
  const insertAt = Math.min(2, system.length);
  system.splice(insertAt, 0, ...COMPANY_PERSPECTIVE_POLICY);
  return { ...value, system };
}

// index.js 내부의 JSON.stringify({ model, system, messages, ... }) 직전에 정책을 주입한다.
// 원본 객체는 변경하지 않아 다른 코드 경로의 재사용·검증에 영향을 주지 않는다.
if (!globalThis[GUARD_KEY]) {
  const nativeStringify = JSON.stringify;
  Object.defineProperty(JSON, "stringify", {
    configurable: true,
    writable: true,
    value(value, replacer, space) {
      return nativeStringify.call(JSON, injectCompanyPerspective(value), replacer, space);
    },
  });
  globalThis[GUARD_KEY] = true;
}
