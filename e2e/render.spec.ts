import { expect, test, type Page } from "@playwright/test";

const PAGE = "/e2e/pages/render.html";

async function stats(page: Page) {
  await page.evaluate(() => window.__render.screenshotReady());
  return page.evaluate(() => window.__render.frameStats());
}

test.describe("render layer", () => {
  let errors: string[];

  test.beforeEach(async ({ page }) => {
    errors = [];
    page.on("console", (m) => {
      if (m.type() === "error") errors.push(m.text());
    });
    page.on("pageerror", (e) => errors.push(String(e)));
    await page.goto(PAGE);
    await page.evaluate(() => window.__render.ready);
  });

  test("renders without errors; centre pixel is bluish", async ({ page }) => {
    const s = await stats(page);
    const [r, g, b] = s.centre;
    expect(errors).toEqual([]);
    expect(b).toBeGreaterThan(r);
    expect(g + b).toBeGreaterThan(40);
    await expect(page.evaluate(() => window.__render.stats())).resolves.toMatchObject({ draws: 2 });
  });

  test("night is darker than noon", async ({ page }) => {
    await page.evaluate(() => window.__render.setParams({ sky: { timeOfDay: 12 } }));
    const noon = (await stats(page)).meanLuminance;
    await page.evaluate(() => window.__render.setParams({ sky: { timeOfDay: 0 } }));
    const night = (await stats(page)).meanLuminance;
    expect(night).toBeLessThan(noon);
    expect(errors).toEqual([]);
  });

  test("wind 25 differs from wind 3", async ({ page }) => {
    await page.evaluate(() => window.__render.setParams({ waves: { windSpeed: 3 } }));
    await page.evaluate(() => window.__render.snapshot("calm"));
    await page.evaluate(() => window.__render.setParams({ waves: { windSpeed: 25 } }));
    await page.evaluate(() => window.__render.snapshot("gale"));
    const diff = await page.evaluate(() => window.__render.diff("calm", "gale"));
    expect(diff).toBeGreaterThan(5);
    expect(errors).toEqual([]);
  });

  test("storm produces more foam (near-white pixels) than calm", async ({ page }) => {
    await page.evaluate(() => window.__render.setParams({ waves: { windSpeed: 2, peakWavelength: 30 } }));
    const calm = (await stats(page)).nearWhite;
    await page.evaluate(() =>
      window.__render.setParams({ waves: { windSpeed: 25, peakWavelength: 60, choppiness: 1.6 } }),
    );
    const storm = (await stats(page)).nearWhite;
    expect(storm).toBeGreaterThan(calm);
    expect(errors).toEqual([]);
  });

  test("saves the default screenshot", async ({ page }) => {
    await page.evaluate(() => window.__render.screenshotReady());
    await page.screenshot({ path: "e2e/__screenshots__/render-default.png" });
    expect(errors).toEqual([]);
  });

  test("terrain: the island's peak renders as rock/sand, not water or sky", async ({ page }) => {
    await page.evaluate(() => window.__render.screenshotReady());
    const px = await page.evaluate(() => {
      const [ix, iz] = window.__render.island();
      const top = window.__render.terrainHeight(ix, iz);
      // Just below the summit on the camera-facing side: always terrain.
      const uv = window.__render.project(ix, top - 4, iz + 6);
      if (!uv) return null;
      return { uv, rgb: window.__render.pixel(uv[0], uv[1]), top };
    });
    expect(px).not.toBeNull();
    expect(px!.top).toBeGreaterThan(40);
    const [r, g, b] = px!.rgb;
    // Rock and sand are warm: red at least matches blue; the sky and the
    // water are blue-dominant.
    expect(r, `peak pixel ${r},${g},${b} at ${px!.uv}`).toBeGreaterThanOrEqual(b);
    expect(r + g + b).toBeGreaterThan(60);
    expect(errors).toEqual([]);
  });

  test("terrain: lighting is in world space — rolling the camera 90° does not change a slope's shade", async ({ page }) => {
    // Same camera position and look direction, camera rolled about its view
    // axis. World-space normals give the same colour at the (re-projected)
    // point; view-space normals would rotate the sun/sky terms with the roll.
    const shade = async (up: [number, number, number]) =>
      page.evaluate(async (up) => {
        await window.__render.setCamera([0, 18, 40], [0, 4, -160], up);
        const [ix, iz] = window.__render.island();
        const top = window.__render.terrainHeight(ix, iz);
        const uv = window.__render.project(ix, top - 4, iz + 6);
        return uv && window.__render.regionMean(uv[0], uv[1], 3);
      }, up);
    const upright = await shade([0, 1, 0]);
    const rolled = await shade([1, 0, 0]);
    expect(upright).not.toBeNull();
    expect(rolled).not.toBeNull();
    for (let c = 0; c < 3; c++) {
      expect(Math.abs(upright![c]! - rolled![c]!), `${upright} vs rolled ${rolled}`).toBeLessThan(12);
    }
    expect(errors).toEqual([]);
  });

  test("shoreline: more near-white at the waterline than 200 m out to sea", async ({ page }) => {
    // Calm sea so open-water whitecaps do not compete with the shore foam.
    await page.evaluate(() => window.__render.setParams({ waves: { windSpeed: 5, peakWavelength: 30 } }));
    await page.evaluate(() => window.__render.screenshotReady());
    const counts = await page.evaluate(() => {
      const [ix, iz] = window.__render.island();
      const isWhite = (rgb: [number, number, number]) => rgb[0] > 200 && rgb[1] > 200 && rgb[2] > 200;
      let shore = 0;
      let open = 0;
      let n = 0;
      // Along the camera-facing (+z) shore: find the waterline per x, then
      // compare the pixel 1.5 m seaward of it with one 200 m further out.
      for (let x = ix - 120; x <= ix + 120; x += 6) {
        let zc: number | null = null;
        for (let z = iz + 120; z <= iz + 260; z += 1) {
          if (window.__render.terrainHeight(x, z) < 0) {
            zc = z;
            break;
          }
        }
        if (zc === null) continue;
        const a = window.__render.project(x, 0, zc + 1.5);
        const b = window.__render.project(x, 0, zc + 200);
        if (!a || !b) continue;
        n++;
        if (isWhite(window.__render.pixel(a[0], a[1]))) shore++;
        if (isWhite(window.__render.pixel(b[0], b[1]))) open++;
      }
      return { shore, open, n };
    });
    expect(counts.n).toBeGreaterThan(10);
    expect(counts.shore, JSON.stringify(counts)).toBeGreaterThan(counts.open);
    expect(counts.shore, JSON.stringify(counts)).toBeGreaterThan(counts.n * 0.4);
    expect(errors).toEqual([]);
  });
});
