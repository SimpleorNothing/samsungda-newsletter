import test from "node:test";
import assert from "node:assert/strict";
import {
  selectDailyInsights,
  validateInstitutionDetailUrl,
  composeWeeklyInsights,
  isCompleteBPlanFeed,
} from "../src/insights.js";
import { INSIGHTS_BOOTSTRAP } from "../src/insights-bootstrap.js";

const NOW = new Date("2026-09-07T00:00:00Z");

test("B안은 지정 요일 카드 3개만 노출한다", () => {
  const mk = (day, n) => ({ day, date: "2026.09.01", title: `${day}-${n}`, url: `https://example.com/${day}/${n}` });
  const cards = [
    ...[1, 2, 3, 4].map(n => mk("mon", n)),
    ...[1, 2, 3].map(n => mk("tue", n)),
  ];
  const out = selectDailyInsights(cards, "2026.09.07", NOW);
  assert.equal(out.length, 3);
  assert.ok(out.every(x => x.day === "mon"));
});

test("bootstrap은 월~금 각 3개, 총 15개의 완전한 B안 피드다", () => {
  assert.equal(INSIGHTS_BOOTSTRAP.length, 15);
  assert.equal(isCompleteBPlanFeed(INSIGHTS_BOOTSTRAP, NOW), true);
  for (const day of ["mon", "tue", "wed", "thu", "fri"])
    assert.equal(selectDailyInsights(INSIGHTS_BOOTSTRAP, day, NOW).length, 3);
});

test("부분 큐레이션은 부족한 요일 카드만 fallback에서 채운다", () => {
  const primary = INSIGHTS_BOOTSTRAP.filter((_, i) => i !== 1 && i !== 7);
  const merged = composeWeeklyInsights(primary, [INSIGHTS_BOOTSTRAP], NOW);
  assert.equal(merged.length, 15);
  assert.equal(isCompleteBPlanFeed(merged, NOW), true);
  assert.equal(merged.filter(x => x.day === "mon").length, 3);
  assert.equal(merged.filter(x => x.day === "wed").length, 3);
});

test("구형 day 태그 없는 6장 피드는 B안 정상 피드로 인정하지 않는다", () => {
  const legacy = Array.from({ length: 6 }, (_, i) => ({
    date: "2026.09.01", title: `legacy-${i}`, url: `https://example.com/legacy/${i}`,
  }));
  assert.equal(isCompleteBPlanFeed(legacy, NOW), false);
});

test("BOK 목록 URL은 차단하고 view.do + nttId만 허용한다", () => {
  assert.equal(validateInstitutionDetailUrl("https://www.bok.or.kr/portal/bbs/B0000501/list.do?menuNo=201264"), false);
  assert.equal(validateInstitutionDetailUrl("https://www.bok.or.kr/portal/bbs/B0000501/view.do?nttId=11064042&menuNo=201264"), true);
});

test("국가데이터처/통계청/KIEP/KIET 상세 URL 패턴만 허용한다", () => {
  assert.equal(validateInstitutionDetailUrl("https://mods.go.kr/board.es?act=view&bid=216&list_no=446690&mid=a10301010000"), true);
  assert.equal(validateInstitutionDetailUrl("https://mods.go.kr/board.es?bid=216&mid=a10301010000"), false);
  assert.equal(validateInstitutionDetailUrl("https://kostat.go.kr/board.es?mid=a10000000000&bid=123&act=view&list_no=456"), true);
  assert.equal(validateInstitutionDetailUrl("https://kostat.go.kr/board.es?mid=a10000000000&bid=123"), false);
  assert.equal(validateInstitutionDetailUrl("https://www.kiep.go.kr/gallery.es?act=view&bid=0008&list_no=12514&mid=a10105050000"), true);
  assert.equal(validateInstitutionDetailUrl("https://www.kiep.go.kr/menu.es?mid=a10105050000"), false);
  assert.equal(validateInstitutionDetailUrl("https://www.kiet.re.kr/trends/ecolookView?ecolook_no=56"), true);
  assert.equal(validateInstitutionDetailUrl("https://www.kiet.re.kr/trends/ecolookList"), false);
});
