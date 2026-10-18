/**
 * Tests for normalizeHandle, which decides whether two contact handles are
 * the same person. A miss here signs a known resident up as a stranger.
 */
import { describe, expect, it } from "vitest";
import { normalizeHandle } from "../src/lib/phone.js";

describe("normalizeHandle: phone numbers", () => {
  it.each([
    "+16175550101",
    "(617) 555-0101",
    "617-555-0101",
    "617.555.0101",
    "6175550101",
    "16175550101",
    "+1 (617) 555-0101",
    "  +1 617 555 0101  ",
    "tel:+16175550101",
  ])("turns %s into +16175550101", (raw) => {
    expect(normalizeHandle(raw)).toBe("+16175550101");
  });

  it("keeps a non-US number that already has a plus", () => {
    expect(normalizeHandle("+44 20 7946 0158")).toBe("+442079460158");
  });

  it("adds +1 only to 10-digit numbers without a plus", () => {
    expect(normalizeHandle("442079460158")).toBe("+442079460158");
  });

  it("accepts exactly 7 digits", () => {
    expect(normalizeHandle("555-0101")).toBe("+5550101");
  });

  it.each(["", "   ", "123456", "+12345", "abc", "call me", "(617)"])(
    "returns null for %j, which has fewer than 7 digits",
    (raw) => {
      expect(normalizeHandle(raw)).toBeNull();
    },
  );
});

describe("normalizeHandle: emails", () => {
  it("lowercases and trims an iMessage email", () => {
    expect(normalizeHandle("  Amit.Demo@Example.COM ")).toBe("amit.demo@example.com");
  });

  it("does not strip digits out of an email", () => {
    expect(normalizeHandle("amit6175550101@example.com")).toBe("amit6175550101@example.com");
  });
});

describe("normalizeHandle: matching", () => {
  it("makes every format of the same number equal", () => {
    const forms = ["(617) 555-0101", "+16175550101", "6175550101", "1-617-555-0101"];
    expect(new Set(forms.map(normalizeHandle)).size).toBe(1);
  });

  it("keeps different numbers different", () => {
    expect(normalizeHandle("617-555-0101")).not.toBe(normalizeHandle("617-555-0102"));
  });
});
