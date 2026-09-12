import { expect, test, type Page } from "@playwright/test";

async function ready(page: Page): Promise<void> {
  await page.evaluate(() => window.__app.ready);
}

test.describe("spray (spec §1.14)", () => {
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

  test("storm: crests throw spray; it brightens the near sea; off leaves none", async ({ page }) => {
    await page.evaluate(() => window.__app.setPreset("storm"));
    await page.evaluate(() => window.__app.advance(3));
    const counts = await page.evaluate(() => window.__app.spray());
    expect(counts.alive).toBeGreaterThan(0);
    expect(counts.crest).toBeGreaterThan(0);
    expect(counts.bow).toBe(0);
    expect(counts.alive).toBeLessThanOrEqual(counts.capacity);
    await page.screenshot({ path: "e2e/__screenshots__/spray-storm.png" });

    // Spray changes the picture of the *same* sea: freeze the waves
    // (animationSpeed 0 pins the surface at t = 0), let the crests of that
    // frozen sea throw spray, snapshot, switch spray off, snapshot again.
    // Storm rains (spec §1.16) and the curtain never freezes, so it is
    // switched off too — this test is about the spray, not the weather.
    await page.evaluate(() => window.__app.setParam("weather.rainEnabled", false));
    await page.evaluate(() => window.__app.setParam("waves.animationSpeed", 0));
    await page.evaluate(() => window.__app.advance(2));
    expect((await page.evaluate(() => window.__app.spray())).alive).toBeGreaterThan(0);
    await page.evaluate(() => window.__app.snapshot("spray"));
    await page.evaluate(() => window.__app.setParam("spray.enabled", false));
    await page.evaluate(() => window.__app.step(1 / 60, 3));
    const off = await page.evaluate(() => window.__app.spray());
    expect(off.alive).toBe(0);
    await page.evaluate(() => window.__app.snapshot("none"));
    await page.evaluate(() => window.__app.step(1 / 60, 3));
    await page.evaluate(() => window.__app.snapshot("none2"));
    // A frozen sea still drifts a little frame to frame (foam settling);
    // the spray must change the picture far more than that drift.
    const drift = await page.evaluate(() => window.__app.diff("none", "none2"));
    const sprayDiff = await page.evaluate(() => window.__app.diff("spray", "none"));
    expect(sprayDiff).toBeGreaterThan(Math.max(0.05, 3 * drift));
    expect(errors).toEqual([]);
  });

  test("boat: W for 3 s throws bow spray", async ({ page }) => {
    await page.click('[data-testid="mode-boat"]');
    await page.evaluate(() => window.__app.advance(1.5));
    await page.keyboard.down("w");
    await page.evaluate(() => window.__app.advance(3));
    const counts = await page.evaluate(() => window.__app.spray());
    const ship = await page.evaluate(() => window.__app.ship());
    expect(ship.speed).toBeGreaterThan(2);
    expect(counts.bow).toBeGreaterThan(0);
    await page.screenshot({ path: "e2e/__screenshots__/spray-bow.png" });
    await page.keyboard.up("w");
    expect(errors).toEqual([]);
  });

  test("the panel toggle is wired and disabled on Low", async ({ page }) => {
    const cb = page.locator('[data-testid="spray"]');
    await expect(cb).toBeChecked();
    await cb.uncheck();
    expect((await page.evaluate(() => window.__app.params())).spray.enabled).toBe(false);
    await page.evaluate(() => window.__app.setQuality("low"));
    await expect(cb).toBeDisabled();
    expect((await page.evaluate(() => window.__app.spray())).alive).toBe(0);
    expect(errors).toEqual([]);
  });
});
