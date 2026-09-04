import test from "node:test";
import assert from "node:assert/strict";
import { selectDailyInsights, validateInstitutionDetailUrl } from "../src/insights.js";

test("B안은 지정 요일 카드 3개만 노출한다", () => {
  const mk = (day, n) => ({ day, date: "2026.09.01", title: `${day}-${n}`, url: `https://example.com/${day}/${n}` });
  const cards = [
    ...[1, 2, 3, 4].map(n => mk("mon", n)),
    ...[1, 2, 3].map(n => mk("tue", n)),
  ];
  const out = selectDailyInsights(cards, "2026.09.07", new Date("2026-09-07T00:00:00Z"));
  assert.equal(out.length, 3);
  assert.ok(out.every(x => x.day === "mon"));
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
