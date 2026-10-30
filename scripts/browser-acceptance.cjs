// Exercise a fresh synthetic browser profile; do not send AI requests or read user data.
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const deadline = setTimeout(() => {
  console.error('Browser acceptance exceeded its 150-second absolute deadline');
  process.exit(1);
}, 150000);

(async () => {
  const url = new URL(process.env.ACCEPTANCE_URL || 'http://127.0.0.1:8080/m3e-canvas-next/');
  assert(['127.0.0.1', 'localhost'].includes(url.hostname), 'Acceptance must use the local static build');
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}) });
  try {
    const context = await browser.newContext({ locale: 'en-US', viewport: { width: 1440, height: 1000 } });
    // External fonts are optional, and no credentials or network model calls are allowed.
    await context.route('**/*', route => new URL(route.request().url()).origin === url.origin ? route.continue() : route.abort());
    context.setDefaultTimeout(30000);
    context.setDefaultNavigationTimeout(30000);
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('response', response => {
      if (response.url().startsWith(url.origin) && response.status() >= 400) errors.push(`${response.status()} ${response.url()}`);
    });
    const response = await page.goto(url.href, { waitUntil: 'networkidle' });
    assert.equal(response.status(), 200);
    await page.locator('.m3e-boot').waitFor({ state: 'detached', timeout: 30000 });
    const manifestHref = await page.locator('link[rel="manifest"]').getAttribute('href');
    const manifestUrl = new URL(manifestHref, url);
    assert.equal(manifestUrl.origin, url.origin);
    assert(manifestUrl.pathname.startsWith(url.pathname));
    const manifestResponse = await context.request.get(manifestUrl.href, { maxRedirects: 0, timeout: 10000 });
    assert.equal(manifestResponse.status(), 200);
    const manifest = await manifestResponse.json();
    assert.equal(new URL(manifest.start_url, manifestUrl).href, url.href);
    assert.equal(new URL(manifest.scope, manifestUrl).href, url.href);
    assert(Array.isArray(manifest.icons) && manifest.icons.length > 0, 'Manifest must contain icons');
    for (const icon of manifest.icons) {
      const iconUrl = new URL(icon.src, manifestUrl);
      assert.equal(iconUrl.origin, url.origin);
      assert(iconUrl.pathname.startsWith(url.pathname));
      assert.equal((await context.request.get(iconUrl.href, { maxRedirects: 0, timeout: 10000 })).status(), 200);
    }
    const canonical = await page.locator('link[rel="canonical"]').getAttribute('href');
    assert.equal(canonical, 'https://xue-ding-e.github.io/m3e-canvas-next/');
    const phone = page.getByRole('button', { name: 'Phone screens', exact: true });
    if (await phone.count()) await phone.click();
    const countFrames = () => page.evaluate(() => JSON.parse(localStorage.getItem('m3e:doc')).frames.length);
    const before = await countFrames();
    const add = page.getByRole('button', { name: 'Add screen', exact: true });
    await add.click();
    await page.waitForFunction(expected => JSON.parse(localStorage.getItem('m3e:doc')).frames.length === expected, before + 1, { timeout: 30000 });
    await add.click();
    await page.waitForFunction(expected => JSON.parse(localStorage.getItem('m3e:doc')).frames.length === expected, before + 2, { timeout: 30000 });
    const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('m3e:doc')).frames.map(frame => frame.id));
    assert.equal(new Set(stored).size, stored.length);
    await page.reload({ waitUntil: 'networkidle' });
    await page.locator('.m3e-boot').waitFor({ state: 'detached', timeout: 30000 });
    assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem('m3e:doc')).frames.map(frame => frame.id)), stored);
    assert.deepEqual(errors, []);
    console.log('PASS: sub-path assets, manifest/icons/canonical, hydrated editor, repeated add-screen IDs, reload persistence; synthetic Chromium only.');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => clearTimeout(deadline));
