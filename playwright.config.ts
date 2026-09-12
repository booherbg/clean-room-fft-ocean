import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { defineConfig } from '@playwright/test';

// Headless Chromium on this Mac exposes hardware WebGL2 (ANGLE Metal) but no
// WebGPU. The new headless mode is required for the GPU process; the default
// "headless shell" also works but the full binary is what we measured with.
//
// Which binary, in order: $CHROME_PATH, else the Chrome for Testing build the
// numbers in docs/perf.md were taken against if it happens to be installed,
// else none — Playwright then launches its own bundled chromium, which is the
// right answer on any machine but this one.
const MEASURED_CHROME = join(
  homedir(),
  'Library/Caches/ms-playwright/chromium-1243/chrome-mac-arm64',
  'Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
);
const CHROME = process.env.CHROME_PATH ?? (existsSync(MEASURED_CHROME) ? MEASURED_CHROME : undefined);

export default defineConfig({
  testDir: 'e2e',
  timeout: 90_000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:5178',
    viewport: { width: 1280, height: 800 },
    launchOptions: {
      ...(CHROME ? { executablePath: CHROME } : {}),
      args: ['--use-angle=metal', '--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--headless=new'],
      ignoreDefaultArgs: ['--headless'],
    },
  },
  webServer: {
    command: 'npx vite --port 5178 --strictPort',
    port: 5178,
    reuseExistingServer: true,
    timeout: 30_000,
  },
});
