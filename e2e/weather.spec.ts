import { expect, test, type Page } from "@playwright/test";

async function ready(page: Page): Promise<void> {
  await page.evaluate(() => window.__app.ready);
}

/**
 * Vertical high-frequency energy of one screen column: high-pass the
 * luminance against a local box mean, then count the sign changes with an
 * amplitude worth calling a feature. Rain streaks are near-vertical lines
 * a pixel or two wide on a smooth sky/sea, so they multiply this count;
 * waves and foam are broad by comparison.
 */
function transitions(col: number[], half = 8, amp = 3.5): number {
  let n = 0;
  let sign = 0;
  for (let i = 0; i < col.length; i++) {
    const lo = Math.max(0, i - half);
    const hi = Math.min(col.length - 1, i + half);
    let sum = 0;
    for (let j = lo; j <= hi; j++) sum += col[j] as number;
    const hp = (col[i] as number) - sum / (hi - lo + 1);
    if (Math.abs(hp) < amp) continue;
    const s = hp > 0 ? 1 : -1;
    if (sign !== 0 && s !== sign) n++;
    sign = s;
  }
  return n;
}

/**
 * Fraction of the frame above the horizon in the Storm preset at the
 * default orbit camera: the smooth cloud deck, where rain is the only
 * high-frequency detail.
 */
const SKY_BAND = 0.3;

/** Columns clear of the mode card (left) and the panel (right). */
const COLUMNS = [0.22, 0.31, 0.40, 0.48, 0.56, 0.64, 0.70];

/**
 * Summed transition count over those columns, over the rows in
 * [`from`, `to`) of the frame. `__app.column` has one pending slot, so the
 * reads are sequential.
 */
async function verticalEnergy(page: Page, from = 0, to = 1): Promise<number> {
  let total = 0;
  for (const u of COLUMNS) {
    const col = await page.evaluate((x) => window.__app.column(x), u);
    total += transitions(col.slice(Math.floor(col.length * from), Math.floor(col.length * to)));
  }
  return total;
}

test.describe("weather: rain (spec §1.16)", () => {
  let errors: string[];

  test.beforeEach(async ({ page }) => {
    errors = [];
    page.on("console", (m) => {
      if (m.type() === "error") errors.push(m.text());
    });
    page.on("pageerror", (e) => errors.push(String(e)));
    await page.goto("/");
    await ready(page);
  });

  test("Storm rains: streaks, ripples, and more vertical detail than with it off", async ({ page }) => {
    await page.evaluate(() => window.__app.setPreset("storm"));
    await page.evaluate(() => window.__app.advance(2));
    const p = await page.evaluate(() => window.__app.params());
    expect(p.weather.rain).toBeCloseTo(0.9, 5);
    expect(p.weather.rainEnabled).toBe(true);
    const on = await page.evaluate(() => window.__app.rain());
    expect(on.intensity).toBeCloseTo(0.9, 5);
    expect(on.streaks).toBeGreaterThan(1000);
    expect(on.ripples).toBeGreaterThan(100);
    await page.screenshot({ path: "e2e/__screenshots__/rain-storm.png" });

    // Compare the *same* sea: freeze the waves (animationSpeed 0 pins the
    // surface), which leaves the rain as the only thing still moving.
    await page.evaluate(() => window.__app.setParam("waves.animationSpeed", 0));
    await page.evaluate(() => window.__app.advance(1.5));
    const wet = await verticalEnergy(page);
    // The top of the frame is the cloud deck above the horizon: a smooth
    // gradient where the streaks are the only fine detail there is. Lower
    // down, the gale's own whitecap lace is high-frequency too, so the
    // whole-frame number moves far less than this band does.
    const wetSky = await verticalEnergy(page, 0, SKY_BAND);

    await page.evaluate(() => window.__app.setParam("weather.rainEnabled", false));
    await page.evaluate(() => window.__app.advance(0.5));
    const off = await page.evaluate(() => window.__app.rain());
    expect(off.intensity).toBe(0);
    expect(off.streaks).toBe(0);
    expect(off.ripples).toBe(0);
    const dry = await verticalEnergy(page);
    const drySky = await verticalEnergy(page, 0, SKY_BAND);

    expect(wetSky, `sky band: wet ${wetSky} vs dry ${drySky}`).toBeGreaterThan(drySky * 1.6);
    expect(wet, `whole frame: wet ${wet} vs dry ${dry}`).toBeGreaterThan(dry * 1.1);
    expect(errors).toEqual([]);
  });

  test("the Rain toggle and slider drive the params; off on Low", async ({ page }) => {
    const cb = page.locator('[data-testid="rain"]');
    await expect(cb).toBeChecked();
    await cb.uncheck();
    expect((await page.evaluate(() => window.__app.params())).weather.rainEnabled).toBe(false);
    await cb.check();
    expect((await page.evaluate(() => window.__app.params())).weather.rainEnabled).toBe(true);

    // The slider is the intensity; Storm sets it to 90 %.
    await page.getByTestId("preset").selectOption("storm");
    await page.evaluate(() => window.__app.frame());
    await expect(page.getByTestId("rainAmount-value")).toHaveText("90%");
    await page.getByTestId("rainAmount").fill("0.4");
    await page.getByTestId("rainAmount").dispatchEvent("input");
    await page.evaluate(() => window.__app.advance(0.5));
    expect((await page.evaluate(() => window.__app.params())).weather.rain).toBeCloseTo(0.4, 5);
    const some = await page.evaluate(() => window.__app.rain());
    expect(some.intensity).toBeCloseTo(0.4, 5);

    await page.evaluate(() => window.__app.setQuality("low"));
    await page.evaluate(() => window.__app.advance(0.5));
    await expect(cb).toBeDisabled();
    expect((await page.evaluate(() => window.__app.rain())).intensity).toBe(0);
    expect(errors).toEqual([]);
  });

  test("Foggy drizzles; the curtain is hidden underwater", async ({ page }) => {
    await page.evaluate(() => window.__app.setPreset("foggy"));
    await page.evaluate(() => window.__app.advance(2));
    expect((await page.evaluate(() => window.__app.params())).weather.rain).toBeCloseTo(0.25, 5);
    const above = await page.evaluate(() => window.__app.rain());
    expect(above.streaks).toBeGreaterThan(0);

    await page.evaluate(() => window.__app.setCameraPosition([0, -6, 40]));
    await page.evaluate(() => window.__app.advance(0.5));
    expect(await page.evaluate(() => window.__app.underwater())).toBe(true);
    // The pool keeps running (the surface above is still being rained on);
    // the curtain itself is not drawn.
    expect((await page.evaluate(() => window.__app.rain())).streaks).toBe(0);
    expect(errors).toEqual([]);
  });
});
