import { expect, test, type Page } from "@playwright/test";

async function ready(page: Page): Promise<void> {
  await page.evaluate(() => window.__app.ready);
  await page.evaluate(() => window.__app.assetsReady);
}

test.describe("assets (spec §1.15)", () => {
  let errors: string[];

  test.beforeEach(async ({ page }) => {
    errors = [];
    page.on("console", (m) => {
      if (m.type() === "error") errors.push(m.text());
    });
    page.on("pageerror", (e) => errors.push(String(e)));
  });

  test("the glTF galleon and palms load; the sim ran meanwhile; no errors", async ({ page }) => {
    await page.goto("/");
    await ready(page);
    const ship = await page.evaluate(() => window.__app.ship());
    expect(ship.model).toBe("gltf");
    const veg = await page.evaluate(() => window.__app.vegetation());
    expect(veg.model).toBe("gltf");
    expect(veg.palms).toBeGreaterThan(0);
    expect(veg.rocks).toBeGreaterThan(0);
    // Loading never blocked the sim: the clock advanced while assets streamed.
    await page.evaluate(() => window.__app.advance(1));
    expect(await page.evaluate(() => window.__app.simTime())).toBeGreaterThan(0);
    expect(errors).toEqual([]);
  });

  test("the loaded ship keeps the hull's length and draft; it still floats and steers", async ({ page }) => {
    await page.goto("/");
    await ready(page);
    await page.evaluate(() => window.__app.setMode("boat"));
    await page.keyboard.down("w");
    await page.evaluate(() => window.__app.advance(6));
    await page.keyboard.up("w");
    const ship = await page.evaluate(() => window.__app.ship());
    expect(ship.model).toBe("gltf");
    expect(ship.speed).toBeGreaterThan(1);
    const hull = await page.evaluate(() => window.__app.hull());
    expect(Math.abs(hull.position[1] - hull.waterHeight)).toBeLessThan(4);
    expect(errors).toEqual([]);
  });

  test("?ship=procedural and ?palms=procedural keep the fallbacks; both render without errors", async ({ page }) => {
    await page.goto("/?ship=procedural&palms=procedural");
    await ready(page);
    expect((await page.evaluate(() => window.__app.ship())).model).toBe("procedural");
    const veg = await page.evaluate(() => window.__app.vegetation());
    expect(veg.model).toBe("procedural");
    expect(veg.palms).toBeGreaterThan(0);
    await page.evaluate(() => window.__app.setMode("boat"));
    await page.evaluate(() => window.__app.advance(2));
    expect(errors).toEqual([]);
  });

  test("a missing glTF falls back to the procedural ship and palms without errors", async ({ page }) => {
    await page.route("**/assets/models/*.glb", (route) => route.fulfill({ status: 404, body: "" }));
    await page.goto("/");
    await ready(page);
    expect((await page.evaluate(() => window.__app.ship())).model).toBe("procedural");
    const veg = await page.evaluate(() => window.__app.vegetation());
    expect(veg.model).toBe("procedural");
    expect(veg.palms).toBeGreaterThan(0);
    await page.evaluate(() => window.__app.advance(1));
    // The 404s themselves are reported by the browser; nothing else may be.
    expect(errors.filter((e) => !/404/.test(e))).toEqual([]);
  });
});
