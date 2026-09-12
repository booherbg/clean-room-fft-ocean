/**
 * GPU passes vs the CPU oracle, on real WebGL2 pixels (see e2e/pages/gpu.ts).
 */
import { expect, test, type Page } from "@playwright/test";
import { DEFAULT_PARAMS } from "../src/core/params";

const PAGE = "/e2e/pages/gpu.html";

async function openGpuPage(page: Page): Promise<string[]> {
  const errors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error" || msg.type() === "warning") errors.push(`${msg.type()}: ${msg.text()}`);
  });
  page.on("pageerror", (err) => errors.push(`pageerror: ${err.message}`));
  await page.goto(PAGE);
  await page.waitForFunction(() => window.__gpu?.ready === true);
  expect(await page.evaluate(() => window.__gpu.webgl2)).toBe(true);
  return errors;
}

test.describe("FFT pass", () => {
  for (const N of [16, 64]) {
    for (const inverse of [false, true]) {
      test(`N=${N} ${inverse ? "inverse" : "forward"} equals core.fft2d`, async ({ page }) => {
        const errors = await openGpuPage(page);
        const r = await page.evaluate(([n, inv]) => window.__gpu.fftRoundTrip(n as number, inv as boolean), [N, inverse]);
        expect(r.maxAbs).toBeGreaterThan(0);
        expect(r.rel, JSON.stringify(r)).toBeLessThan(1e-3);
        expect(await page.evaluate(() => window.__gpu.glError())).toBe(0);
        expect(errors).toEqual([]);
      });
    }
  }
});

test.describe("simulate(64) vs core.simulate", () => {
  const cases: { name: string; waves: Partial<typeof DEFAULT_PARAMS.waves>; t: number; layout: number }[] = [
    { name: "default waves, t=0, cascade 0", waves: {}, t: 0, layout: 0 },
    { name: "wind 15, t=3.7, cascade 0", waves: { windSpeed: 15, windDirection: 0.7 }, t: 3.7, layout: 0 },
    { name: "band-limited cascade 1, choppiness 1.5, t=1.3", waves: { choppiness: 1.5, seed: 7 }, t: 1.3, layout: 1 },
    { name: "standing waves, last cascade, t=0.4", waves: { standingWaveRatio: 0.5, seed: 99 }, t: 0.4, layout: 2 },
  ];
  for (const c of cases) {
    test(c.name, async ({ page }) => {
      const errors = await openGpuPage(page);
      const waves = JSON.stringify({ ...DEFAULT_PARAMS.waves, ...c.waves });
      const r = await page.evaluate(
        ([w, t, l]) => window.__gpu.simulate(64, w as string, t as number, l as number),
        [waves, c.t, c.layout],
      );
      for (const [field, e] of Object.entries(r)) {
        expect(e.cpuRms, `${field} cpuRms`).toBeGreaterThan(0);
        expect(e.relRms, `${field}: ${JSON.stringify(e)}`).toBeLessThan(0.02);
      }
      expect(await page.evaluate(() => window.__gpu.glError())).toBe(0);
      expect(errors).toEqual([]);
    });
  }
});

test.describe("foam energy field", () => {
  test("J ≡ 0 sources at least crestStrength·threshold; J ≡ 1 with dt = decayTime decays by e^-1", async ({ page }) => {
    const errors = await openGpuPage(page);
    const foam = { threshold: 0.6, crestStrength: 2.5, windwardStrength: 1.5, decayTime: 0.5 };
    const seeded = await page.evaluate((f) => window.__gpu.foamSteps({ N: 16, J: 0, dt: 0.01, foam: f, steps: 2 }), foam);
    expect(seeded[1]).toBeGreaterThanOrEqual(foam.crestStrength * foam.threshold - 1e-5);
    // Decay needs memory: the page charges a field with J ≡ 0, then feeds J ≡ 1.
    const decayed = await page.evaluate((f) => window.__gpu.foamDecay({ N: 16, dtOverDecay: 1, foam: f }), foam);
    // charged = crest·threshold; after one step with J ≡ 1 and dt = decayTime → charged·e^-1
    const ratio = decayed.after / decayed.charged;
    expect(decayed.charged).toBeGreaterThan(1);
    expect(ratio).toBeGreaterThan(Math.exp(-1) - 0.02);
    expect(ratio).toBeLessThan(Math.exp(-1) + 0.02);
    // Two more decay steps keep multiplying by e^-1.
    expect(decayed.after3 / decayed.charged).toBeCloseTo(Math.exp(-3), 3);
    expect(await page.evaluate(() => window.__gpu.glError())).toBe(0);
    expect(errors).toEqual([]);
  });

  test("J above threshold produces no foam; windward slope adds foam only where J folds", async ({ page }) => {
    const errors = await openGpuPage(page);
    const foam = { threshold: 0.6, crestStrength: 2.5, windwardStrength: 1.5, decayTime: 0.5 };
    const calm = await page.evaluate((f) => window.__gpu.foamSteps({ N: 16, J: 1, dt: 0.1, foam: f, steps: 3 }), foam);
    expect(Math.max(...calm)).toBe(0);
    const windward = await page.evaluate(
      (f) => window.__gpu.foamSteps({ N: 16, J: 0, dt: 0.1, foam: f, steps: 1, slope: [1, 0], windDir: [1, 0] }),
      foam,
    );
    // crest·threshold + windward·1·threshold
    expect(windward[0]).toBeCloseTo((foam.crestStrength + foam.windwardStrength) * foam.threshold, 4);
    expect(errors).toEqual([]);
  });
});

test.describe("OceanSim", () => {
  test("builds the tier's cascades, foam on cascades 0 and 1 only, no GL or console errors", async ({ page }) => {
    const errors = await openGpuPage(page);
    const r = await page.evaluate(() => window.__gpu.oceanSimSmoke("high", 3));
    expect(r.cascades).toBe(3);
    expect(r.N).toBe(256);
    expect(r.sizes).toEqual([1024, 96, 9]);
    expect(r.foam).toEqual([true, true, false]);
    expect(r.heightRms[0]).toBeGreaterThan(0.05);
    for (const h of r.heightRms) expect(Number.isFinite(h)).toBe(true);
    expect(r.foamMean.length).toBe(2);
    for (const f of r.foamMean) expect(f).toBeGreaterThanOrEqual(0);
    expect(await page.evaluate(() => window.__gpu.glError())).toBe(0);
    expect(errors).toEqual([]);
  });
});
