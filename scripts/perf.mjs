#!/usr/bin/env node
/**
 * Headless perf sweep: FPS / frame time per quality tier at 1280×800, DPR 1.
 *
 *   node scripts/perf.mjs            # vsync-limited (as the e2e tests run)
 *   node scripts/perf.mjs --unlocked # + --disable-frame-rate-limit --disable-gpu-vsync
 *   node scripts/perf.mjs --settle 1000 --sample 3000
 *   node scripts/perf.mjs --url http://localhost:5179   # e.g. `vite preview` of a build,
 *                                                       # immune to dev-server hot reloads
 *   node scripts/perf.mjs --tiers medium --set fresnel.ssr=false   # override params (repeatable)
 *   node scripts/perf.mjs --gpu-timer  # also print the GPU section table (costs a few % on Metal)
 *
 * Reuses the launch options from playwright.config.ts (real WebGL2 through
 * ANGLE Metal, `--headless=new`). Starts `vite --port 5178` if nothing is
 * listening and stops it afterwards. Prints markdown tables to stdout: fps /
 * frame time per tier, then the HUD's GPU section timings when the timer
 * extension is available (`__app.stats().gpu`).
 */
import { spawn } from "node:child_process";
import { chromium } from "playwright";
import config from "../playwright.config.ts";

const args = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] !== undefined ? Number(args[i + 1]) : dflt;
};
const UNLOCKED = args.includes("--unlocked");
// GPU timer queries split the command buffer on ANGLE Metal (a few % at High+), so they are off unless asked for.
const GPU_TIMER = args.includes("--gpu-timer");
const SETTLE_MS = flag("settle", 1000);
const SAMPLE_MS = flag("sample", 3000);
const urlIdx = args.indexOf("--url");
const URL_OVERRIDE = urlIdx >= 0 ? args[urlIdx + 1] : null;
const tiersIdx = args.indexOf("--tiers");
const TIERS = tiersIdx >= 0 ? args[tiersIdx + 1].split(",") : ["low", "medium", "high", "ultra", "max"];
// --set path=value (repeatable): applied after each tier change; "true"/"false" become booleans, numerics numbers.
const SETS = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--set" && args[i + 1]) {
    const [path, raw] = args[i + 1].split("=");
    const value = raw === "true" ? true : raw === "false" ? false : Number.isFinite(Number(raw)) ? Number(raw) : raw;
    SETS.push({ path, value });
  }
}
const TIER_INFO = {
  low: { N: 256, cascades: 1 },
  medium: { N: "256/128", cascades: 2 },
  high: { N: 256, cascades: 3 },
  ultra: { N: 512, cascades: 3 },
  max: { N: 512, cascades: 3 },
};
const { viewport, launchOptions } = config.use;
const baseURL = URL_OVERRIDE ?? config.use.baseURL;

async function isUp(url) {
  try {
    return (await fetch(url)).ok;
  } catch {
    return false;
  }
}

async function ensureServer() {
  if (URL_OVERRIDE || (await isUp(baseURL))) return null;
  const child = spawn("npx", ["vite", "--port", "5178", "--strictPort"], { stdio: "ignore" });
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 500));
    if (await isUp(baseURL)) return child;
  }
  child.kill();
  throw new Error("vite did not come up on :5178");
}

const server = await ensureServer();
const extra = UNLOCKED ? ["--disable-frame-rate-limit", "--disable-gpu-vsync"] : [];
const browser = await chromium.launch({ ...launchOptions, args: [...launchOptions.args, ...extra] });
try {
  const page = await browser.newPage({ viewport, deviceScaleFactor: 1 });
  page.on("pageerror", (e) => console.error("pageerror:", e.message));
  // A Vite full reload (someone editing src/) destroys the context; retry.
  for (let attempt = 0; ; attempt++) {
    try {
      await page.goto(baseURL, { waitUntil: "load" });
      await page.evaluate(() => window.__app.ready);
      break;
    } catch (e) {
      if (attempt >= 3) throw e;
      console.error("page reloaded during boot, retrying");
    }
  }
  const gpu = await page.evaluate(() => {
    const c = document.createElement("canvas");
    const gl = c.getContext("webgl2");
    const ext = gl && gl.getExtension("WEBGL_debug_renderer_info");
    return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : "(WEBGL_debug_renderer_info unavailable)";
  });

  const rows = [];
  await page.evaluate((on) => window.__app.setGpuTimer?.(on), GPU_TIMER);
  for (const tier of TIERS) {
    await page.evaluate((t) => window.__app.setQuality(t), tier);
    for (const s of SETS) await page.evaluate(({ path, value }) => window.__app.setParam(path, value), s);
    await page.evaluate((ms) => new Promise((r) => setTimeout(r, ms)), SETTLE_MS);
    // Count frames ourselves; take draws/tris/frameMs from the HUD.
    const r = await page.evaluate(async (ms) => {
      const app = window.__app;
      const t0 = performance.now();
      let n = 0;
      let msSum = 0;
      let last = performance.now();
      while (performance.now() - t0 < ms) {
        await app.frame();
        const now = performance.now();
        msSum += now - last;
        last = now;
        n++;
      }
      const s = app.stats();
      return { fps: n / ((last - t0) / 1000), wallMs: msSum / n, cpuMs: s.frameMs, draws: s.draws, tris: s.tris, dpr: s.dpr, gpu: s.gpu };
    }, SAMPLE_MS);
    rows.push({ tier, ...TIER_INFO[tier], ...r });
    console.error(`${tier.padEnd(6)} ${r.fps.toFixed(1)} fps  ${r.wallMs.toFixed(2)} ms/frame  (cpu ${r.cpuMs.toFixed(2)} ms)`);
  }

  console.log(`GPU: ${gpu}`);
  const sets = SETS.length ? `; ${SETS.map((s) => `${s.path}=${s.value}`).join(" ")}` : "";
  console.log(`Mode: ${UNLOCKED ? "unlocked (--disable-frame-rate-limit --disable-gpu-vsync)" : "vsync (default)"}; ${viewport.width}×${viewport.height} DPR 1; settle ${SETTLE_MS} ms, sample ${SAMPLE_MS} ms${sets}; GPU timer ${GPU_TIMER ? "on" : "off"}\n`);
  console.log("| tier | N | cascades | draws | tris | fps | ms/frame (wall) | ms/frame (CPU submit) |");
  console.log("|---|---|---|---|---|---|---|---|");
  for (const r of rows) {
    console.log(
      `| ${r.tier} | ${r.N} | ${r.cascades} | ${r.draws} | ${r.tris.toLocaleString("en-US")} | ${r.fps.toFixed(1)} | ${r.wallMs.toFixed(2)} | ${r.cpuMs.toFixed(2)} |`,
    );
  }
  // GPU section timings (EXT_disjoint_timer_query_webgl2), smoothed ms per section.
  const gpuRows = rows.filter((r) => r.gpu && r.gpu.supported);
  if (gpuRows.length) {
    const sections = ["spectrum", "fft", "unpack", "prepass", "water", "spray", "rain", "post"];
    console.log(`\nGPU sections (ms, EMA; floor ${gpuRows[0].gpu.floor.toFixed(2)} ms for an empty section):\n`);
    console.log(`| tier | ${sections.join(" | ")} | sum |`);
    console.log(`|---|${sections.map(() => "---").join("|")}|---|`);
    for (const r of gpuRows) {
      const v = sections.map((k) => (r.gpu.sections[k] === undefined ? "—" : r.gpu.sections[k].toFixed(2)));
      console.log(`| ${r.tier} | ${v.join(" | ")} | ${r.gpu.total.toFixed(2)} |`);
    }
  } else {
    console.log(GPU_TIMER ? "\nGPU sections: n/a (EXT_disjoint_timer_query_webgl2 unavailable)" : "\nGPU sections: off (pass --gpu-timer)");
  }
} finally {
  await browser.close();
  if (server) server.kill();
}
