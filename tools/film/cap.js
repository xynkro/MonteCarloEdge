// Deterministic frame renderer for the welcome film.
//
// scene.html exposes a pure `window.render(t)` that sets the whole visual state for any
// timestamp t (no requestAnimationFrame → frame-perfect). We launch headless Chrome, seek
// to every frame's time, and screenshot. `node cap.js probe` writes a handful of key frames
// to inspect; `node cap.js full` writes all 792 frames (30fps × 26.4s) for encoding.
//
// Requires: `npm i puppeteer-core` + a local Chrome (set CHROME=... to override the path).
const puppeteer = require("puppeteer-core");
const fs = require("fs");
const path = require("path");

const CHROME = process.env.CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const DIR = __dirname;
const FPS = 30, DUR = 26.4, N = Math.round(FPS * DUR);
const mode = process.argv[2] || "probe";

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: true,
    args: ["--no-sandbox", "--force-color-profile=srgb", "--hide-scrollbars", "--disable-gpu-vsync"],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1920, height: 1080, deviceScaleFactor: 1 });
  await page.goto("file://" + path.join(DIR, "scene.html"), { waitUntil: "networkidle0" });
  await page.evaluateHandle("document.fonts.ready");
  await new Promise((r) => setTimeout(r, 250));

  const outDir = path.join(DIR, mode === "probe" ? "probe" : "frames");
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });

  if (mode === "probe") {
    // key beats (≈ the VO onset times) — eyeball these before a full render
    const ts = [1.0, 3.0, 8.2, 10.9, 12.6, 14.2, 15.9, 17.6, 18.8, 20.4, 23.2, 24.6];
    for (let i = 0; i < ts.length; i++) {
      await page.evaluate((t) => window.render(t), ts[i]);
      await page.screenshot({ path: path.join(outDir, "p" + String(i).padStart(2, "0") + "_t" + ts[i] + ".png") });
    }
    console.log("probe done: " + ts.length + " frames → " + outDir);
  } else {
    const t0 = Date.now();
    for (let i = 0; i < N; i++) {
      await page.evaluate((t) => window.render(t), i / FPS);
      await page.screenshot({ path: path.join(outDir, "f" + String(i).padStart(4, "0") + ".png") });
      if (i % 120 === 0) console.log(i + "/" + N + "  " + Math.round((Date.now() - t0) / 1000) + "s");
    }
    console.log("FULL done: " + N + " frames in " + Math.round((Date.now() - t0) / 1000) + "s → " + outDir);
  }
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
