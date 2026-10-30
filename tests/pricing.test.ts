import { describe, expect, it } from "vitest";
import { estimatePrice, formatPrice, parsePrices } from "../src/pricing";

describe("reference prices", () => {
  it.each([
    { types: [1, 1001, 2, 1002, 3, 1003], price: "0.002000" },
    { types: [4], price: "0.004000" },
    { types: [11, 1005, 5], price: "0.008000" },
    { types: [19, 18, 33, 34, 3400], price: "0.010000" },
    { types: [29, 1029, 20, 27, 1033, 53], price: "0.016000" },
    { types: [2029, 21], price: "0.020000" },
    { types: [22], price: "0.025000" },
    { types: [48], price: "0.030000" },
  ])("maps the official $price category", ({ types, price }) => {
    for (const typeid of types) {
      const result = estimatePrice(String(typeid), "ok", true, new Map());
      expect(result.source).toBe("official");
      expect(result.micros === null ? null : formatPrice(result.micros)).toBe(price);
    }
  });

  it.each([
    { typeid: "16", result: "汉𠮷", micros: 16_000n },
    { typeid: "16", result: "", micros: null },
    { typeid: "7", result: "a1", micros: 8_000n },
    { typeid: "7", result: "a1b2", micros: 8_000n },
    { typeid: "7", result: "a1b2c3", micros: 12_000n },
    { typeid: "7", result: "汉𠮷字", micros: 24_000n },
    { typeid: "7", result: "汉A", micros: null },
    { typeid: "7", result: "", micros: null },
    { typeid: "32", result: "text", micros: null },
    { typeid: "66", result: "answer", micros: null },
    { typeid: "private", result: "answer", micros: null },
    { typeid: "toString", result: "answer", micros: null },
  ])("prices type $typeid result '$result' without guessing", ({ typeid, result, micros }) => {
    expect(estimatePrice(typeid, result, true, new Map()).micros).toBe(micros);
  });

  it("keeps failures and private services unknown, but permits explicit zero overrides", () => {
    const prices = parsePrices({ "3": "0", "7": "0.0002" });
    expect(estimatePrice("3", null, true, prices)).toEqual({ micros: null, source: "unknown" });
    expect(estimatePrice("3", "ok", false, new Map())).toEqual({ micros: null, source: "unknown" });
    expect(estimatePrice("3", "ok", false, prices)).toEqual({ micros: 0n, source: "custom" });
    expect(estimatePrice("7", "汉A", true, prices)).toEqual({ micros: 200n, source: "custom" });
  });

  it("snapshots prices and preserves exact amounts beyond floating point precision", () => {
    const input = { "3": "9007199254.740993" };
    const prices = parsePrices(input);
    input["3"] = "1";
    const result = estimatePrice("3", "ok", true, prices);
    expect(result.micros).toBe(9_007_199_254_740_993n);
    expect(formatPrice(9_007_199_254_740_993n + 1n)).toBe("9007199254.740994");
  });

  it.each(["-1", "1.1234567", "NaN", "Infinity", "1e-3", " 0.1 ", "", "9223372036854.775808"])(
    "rejects invalid price '%s'",
    (price) => {
      expect(() => parsePrices({ "3": price })).toThrow(/价格/);
    },
  );
});
