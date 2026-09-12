import { expect, test, type Page } from "@playwright/test";
import { INITIAL_PRESET, PRESET_NAMES, presetParams } from "../src/app/presets";
import { DEFAULT_PARAMS } from "../src/core/params";
import { formatTime } from "../src/app/gui";
import { LOADING_MESSAGES } from "../src/app/loading";

const TIERS = ["low", "medium", "high", "ultra", "max"] as const;

async function ready(page: Page): Promise<void> {
  await page.evaluate(() => window.__app.ready);
}

test.describe("demo app", () => {
  let errors: string[];

  test.beforeEach(async ({ page }) => {
    errors = [];
    page.on("console", (m) => {
      if (m.type() === "error") errors.push(m.text());
    });
    page.on("pageerror", (e) => errors.push(String(e)));
    await page.goto("/");
  });

  test("loading overlay shows the five messages in order, then disappears", async ({ page }) => {
    await ready(page);
    const log = await page.locator('[data-testid="loading-log"] li').allTextContents();
    expect(log).toEqual([...LOADING_MESSAGES]);
    await expect(page.getByTestId("loading")).toBeHidden();
    expect(errors).toEqual([]);
  });

  test("unsupported GPU (no EXT_color_buffer_float): the overlay says so instead of a black canvas", async ({ page }) => {
    await page.addInitScript(() => {
      const proto = WebGL2RenderingContext.prototype as unknown as { getExtension: (name: string) => unknown };
      const orig = proto.getExtension;
      proto.getExtension = function (this: WebGL2RenderingContext, name: string) {
        return name === "EXT_color_buffer_float" ? null : orig.call(this, name);
      };
    });
    await page.goto("/");
    await page.evaluate(() => window.__app.ready.catch(() => undefined));
    await expect(page.getByTestId("loading")).toBeVisible();
    await expect(page.getByTestId("loading-message")).toHaveText(/float render targets/i);
    await expect(page.getByTestId("loading")).toHaveAttribute("data-state", "failed");
  });

  test("WebGL context loss: the app pauses, then rebuilds and renders again on restore", async ({ page }) => {
    await ready(page);
    for (let i = 0; i < 3; i++) await page.evaluate(() => window.__app.frame());
    // The extension object must be fetched before the loss: a lost context
    // returns null from getExtension, so keep it on the window for the restore.
    await page.evaluate(() => {
      const canvas = document.getElementById("canvas") as HTMLCanvasElement;
      const gl = canvas.getContext("webgl2") as WebGL2RenderingContext;
      const ext = gl.getExtension("WEBGL_lose_context");
      if (!ext) throw new Error("WEBGL_lose_context unavailable");
      (window as unknown as { __loseExt: WEBGL_lose_context }).__loseExt = ext;
      ext.loseContext();
    });
    await page.waitForFunction(() => window.__app.contextLost());
    await expect(page.getByTestId("hud-gpu")).toHaveText(/context lost/i);
    // Frames keep resolving while lost (nothing hangs).
    for (let i = 0; i < 3; i++) await page.evaluate(() => window.__app.frame());
    await page.evaluate(() => (window as unknown as { __loseExt: WEBGL_lose_context }).__loseExt.restoreContext());
    await page.waitForFunction(() => !window.__app.contextLost());
    await expect(page.getByTestId("rebuilding")).toBeHidden({ timeout: 30_000 });
    for (let i = 0; i < 6; i++) await page.evaluate(() => window.__app.frame());
    await expect(page.getByTestId("hud-gpu")).toHaveText(/WebGL2/);
    const centre = await page.evaluate(() => window.__app.pixel(0.5, 0.6));
    expect(centre[0]! + centre[1]! + centre[2]!, `centre pixel ${centre}`).toBeGreaterThan(30);
    expect(centre[2]!).toBeGreaterThan(centre[0]!);
    // Sky, sim and foam all came back: the frame keeps changing.
    await page.evaluate(() => window.__app.snapshot("a"));
    for (let i = 0; i < 4; i++) await page.evaluate(() => window.__app.frame());
    await page.evaluate(() => window.__app.snapshot("b"));
    expect(await page.evaluate(() => window.__app.diff("a", "b"))).toBeGreaterThan(0.2);
    expect(await page.evaluate(() => window.__app.params().quality)).toBe("high");
    expect(errors).toEqual([]);
  });

  test("HUD FPS becomes numeric; no console errors", async ({ page }) => {
    await ready(page);
    await expect(page.getByTestId("hud-fps")).toHaveText(/FPS \d+/, { timeout: 5000 });
    const text = await page.getByTestId("hud-fps").textContent();
    const fps = Number(text?.replace("FPS", "").trim());
    expect(Number.isFinite(fps)).toBe(true);
    expect(fps).toBeGreaterThan(0);
    await expect(page.getByTestId("hud-gpu")).toHaveText(/WebGL2/);
    await expect(page.getByTestId("hud-dpr")).toHaveText(/DPR 1\.00/);
    expect(errors).toEqual([]);
  });

  test("panel values are formatted", async ({ page }) => {
    await ready(page);
    const p = presetParams(INITIAL_PRESET, DEFAULT_PARAMS);
    await expect(page.getByTestId("windSpeed-value")).toHaveText(`${p.waves.windSpeed.toFixed(1)} m/s`);
    await expect(page.getByTestId("peakWavelength-value")).toHaveText(`${Math.round(p.waves.peakWavelength)} m`);
    await expect(page.getByTestId("timeOfDay-value")).toHaveText(formatTime(p.sky.timeOfDay));
    await expect(page.getByTestId("cloudCoverage-value")).toHaveText(`${Math.round(p.sky.cloudCoverage * 100)}%`);
    await expect(page.getByTestId("pixelRatio-value")).toHaveText("1.00×");
    await expect(page.getByTestId("forceWebgl")).toBeDisabled();
    await expect(page.getByTestId("forceWebgl")).toBeChecked();
  });

  test("every preset renders, screenshots differ from the previous", async ({ page }) => {
    test.setTimeout(180_000);
    await ready(page);
    let prev: string | null = null;
    for (const name of PRESET_NAMES) {
      await page.getByTestId("preset").selectOption(name);
      await page.evaluate(() => window.__app.frame());
      expect(await page.evaluate(() => window.__app.preset())).toBe(name);
      // Let the sim + foam settle a few frames before the capture.
      for (let i = 0; i < 6; i++) await page.evaluate(() => window.__app.frame());
      await page.evaluate((n) => window.__app.snapshot(n), name);
      await page.screenshot({ path: `e2e/__screenshots__/preset-${name}.png` });
      if (prev) {
        const diff = await page.evaluate(([a, b]) => window.__app.diff(a!, b!), [prev, name]);
        expect(diff, `${prev} vs ${name}`).toBeGreaterThan(1);
      }
      prev = name;
    }
    expect(errors).toEqual([]);
  });

  test("every quality tier renders with draws > 0", async ({ page }) => {
    test.setTimeout(180_000);
    await ready(page);
    const tris: Record<string, number> = {};
    for (const tier of TIERS) {
      await page.getByTestId("quality").selectOption(tier);
      await expect(page.getByTestId("rebuilding")).toBeHidden({ timeout: 30_000 });
      for (let i = 0; i < 3; i++) await page.evaluate(() => window.__app.frame());
      expect(await page.evaluate(() => window.__app.params().quality)).toBe(tier);
      // Stats refresh every 250 ms; wait for a flush.
      await page.waitForTimeout(300);
      await page.evaluate(() => window.__app.frame());
      const stats = await page.evaluate(() => window.__app.stats());
      expect(stats.draws, tier).toBeGreaterThan(0);
      expect(stats.tris, tier).toBeGreaterThan(0);
      tris[tier] = stats.tris;
      // The tier must actually render (no black cascade slots).
      const centre = await page.evaluate(() => window.__app.pixel(0.5, 0.5));
      expect(centre[0]! + centre[1]! + centre[2]!, `${tier} centre pixel`).toBeGreaterThan(30);
      expect(errors, tier).toEqual([]);
    }
    // Tiers differ in clipmap density (16 → 64 segments per ring).
    expect(tris.low!).toBeLessThan(tris.high!);
    expect(tris.medium!).toBeLessThan(tris.high!);
  });

  test("dragging the canvas changes pixels (orbit)", async ({ page }) => {
    await ready(page);
    await page.evaluate(() => window.__app.snapshot("before"));
    await page.mouse.move(640, 400);
    await page.mouse.down();
    await page.mouse.move(400, 300, { steps: 10 });
    await page.mouse.up();
    for (let i = 0; i < 5; i++) await page.evaluate(() => window.__app.frame());
    await page.evaluate(() => window.__app.snapshot("after"));
    const diff = await page.evaluate(() => window.__app.diff("before", "after"));
    expect(diff).toBeGreaterThan(1);
    expect(errors).toEqual([]);
  });

  test("__app.step / advance drive the sim by exact fixed dts, then RAF resumes", async ({ page }) => {
    await ready(page);
    // (Measured inside one evaluate: the live loop ticks between round trips.)
    const stepped = await page.evaluate(async () => {
      const t0 = window.__app.simTime();
      await window.__app.step(0.25, 4);
      return window.__app.simTime() - t0;
    });
    expect(stepped).toBeCloseTo(1, 6);
    const advanced = await page.evaluate(async () => {
      const t0 = window.__app.simTime();
      await window.__app.advance(2);
      return window.__app.simTime() - t0;
    });
    expect(advanced).toBeCloseTo(2, 6);
    // Driven ticks render (snapshots are taken inside them) and the live
    // loop is back afterwards: frame() resolves on its own.
    await page.evaluate(() => window.__app.snapshot("a"));
    await page.evaluate(() => window.__app.advance(1));
    await page.evaluate(() => window.__app.snapshot("b"));
    expect(await page.evaluate(() => window.__app.diff("a", "b"))).toBeGreaterThan(0.2);
    await page.evaluate(() => window.__app.frame());
    expect(await page.evaluate(() => window.__app.step(1, 0).then(() => "ok"))).toBe("ok");
    expect(errors).toEqual([]);
  });

  test("fly mode: key 2 then W moves the camera", async ({ page }) => {
    await ready(page);
    await page.keyboard.press("2");
    await page.evaluate(() => window.__app.frame());
    const before = await page.evaluate(() => window.__app.camera());
    expect(before.mode).toBe("fly");
    await page.keyboard.down("w");
    await page.evaluate(() => window.__app.advance(0.5));
    await page.keyboard.up("w");
    const after = await page.evaluate(() => window.__app.camera());
    const dist = Math.hypot(
      after.position[0] - before.position[0],
      after.position[1] - before.position[1],
      after.position[2] - before.position[2],
    );
    expect(dist).toBeGreaterThan(1);
    expect(errors).toEqual([]);
  });

  test("boat mode: hull sits within 2 m of the water height", async ({ page }) => {
    await ready(page);
    await page.keyboard.press("3");
    for (let i = 0; i < 20; i++) await page.evaluate(() => window.__app.frame());
    const cam = await page.evaluate(() => window.__app.camera());
    expect(cam.mode).toBe("boat");
    const hull = await page.evaluate(() => window.__app.hull());
    expect(Math.abs(hull.position[1] - hull.waterHeight)).toBeLessThan(2);
    // Throttle forward; the ship (500 t, so it takes a moment) should move.
    await page.keyboard.down("w");
    await page.evaluate(() => window.__app.advance(1.5));
    await page.keyboard.up("w");
    const moved = await page.evaluate(() => window.__app.hull());
    expect(Math.hypot(moved.position[0] - hull.position[0], moved.position[2] - hull.position[2])).toBeGreaterThan(0.5);
    expect(Math.abs(moved.position[1] - moved.waterHeight)).toBeLessThan(2);
    // Let the wake and the sea settle in behind her for the screenshot.
    await page.keyboard.down("w");
    await page.evaluate(() => window.__app.advance(3));
    await page.keyboard.up("w");
    await page.screenshot({ path: "e2e/__screenshots__/mode-boat.png" });
    expect(errors).toEqual([]);
  });

  test("ship: dropped from 2 m it settles on the water, upright, within 5 s", async ({ page }) => {
    await ready(page);
    await page.evaluate(() => window.__app.setMode("boat"));
    const start = await page.evaluate(() => window.__app.hull());
    expect(start.position[1] - start.waterHeight).toBeGreaterThan(1);
    await page.evaluate(() => window.__app.advance(5));
    const hull = await page.evaluate(() => window.__app.hull());
    const ship = await page.evaluate(() => window.__app.ship());
    expect(Math.abs(hull.position[1] - hull.waterHeight)).toBeLessThan(0.8);
    expect(Math.abs(ship.roll)).toBeLessThan((10 * Math.PI) / 180);
    expect(Math.abs(ship.pitch)).toBeLessThan((10 * Math.PI) / 180);
    expect(errors).toEqual([]);
  });

  test("ship: W throttles past 3 m/s in 3 s; A turns to port", async ({ page }) => {
    await ready(page);
    await page.evaluate(() => window.__app.setMode("boat"));
    await page.evaluate(() => window.__app.advance(1));
    await page.keyboard.down("w");
    await page.evaluate(() => window.__app.advance(3));
    const cruising = await page.evaluate(() => window.__app.ship());
    expect(cruising.speed).toBeGreaterThan(3);
    expect(Math.abs(cruising.heading)).toBeLessThan(0.05);
    await page.keyboard.down("a");
    await page.evaluate(() => window.__app.advance(2.5));
    await page.keyboard.up("a");
    await page.keyboard.up("w");
    const turned = await page.evaluate(() => window.__app.ship());
    expect(turned.heading).toBeGreaterThan(0.15);
    expect(errors).toEqual([]);
  });

  test("ship: the Buoyancy Probes overlay renders without errors", async ({ page }) => {
    await ready(page);
    await page.evaluate(() => window.__app.setMode("boat"));
    await page.getByTestId("buoyancyProbes").check();
    await page.evaluate(() => window.__app.advance(1.5));
    await page.evaluate(() => window.__app.snapshot("on"));
    await page.getByTestId("buoyancyProbes").uncheck();
    for (let i = 0; i < 3; i++) await page.evaluate(() => window.__app.frame());
    await page.evaluate(() => window.__app.snapshot("off"));
    await page.getByTestId("buoyancyProbes").check();
    for (let i = 0; i < 3; i++) await page.evaluate(() => window.__app.frame());
    await page.screenshot({ path: "e2e/__screenshots__/mode-boat-buoyancy-probes.png" });
    // The overlay changes the frame.
    expect(await page.evaluate(() => window.__app.diff("on", "off"))).toBeGreaterThan(0.05);
    expect(errors).toEqual([]);
  });

  test("boat mode: the wake field rises behind a moving hull, not ahead of it", async ({ page }) => {
    await ready(page);
    await page.keyboard.press("3");
    for (let i = 0; i < 5; i++) await page.evaluate(() => window.__app.frame());
    // Heading 0 = −z: the hull travels towards −z, the wake trails at +z.
    await page.keyboard.down("w");
    await page.evaluate(() => window.__app.advance(2));
    await page.keyboard.up("w");
    const behind = await page.evaluate(() => window.__app.wakeSample(0, 8));
    const flank = await page.evaluate(() => window.__app.wakeSample(4, 14));
    const ahead = await page.evaluate(() => window.__app.wakeSample(0, -100));
    expect(Math.abs(behind.height) > 0.01 || behind.foam > 0).toBe(true);
    expect(behind.foam).toBeGreaterThan(0);
    expect(Math.abs(flank.height) > 0.01 || flank.foam > 0).toBe(true);
    expect(Math.abs(ahead.height)).toBeLessThan(0.001);
    expect(ahead.foam).toBeLessThan(0.001);
    await page.screenshot({ path: "e2e/__screenshots__/mode-boat-wake.png" });
    // The debug overlay draws without errors.
    await page.getByTestId("wakeProbes").check();
    for (let i = 0; i < 3; i++) await page.evaluate(() => window.__app.frame());
    await page.screenshot({ path: "e2e/__screenshots__/mode-boat-wake-probes.png" });
    expect(errors).toEqual([]);
  });

  test("underwater: camera at y = -5 sees water, not sky", async ({ page }) => {
    await ready(page);
    await page.evaluate(() => window.__app.setCameraPosition([0, -5, 0]));
    for (let i = 0; i < 8; i++) await page.evaluate(() => window.__app.frame());
    expect(await page.evaluate(() => window.__app.underwater())).toBe(true);
    await page.keyboard.press("h");
    await page.evaluate(() => window.__app.frame());
    await page.screenshot({ path: "e2e/__screenshots__/underwater.png" });
    // The frame is dominated by the water hue.
    let r = 0;
    let g = 0;
    let b = 0;
    const grid = 6;
    for (let y = 0; y < grid; y++) {
      for (let x = 0; x < grid; x++) {
        const px = await page.evaluate(([u, v]) => window.__app.pixel(u!, v!), [(x + 0.5) / grid, (y + 0.5) / grid]);
        r += px[0]!;
        g += px[1]!;
        b += px[2]!;
      }
    }
    expect(b, `mean rgb ${r}/${g}/${b}`).toBeGreaterThan(r);
    expect(g + b).toBeGreaterThan(grid * grid * 20);
    // The sky is not visible: no top-row pixel is bright sky blue.
    for (let x = 0; x < grid; x++) {
      const px = await page.evaluate(([u]) => window.__app.pixel(u!, 0.01), [(x + 0.5) / grid]);
      const bright = px[2]! > 170 && px[1]! > 150 && px[0]! > 100;
      expect(bright, `top-row pixel ${x}: ${px.join(",")}`).toBe(false);
    }
    expect(errors).toEqual([]);
  });

  test("underwater sun shafts: brighter cone around the sun with shafts on; off at night", async ({ page }) => {
    await ready(page);
    await page.evaluate(() => window.__app.setCameraPosition([0, -4, 0]));
    for (let i = 0; i < 4; i++) await page.evaluate(() => window.__app.frame());
    expect(await page.evaluate(() => window.__app.underwater())).toBe(true);
    // Look toward the refracted sun, a little below it so it sits in the upper frame.
    const sunDir = await page.evaluate(() => window.__app.sunShafts().sunDir);
    const h = Math.hypot(sunDir[0], sunDir[2]);
    const look: [number, number, number] = [sunDir[0] / h, 0.7, sunDir[2] / h];
    await page.evaluate((d) => window.__app.setCameraDirection(d), look);
    await page.keyboard.press("h");
    for (let i = 0; i < 3; i++) await page.evaluate(() => window.__app.frame());
    const state = await page.evaluate(() => window.__app.sunShafts());
    expect(state.strength).toBeGreaterThan(0.2);
    expect(state.sunUv[0]).toBeGreaterThan(0.2);
    expect(state.sunUv[0]).toBeLessThan(0.8);
    expect(state.sunUv[1]).toBeGreaterThan(0);
    expect(state.sunUv[1]).toBeLessThan(0.5);
    await page.screenshot({ path: "e2e/__screenshots__/underwater-shafts.png" });
    await page.keyboard.press("h");

    // Mean luminance in a cone (disc) around the sun's screen position.
    const cone = async (): Promise<number> => {
      let sum = 0;
      let n = 0;
      for (let y = -3; y <= 3; y++) {
        for (let x = -3; x <= 3; x++) {
          if (x * x + y * y > 10) continue;
          const u = Math.min(0.99, Math.max(0.01, state.sunUv[0] + x * 0.04));
          const v = Math.min(0.99, Math.max(0.01, state.sunUv[1] + y * 0.04));
          const px = await page.evaluate(([a, b]) => window.__app.pixel(a!, b!), [u, v]);
          sum += 0.2126 * px[0]! + 0.7152 * px[1]! + 0.0722 * px[2]!;
          n++;
        }
      }
      return sum / n;
    };
    const withShafts = await cone();
    await page.getByTestId("sunShafts").uncheck({ force: true });
    for (let i = 0; i < 2; i++) await page.evaluate(() => window.__app.frame());
    expect((await page.evaluate(() => window.__app.params())).underwater.sunShafts).toBe(false);
    expect((await page.evaluate(() => window.__app.sunShafts())).strength).toBe(0);
    const without = await cone();
    expect(withShafts, `cone luminance on ${withShafts} vs off ${without}`).toBeGreaterThan(without + 8);

    // Night: no sun, no shafts, even with the toggle on.
    await page.getByTestId("sunShafts").check({ force: true });
    await page.evaluate(() => window.__app.setParam("sky.timeOfDay", 1));
    for (let i = 0; i < 2; i++) await page.evaluate(() => window.__app.frame());
    expect((await page.evaluate(() => window.__app.sunShafts())).strength).toBe(0);
    expect(errors).toEqual([]);
  });

  test("key H hides the panel", async ({ page }) => {
    await ready(page);
    await expect(page.locator(".panel")).toBeVisible();
    await page.keyboard.press("h");
    await expect(page.locator(".panel")).toBeHidden();
    await page.keyboard.press("h");
    await expect(page.locator(".panel")).toBeVisible();
  });

  test("window resize updates the canvas size", async ({ page }) => {
    await ready(page);
    const before = await page.evaluate(() => {
      const c = document.getElementById("canvas") as HTMLCanvasElement;
      return [c.width, c.height];
    });
    expect(before).toEqual([1280, 800]);
    await page.setViewportSize({ width: 900, height: 600 });
    await page.evaluate(() => window.__app.frame());
    const after = await page.evaluate(() => {
      const c = document.getElementById("canvas") as HTMLCanvasElement;
      return [c.width, c.height];
    });
    expect(after).toEqual([900, 600]);
    expect(errors).toEqual([]);
  });

  test("quality change shows the rebuilding pill", async ({ page }) => {
    await ready(page);
    await page.getByTestId("quality").selectOption("low");
    await expect(page.getByTestId("rebuilding")).toBeVisible();
    await expect(page.getByTestId("rebuilding")).toBeHidden({ timeout: 30_000 });
    expect(await page.evaluate(() => window.__app.params().quality)).toBe("low");
    expect(errors).toEqual([]);
  });
  test("island: the default view shows the island with a turquoise shore (island.png)", async ({ page }) => {
    await ready(page);
    await page.evaluate(() => window.__app.setPreset("fairWeather"));
    await page.keyboard.press("h");
    for (let i = 0; i < 8; i++) await page.evaluate(() => window.__app.frame());
    await page.screenshot({ path: "e2e/__screenshots__/island.png" });
    // The island sits on the horizon just left of centre (spec §1.11): a
    // pixel a little below its summit is warm rock, not blue sea or sky.
    const rock = await page.evaluate(() => window.__app.pixel(0.4, 0.2));
    expect(rock[0]!, `island pixel ${rock.join(",")}`).toBeGreaterThanOrEqual(rock[2]!);
    // The horizon either side of it is still sea/sky blue.
    const sea = await page.evaluate(() => window.__app.pixel(0.9, 0.3));
    expect(sea[2]!, `sea pixel ${sea.join(",")}`).toBeGreaterThan(sea[0]!);
    expect(errors).toEqual([]);
  });
  test("ssr: the hull is reflected in a calm sea below its waterline; toggle off restores the sky", async ({ page }) => {
    await ready(page);
    await page.evaluate(() => window.__app.setParam("waves.windSpeed", 4));
    await page.evaluate(() => window.__app.setMode("boat"));
    await page.keyboard.press("h");
    for (let i = 0; i < 90; i++) await page.evaluate(() => window.__app.frame());
    expect(await page.evaluate(() => window.__app.params().fresnel.ssr)).toBe(true);
    await expect(page.getByTestId("ssr")).toBeChecked();
    // A band of water just below the hull's waterline (the chase camera is
    // fixed astern, the sea is calm): with SSR the hull's planking is
    // mirrored there (and seen through the water), so the band is darker
    // and browner than the sky-blue it reflects with SSR off.
    const band = async (): Promise<{ rb: number; lum: number }> => {
      const px: [number, number, number, number][] = [];
      for (const v of [0.72, 0.75, 0.78]) {
        for (let i = 0; i < 8; i++) px.push(await page.evaluate(([u, v]) => window.__app.pixel(u!, v!), [0.4 + i * 0.02, v]));
      }
      const mean = (f: (p: [number, number, number, number]) => number): number => px.reduce((s, p) => s + f(p), 0) / px.length;
      return { rb: mean((p) => p[0] - p[2]), lum: mean((p) => 0.2126 * p[0] + 0.7152 * p[1] + 0.0722 * p[2]) };
    };
    const on = await band();
    await page.screenshot({ path: "e2e/__screenshots__/mode-boat-ssr.png" });
    await page.evaluate(() => window.__app.setParam("fresnel.ssr", false));
    for (let i = 0; i < 3; i++) await page.evaluate(() => window.__app.frame());
    await expect(page.getByTestId("ssr")).not.toBeChecked();
    const off = await band();
    expect(on.lum, `luminance on ${on.lum} vs off ${off.lum}`).toBeLessThan(off.lum - 10);
    expect(on.rb, `R-B on ${on.rb} vs off ${off.rb}`).toBeGreaterThan(off.rb + 5);
    // Low tier forces it off and greys the control.
    await page.evaluate(() => window.__app.setQuality("low"));
    await expect(page.getByTestId("ssr")).toBeDisabled();
    expect(errors).toEqual([]);
  });
});
