import test from "node:test";
import assert from "node:assert/strict";
import { fxDirection, hasFxDirectionConflict } from "../src/index.js";

test("USD/MXN 하락은 페소 강세로 판정", () => {
  const move = fxDirection(17.21, 18.87);
  assert.equal(move.strength, "강세");
  assert.ok(move.currencyPct > 9.6 && move.currencyPct < 9.7);
});

test("페소 약세 오문장을 차단", () => {
  const q = { "MXN=X": { price: 17.21, first6m: 18.87 } };
  assert.equal(hasFxDirectionConflict("멕시코 페소 약세로 현지 원가가 낮아졌다", q), true);
  assert.equal(hasFxDirectionConflict("멕시코 페소 강세로 현지 원가 부담이 높아졌다", q), false);
});

test("묶음 통화 오문장도 차단", () => {
  const q = {
    "MXN=X": { price: 17.21, first6m: 18.87 },
    "VND=X": { price: 25200, first6m: 26000 },
  };
  assert.equal(hasFxDirectionConflict("페소·동 약세", q), true);
});
