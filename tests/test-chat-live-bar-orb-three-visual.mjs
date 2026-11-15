#!/usr/bin/env node
// Browser proof for the upgraded Three.js PBR orb. The test loads the vendored
// module through a data URL so it does not need a server or a build step.
import assert from 'assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { chromium } from '@playwright/test';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const outputDir = String(process.env.RAGENT_VISUAL_OUTPUT_DIR || join(repoRoot, 'artifacts', 'live-bar-webgl-final', 'three-check')).trim();
mkdirSync(outputDir, { recursive: true });
const threeSource = readFileSync(join(repoRoot, 'static', 'vendor', 'three.module.min.js'), 'utf8');
const threeCoreSource = readFileSync(join(repoRoot, 'static', 'vendor', 'three.core.min.js'), 'utf8');
const hdrLoaderSource = readFileSync(join(repoRoot, 'static', 'vendor', 'HDRLoader.js'), 'utf8');
const hdrSource = readFileSync(join(repoRoot, 'static', 'vendor', 'studio_small_09_1k.hdr'));
const liveStatusUi = readFileSync(join(repoRoot, 'static', 'chat', 'live-status-ui.js'), 'utf8');

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 240 }, deviceScaleFactor: 1 });
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
  const initial = await page.evaluate(() => {
    const orb = window.__liveBarThreeVisual.createLiveBarOrb();
    const bar = document.createElement('div');
    bar.className = 'live-bar';
    bar.dataset.state = 'running';
    bar.append(orb);
    document.getElementById('host').append(bar);
    window.__liveBarThreeVisual.renderLiveBarOrb(orb, 1800);
    return { renderer: orb.querySelector('canvas')?.dataset.renderer || '' };
  });
  try {
    await page.waitForFunction(() => document.querySelector('canvas')?.dataset.renderer === 'three-webgl', null, { timeout: 30000 });
  } catch (error) {
    console.error('[three-diagnostics]', await page.evaluate(() => ({
      renderer: document.querySelector('canvas')?.dataset.renderer || '',
      threeError: document.querySelector('canvas')?.dataset.threeError || '',
      loadError: window.__RAGENT_THREE_LOAD_ERROR || '',
      hdrError: window.__RAGENT_THREE_HDR_ERROR || '',
    })));
    throw error;
  }
  const result = await page.evaluate(() => {
    const canvas = document.querySelector('canvas');
    const orb = document.querySelector('.live-bar__orb');
    const bar = document.querySelector('.live-bar');
    window.__liveBarThreeVisual.renderLiveBarOrb(orb, 2700);
    const image = canvas.toDataURL('image/png');
    const composite = (background) => {
      const surface = document.createElement('canvas');
      surface.width = canvas.width;
      surface.height = canvas.height;
      const context = surface.getContext('2d');
      context.fillStyle = background;
      context.fillRect(0, 0, surface.width, surface.height);
      context.drawImage(canvas, 0, 0);
      return surface.toDataURL('image/png');
    };
    const surfaceImages = {
      dark: composite('#081018'),
      light: composite('#eef1f3'),
    };
    const stateFrames = ['running', 'queued', 'waiting_user', 'done', 'failed', 'ready'].map((stateKey) => {
      bar.dataset.state = stateKey;
      window.__liveBarThreeVisual.renderLiveBarOrb(orb, 2700);
      return { stateKey, image: canvas.toDataURL('image/png') };
    });
    return {
      initialRenderer: canvas.dataset.renderer === 'three-webgl' ? 'three-webgl' : 'fallback-before-upgrade',
      renderer: canvas.dataset.renderer,
      environment: canvas.dataset.environment,
      canvasWidth: canvas.width,
      canvasHeight: canvas.height,
      frameSignature: canvas.dataset.frameSignature,
      image,
      surfaceImages,
      stateFrameLengths: stateFrames.map(({ image }) => image.length),
      stateFrameVariants: new Set(stateFrames.map(({ image }) => image)).size,
      stateImages: Object.fromEntries(stateFrames.map(({ stateKey, image }) => [stateKey, image])),
    };
  });
  assert.equal(initial.renderer, 'pending', 'the canvas must stay unclaimed while the stronger renderer loads');
  assert.equal(result.renderer, 'three-webgl', 'the real Three.js renderer should replace the fallback');
  assert.equal(result.environment, 'hdr', 'the material should use the real studio HDR environment');
  assert.equal(result.canvasWidth, 256, 'Three.js should keep the high-resolution backing canvas');
  assert.equal(result.canvasHeight, 256, 'Three.js should keep the high-resolution backing canvas');
  assert.match(result.frameSignature, /^-?\d+\.\d+:-?\d+\.\d+:-?\d+\.\d+$/, 'Three.js frame should expose all three motion axes');
  assert.ok(result.image.length > 1000, 'Three.js should produce a non-empty rendered frame');
  assert.equal(result.stateFrameVariants, 6, 'Vault light well material should change across the main visual states');
  assert.ok(result.stateFrameLengths.every((length) => length > 1000), 'each state should produce a real rendered frame');
  writeFileSync(join(outputDir, 'orb-three-webgl.png'), Buffer.from(result.image.split(',', 2)[1], 'base64'));
  for (const [surfaceKey, image] of Object.entries(result.surfaceImages)) {
    writeFileSync(join(outputDir, `orb-three-${surfaceKey}-surface.png`), Buffer.from(image.split(',', 2)[1], 'base64'));
  }
  for (const [stateKey, image] of Object.entries(result.stateImages)) {
    writeFileSync(join(outputDir, `orb-three-${stateKey}.png`), Buffer.from(image.split(',', 2)[1], 'base64'));
  }
  console.log(`test-chat-live-bar-orb-three-visual: ok (${result.renderer}, ${outputDir})`);
} finally {
  await browser.close();
}
