import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "assets");
const BUDGET = 15 * 1024 * 1024;

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

describe("shipped assets (spec §1.15)", () => {
  it("total under the 15 MB budget", () => {
    const bytes = walk(ROOT).reduce((n, p) => n + statSync(p).size, 0);
    expect(bytes).toBeGreaterThan(0);
    expect(bytes).toBeLessThan(BUDGET);
  });

  it("every model is listed in LICENSES.md with a licence", () => {
    const licenses = readFileSync(join(ROOT, "LICENSES.md"), "utf8");
    const models = walk(join(ROOT, "models")).map((p) => p.slice(ROOT.length + 1));
    expect(models.length).toBeGreaterThan(0);
    for (const m of models) expect(licenses, `${m} missing from LICENSES.md`).toContain(m);
    expect(licenses).toMatch(/CC0|CC-BY/);
  });
});
