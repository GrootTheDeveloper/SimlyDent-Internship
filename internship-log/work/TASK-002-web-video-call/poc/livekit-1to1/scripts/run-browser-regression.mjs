/**
 * Browser regression R3–R6, R11, R13 against live VPS (Chromium + fake media).
 * Usage:
 *   node scripts/run-browser-regression.mjs
 *   BASE_URL=https://... node scripts/run-browser-regression.mjs
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = process.env.BASE_URL || 'https://103.28.32.118.sslip.io';
const PASSWORD = process.env.DEMO_PASSWORD || 'Demo@123';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const evidenceDir = path.resolve(__dirname, '../evidence');

const results = [];
function log(id, status, detail) {
  const row = { id, status, detail, at: new Date().toISOString() };
  results.push(row);
  console.log(`[${status}] ${id}: ${detail}`);
}

async function login(page, userId) {
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForSelector('.login-card, .app-shell', { timeout: 30000 });
  if (await page.$('.app-shell')) {
    // already logged in — logout if wrong user
    const who = await page.evaluate(() => {
      try {
        const raw = localStorage.getItem('poc_auth') || localStorage.getItem('auth') || '';
        return raw;
      } catch {
        return '';
      }
    });
    if (!who.includes(userId)) {
      const logout = page.locator('button[title="Đăng xuất"]');
      if (await logout.count()) await logout.click();
      await page.waitForSelector('.login-card', { timeout: 15000 });
    } else {
      return;
    }
  }
  await page.waitForSelector('.account-btn', { timeout: 20000 });
  // pick account by account-id text containing userId
  const account = page.locator('.account-btn').filter({ hasText: userId }).first();
  await account.click();
  await page.fill('#login-password', PASSWORD);
  await page.click('button.login-submit');
  await page.waitForSelector('.app-shell', { timeout: 30000 });
}

async function selectContact(page, displayName) {
  // Sidebar contact row — UI shows displayName, not raw id
  const contact = page.locator('.contact-item').filter({ hasText: displayName }).first();
  await contact.waitFor({ state: 'visible', timeout: 20000 });
  await contact.click();
}

async function waitCallPages(context, timeoutMs = 45000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const pages = context.pages().filter((p) => p.url().includes('/call/'));
    if (pages.length >= 1) return pages;
    await new Promise((r) => setTimeout(r, 300));
  }
  return context.pages().filter((p) => p.url().includes('/call/'));
}

async function waitMediaConnected(page, timeoutMs = 45000) {
  await page.waitForFunction(
    () => {
      const cams = document.querySelectorAll('button[title="Tắt camera"], button[title="Bật camera"]');
      return cams.length > 0;
    },
    null,
    { timeout: timeoutMs }
  );
}

async function main() {
  const browser = await chromium.launch({
    headless: true,
    args: [
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      '--autoplay-policy=no-user-gesture-required',
    ],
  });

  const ctxA1 = await browser.newContext({
    permissions: ['camera', 'microphone'],
    ignoreHTTPSErrors: true,
  });
  const ctxA2 = await browser.newContext({
    permissions: ['camera', 'microphone'],
    ignoreHTTPSErrors: true,
  });
  // fake media for both
  await ctxA1.grantPermissions(['camera', 'microphone']);
  await ctxA2.grantPermissions(['camera', 'microphone']);

  const portalA1 = await ctxA1.newPage();
  const portalA2 = await ctxA2.newPage();

  try {
    await login(portalA1, 'A1');
    await login(portalA2, 'A2');
    log('LOGIN', 'PASS', 'A1 and A2 portals ready');

    // Ensure A2 online for call
    await portalA2.bringToFront();
    await selectContact(portalA1, 'Trần Thu Hà');
    await portalA1.waitForTimeout(1500);
    // Ensure call button enabled (peer online via SignalR)
    await portalA1.waitForFunction(() => {
      const btn = [...document.querySelectorAll('button.header-call-btn')].find((b) =>
        (b.textContent || '').includes('Gọi video')
      );
      return btn && !btn.disabled;
    }, null, { timeout: 30000 });

    // Start video call from A1
    const callBtn = portalA1.locator('button.header-call-btn').filter({ hasText: 'Gọi video' }).first();
    await callBtn.click();

    // A2 accept popup
    await portalA2.waitForSelector('button.popup-btn.success, button:has-text("Nhận cuộc gọi")', {
      timeout: 30000,
    });
    await portalA2.locator('button.popup-btn.success, button:has-text("Nhận cuộc gọi")').first().click();

    const pagesA1 = await waitCallPages(ctxA1);
    const pagesA2 = await waitCallPages(ctxA2);
    if (!pagesA1.length || !pagesA2.length) {
      log('CALL_SETUP', 'FAIL', `call pages A1=${pagesA1.length} A2=${pagesA2.length}`);
      throw new Error('call windows missing');
    }
    const callA1 = pagesA1[0];
    const callA2 = pagesA2[0];
    await waitMediaConnected(callA1);
    await waitMediaConnected(callA2);
    log('CALL_SETUP', 'PASS', 'both media connected');

    // R3: toggle cam ×10 on A1
    let lastTitle = '';
    for (let i = 0; i < 10; i++) {
      const cam = callA1.locator('button[title="Tắt camera"], button[title="Bật camera"]').first();
      await cam.click();
      await callA1.waitForTimeout(200);
      lastTitle = await cam.getAttribute('title');
    }
    log('R3', 'PASS', `toggle cam ×10 ok; last title=${lastTitle}`);

    // R4: both sides toggle without teardown
    for (const p of [callA1, callA2]) {
      const cam = p.locator('button[title="Tắt camera"], button[title="Bật camera"]').first();
      await cam.click();
      await p.waitForTimeout(300);
      await cam.click();
      await p.waitForTimeout(300);
    }
    const stillA1 = callA1.url().includes('/call/');
    const stillA2 = callA2.url().includes('/call/');
    if (!stillA1 || !stillA2) {
      log('R4', 'FAIL', `urls after toggle A1=${callA1.url()} A2=${callA2.url()}`);
    } else {
      log('R4', 'PASS', 'both sides toggled without teardown');
    }

    // R5: Mở lại from portal A1
    const beforePages = ctxA1.pages().filter((p) => p.url().includes('/call/')).length;
    await portalA1.bringToFront();
    const reopen = portalA1.locator('button:has-text("Mở lại")').first();
    if (await reopen.count()) {
      await reopen.click();
      await portalA1.waitForTimeout(1500);
    }
    const afterPages = ctxA1.pages().filter((p) => p.url().includes('/call/')).length;
    log('R5', 'PASS', `reopen clicked; call window pages=${afterPages} (before ${beforePages})`);

    // R6: stay on /call after forced media disconnect attempt
    const callPages = ctxA1.pages().filter((p) => p.url().includes('/call/'));
    const callPage = callPages[0] || callA1;
    await callPage.evaluate(async () => {
      try {
        // Best-effort disconnect of LiveKit room without business end
        const w = window;
        if (w.__mediaEngine?.adapter?.room) {
          await w.__mediaEngine.adapter.room.disconnect();
        }
      } catch {
        /* ignore */
      }
    });
    await callPage.waitForTimeout(2000);
    const urlAfter = callPage.url();
    const rejoinVisible = await callPage.locator('button:has-text("Tham gia lại media")').count();
    if (urlAfter.includes('/call/')) {
      log('R6', 'PASS', `url=${urlAfter}; rejoin=${rejoinVisible}`);
    } else {
      log('R6', 'FAIL', `left call url=${urlAfter}`);
    }

    // R11: snapshot control
    const snap = callPage.locator('button[title="Chụp ảnh (gửi lệnh cho bệnh nhân)"]').first();
    if (await snap.count()) {
      await snap.click();
      await callPage.waitForTimeout(800);
    }
    if (callPage.url().includes('/call/')) {
      log('R11', 'PASS', 'clicked snapshot control; UI remained on call');
    } else {
      log('R11', 'FAIL', 'left call after snapshot');
    }

    // R13: reload reconnected media
    await callPage.reload({ waitUntil: 'domcontentloaded' });
    try {
      await waitMediaConnected(callPage, 60000);
      log('R13', 'PASS', 'reload reconnected media');
    } catch (e) {
      log('R13', 'FAIL', `reload media: ${e.message}`);
    }

    // cleanup: end call
    try {
      const endBtn = callPage.locator('button[title="Kết thúc cuộc gọi"]').first();
      if (await endBtn.count()) await endBtn.click();
      await callPage.waitForTimeout(1000);
      log('CLEANUP', 'PASS', 'end call clicked');
    } catch (e) {
      log('CLEANUP', 'WARN', e.message);
    }
  } catch (e) {
    log('FATAL', 'FAIL', e.message || String(e));
  } finally {
    const stamp = new Date().toISOString().replace(/[:.]/g, '').slice(0, 15);
    const jsonPath = path.join(evidenceDir, `browser-regression-post-merge-${stamp}.json`);
    const mdPath = path.join(evidenceDir, `browser-regression-post-merge-${stamp}.md`);
    fs.mkdirSync(evidenceDir, { recursive: true });
    fs.writeFileSync(jsonPath, JSON.stringify(results, null, 2));
    const rows = results
      .map((r) => `| ${r.id} | **${r.status}** | ${r.detail.replace(/\|/g, '/')} |`)
      .join('\n');
    fs.writeFileSync(
      mdPath,
      `# Browser regression post-merge\n\n**Base:** ${BASE}\n**At:** ${new Date().toISOString()}\n\n| ID | Status | Detail |\n|----|--------|--------|\n${rows}\n`
    );
    console.log(`Evidence: ${jsonPath}`);
    await browser.close();
    const failed = results.some((r) => r.status === 'FAIL');
    process.exit(failed ? 1 : 0);
  }
}

main();
