#!/usr/bin/env node
// Capture a short running-state preview of the shipped Foundation-inspired
// vault orb. This deliberately uses the same browser renderer as the visual
// proof, but records one continuous motion pass instead of a still frame.
import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { chromium } from '@playwright/test';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const outputDir = String(process.env.RAGENT_VISUAL_OUTPUT_DIR || join(
  repoRoot,
  'artifacts',
  'orb-rework',
  'orb-motion',
)).trim();
mkdirSync(outputDir, { recursive: true });

const threeSource = readFileSync(join(repoRoot, 'static', 'vendor', 'three.module.min.js'), 'utf8');
const threeCoreSource = readFileSync(join(repoRoot, 'static', 'vendor', 'three.core.min.js'), 'utf8');
const hdrLoaderSource = readFileSync(join(repoRoot, 'static', 'vendor', 'HDRLoader.js'), 'utf8');
const hdrSource = readFileSync(join(repoRoot, 'static', 'vendor', 'studio_small_09_1k.hdr'));
const liveStatusUi = readFileSync(join(repoRoot, 'static', 'chat', 'live-status-ui.js'), 'utf8');

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 320, height: 240 }, deviceScaleFactor: 1 });
  page.on('console', (message) => console.error(`[browser:${message.type()}] ${message.text()}`));
  page.on('pageerror', (error) => console.error(`[pageerror] ${error.message}`));
  await page.setContent('<!doctype html><html><body style="margin:0;background:#081018"><div id="host"></div></body></html>');

  const coreUrl = `data:text/javascript;base64,${Buffer.from(threeCoreSource).toString('base64')}`;
  const moduleSource = threeSource.replaceAll('./three.core.min.js', coreUrl);
  const moduleUrl = `data:text/javascript;base64,${Buffer.from(moduleSource).toString('base64')}`;
  const loaderSource = hdrLoaderSource.replaceAll('./three.module.min.js', moduleUrl);
  const loaderUrl = `data:text/javascript;base64,${Buffer.from(loaderSource).toString('base64')}`;
  const hdrUrl = `data:application/octet-stream;base64,${hdrSource.toString('base64')}`;
  await page.evaluate(({ moduleUrl: threeUrl, loaderUrl: hdrLoaderUrl, hdrUrl: environmentUrl }) => {
    window.__RAGENT_THREE_MODULE_URL = threeUrl;
    window.__RAGENT_HDR_LOADER_URL = hdrLoaderUrl;
    window.__RAGENT_HDR_URL = environmentUrl;
  }, { moduleUrl, loaderUrl, hdrUrl });
  await page.addScriptTag({
    content: `${liveStatusUi}\nwindow.__liveBarThreeVisual = { createLiveBarOrb, renderLiveBarOrb };`,
  });

  await page.evaluate(() => {
    const orb = window.__liveBarThreeVisual.createLiveBarOrb();
    const bar = document.createElement('div');
    bar.className = 'live-bar';
    bar.dataset.state = 'running';
    bar.append(orb);
    document.getElementById('host').append(bar);
    window.__liveBarMotionOrb = orb;
  });
  await page.waitForFunction(
    () => document.querySelector('canvas')?.dataset.renderer === 'three-webgl',
    null,
    { timeout: 30000 },
  );

  const videoBase64 = await page.evaluate(async () => {
    const orb = window.__liveBarMotionOrb;
    const orbCanvas = orb.querySelector('canvas');

    const preview = document.createElement('canvas');
    preview.width = 320;
    preview.height = 240;
    const context = preview.getContext('2d');
    const frameRate = 6;
    const stream = preview.captureStream(frameRate);
    const recorder = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp8' });
    const chunks = [];
    let firstFrame = '';
    recorder.ondataavailable = (event) => {
      if (event.data.size) chunks.push(event.data);
    };
    const startedAt = performance.now();
    recorder.start();
    for (let frame = 0; frame < 36; frame += 1) {
      const timeMs = frame * (1000 / frameRate);
      window.__liveBarThreeVisual.renderLiveBarOrb(orb, timeMs);
      const background = context.createLinearGradient(0, 0, 320, 240);
      background.addColorStop(0, '#0c1720');
      background.addColorStop(1, '#05090d');
      context.fillStyle = background;
      context.fillRect(0, 0, 320, 240);
      context.drawImage(orbCanvas, 32, -8, 256, 256);
      if (frame === 0) firstFrame = preview.toDataURL('image/png');
      await new Promise((resolve) => setTimeout(resolve, Math.max(0, startedAt + (frame + 1) * (1000 / frameRate) - performance.now())));
    }
    await new Promise((resolve) => {
      recorder.onstop = resolve;
      recorder.stop();
    });
    stream.getTracks().forEach((track) => track.stop());
    const blob = new Blob(chunks, { type: 'video/webm' });
    const buffer = await blob.arrayBuffer();
    let binary = '';
    const bytes = new Uint8Array(buffer);
    for (let index = 0; index < bytes.length; index += 1) binary += String.fromCharCode(bytes[index]);
    return { video: btoa(binary), firstFrame };
  });

  const outputPath = join(outputDir, 'foundation-vault-motion.webm');
  writeFileSync(outputPath, Buffer.from(videoBase64.video, 'base64'));
  writeFileSync(join(outputDir, 'foundation-vault-motion-start.png'), Buffer.from(videoBase64.firstFrame.split(',', 2)[1], 'base64'));
  console.log(`capture-live-bar-orb-motion: ok (${outputPath})`);
} finally {
  await browser.close();
}
