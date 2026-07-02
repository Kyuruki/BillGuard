import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as content from "../src/content.js";

describe("brand name", () => {
  it("SITE.name is exactly MedBill Analyzer", () => {
    expect(content.SITE.name).toBe("MedBill Analyzer");
  });

  it("no exported copy still says BillGuard", () => {
    expect(JSON.stringify(content)).not.toContain("BillGuard");
  });

  it("the canonical URL points at the current custom domain", () => {
    expect(content.SITE.url).toBe("https://medbill.kyuruki.cc");
  });
});

describe("site.webmanifest", () => {
  const manifestPath = fileURLToPath(new URL("../public/site.webmanifest", import.meta.url));
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

  it("name is MedBill Analyzer", () => {
    expect(manifest.name).toBe("MedBill Analyzer");
  });

  it("short_name is at most 12 characters (PWA recommendation)", () => {
    expect(manifest.short_name.length).toBeLessThanOrEqual(12);
  });
});
