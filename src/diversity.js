// 시장 동향 주제 편중 방지 — 같은 주제(이슈)를 한 호에 최대 TOPIC_CAP건까지만 노출한다.
//
// 배경: 기존 중복제거는 문장 유사도(Jaccard) 기반이라, 같은 이슈를 다룬 '서로 다른 기사'는
//       유사도가 낮아(0.1 안팎) 전부 통과한다. 2026-07-24 호에서 시장 동향 5건이 모두
//       USMCA 한 주제로 채워진 사례가 이 구멍에서 나왔다.
// 방식: 유사도가 아니라 ① 앵커(고유 약어) 공유 ② 내용어 공통 개수로 '같은 주제'를 판정한다.
//       USMCA·FTA 처럼 기사마다 반복되는 고유 약어가 있으면 그것만으로 같은 주제로 본다.
//       약어가 없는 국내 이슈(예: 코웨이 매트리스 구독)는 내용어 3개 이상 겹치면 같은 주제로 본다.
//
// index.js가 이 모듈을 Worker 초기화 시 항상 import하므로, 뉴스 AI 분석의 '당사=삼성전자' 관점
// 가드도 여기서 1회 설치한다. 대형 index.js를 통째로 재기록하지 않고 정책을 독립 모듈로 관리한다.
import "./company-perspective.js";

export const TOPIC_CAP = 2;   // 동일 주제 최대 노출 건수
export const TOPIC_MIN = 3;   // 다른 주제가 부족할 때 이 건수까지는 상한을 풀어 채운다(섹션 공백 방지)

// 어느 기사에나 붙는 범용 약어 — 주제 앵커에서 제외.
const ACRONYM_STOP = new Set([
  "AI", "IT", "ICT", "IOT", "CEO", "CFO", "CTO", "CES", "IFA", "ESG", "TV", "EV", "PC",
  "GDP", "CPI", "PPI", "OLED", "LCD", "LED", "USB", "SNS", "API", "R&D", "M&A", "B2B", "B2C", "B2G",
]);

// 주제 판별에 도움이 되지 않는 범용 명사·서술어 — 내용어에서 제외.
const TERM_STOP = new Set([
  "기업", "시장", "국내", "해외", "글로벌", "업계", "산업", "사업", "전략", "계획", "방침",
  "발표", "공개", "추진", "확대", "강화", "감소", "증가", "전망", "우려", "관측", "분석",
  "대응", "필요", "가능", "영향", "효과", "이슈", "관련", "위해", "따라", "대한", "지난",
  "올해", "내년", "작년", "오늘", "최근", "본격화", "가속", "경쟁", "협력", "확보", "출시",
  "제품", "기술", "서비스", "고객", "소비자", "가전", "생활가전", "가운데", "이상", "이하",
]);

const cache = new WeakMap();

function normalize(text) {
  return String(text || "")
    .replace(/[\[\]{}()<>「」『』【】·…‥“”‘’"'`~!@#$%^&*_+=|\\/:;,.?!\-–—]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// 앵커: 3자 이상 대문자 약어(USMCA, IRA는 3자, FTA 등). 범용 약어는 제외.
function anchorsOf(text) {
  const out = new Set();
  for (const m of normalize(text).matchAll(/\b[A-Z][A-Z0-9]{2,}\b/g)) {
    if (!ACRONYM_STOP.has(m[0])) out.add(m[0]);
  }
  return out;
}

// 내용어: 조사 제거 후 2자 이상, 범용어 제외.
function termsOf(text) {
  const out = new Set();
  for (const w of normalize(text).split(" ")) {
    const t = w.replace(/(에서는|에게는|으로는|에서|에게|으로|까지|부터|보다|처럼|이라|라며|하며|한다|했다|된다|됐다|이다|은|는|이|가|을|를|의|에|와|과|도|만|로)$/, "");
    if (t.length < 2) continue;
    if (TERM_STOP.has(t)) continue;
    out.add(t.toUpperCase());
  }
  return out;
}

function topicOf(item) {
  if (cache.has(item)) return cache.get(item);
  const text = `${item.headline || ""} ${item.summary || ""}`;
  const t = { anchors: anchorsOf(text), terms: termsOf(item.headline || "") };
  cache.set(item, t);
  return t;
}

// 두 기사가 같은 주제인지 판정.
export function sameTopic(a, b) {
  const ta = topicOf(a), tb = topicOf(b);
  for (const x of ta.anchors) if (tb.anchors.has(x)) return true;   // ① 고유 약어 공유
  let shared = 0;
  for (const x of ta.terms) if (tb.terms.has(x)) shared++;
  if (shared >= 3) return true;                                     // ② 내용어 3개 이상 공통
  const union = new Set([...ta.terms, ...tb.terms]).size;
  return union > 0 && shared / union >= 0.35;                       // ③ 제목 자체가 거의 동일
}

// 이미 채택된 목록(selected)에 대해 후보(item)가 주제 상한에 걸리는지.
export function topicBlocked(item, selected, cap = TOPIC_CAP) {
  let hits = 0;
  for (const s of selected) {
    if (sameTopic(item, s) && ++hits >= cap) return true;
  }
  return false;
}
