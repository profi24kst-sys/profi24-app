const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:5173';
const EMAIL = process.env.E2E_EMAIL || 'browser-owner@test.invalid';
const PASSWORD = process.env.E2E_PASSWORD || 'BrowserOwner2026Kst9';
const artifacts = path.resolve(__dirname, 'artifacts');
fs.mkdirSync(artifacts, { recursive: true });

function fail(message) { throw new Error(message); }
async function heading(page, text) {
  await page.locator('main h1').filter({ hasText: text }).first().waitFor({ state: 'visible', timeout: 8000 });
  const actual = (await page.locator('main h1').first().textContent())?.trim();
  if (actual !== text) fail(`expected heading ${text}, got ${actual}`);
}
async function navButton(page, label) {
  const button = page.locator('aside nav button').filter({ hasText: label }).first();
  await button.waitFor({ state: 'visible', timeout: 8000 });
  return button;
}
async function clickBase(page, label, expectedHeading) {
  const button = await navButton(page, label);
  const box = await button.boundingBox();
  if (!box) fail(`${label}: no bounding box`);
  const stack = await page.evaluate(({x,y}) => document.elementsFromPoint(x,y).slice(0,8).map(el => ({tag:el.tagName,id:el.id,cls:el.className,text:(el.textContent||'').trim().slice(0,80)})), {x:box.x+box.width/2,y:box.y+box.height/2});
  console.log('click_target', label, JSON.stringify(stack));
  await button.click({ timeout: 6000 });
  await heading(page, expectedHeading);
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  const consoleErrors = [];
  page.on('console', msg => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
  page.on('pageerror', err => consoleErrors.push(String(err.stack || err)));
  await page.addInitScript(() => {
    window.__profi24ReadyCount = 0;
    window.addEventListener('profi24:core-ui-ready', () => { window.__profi24ReadyCount += 1; });
  });

  try {
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.getByPlaceholder('Email').fill(EMAIL);
    await page.getByPlaceholder('Пароль').fill(PASSWORD);
    await page.getByRole('button', { name: 'Войти', exact: true }).click();
    await heading(page, 'Заказы');
    await page.waitForTimeout(1200);

    const version = await page.evaluate(() => window.Profi24UI?.version || 'missing');
    const readyCount = await page.evaluate(() => window.__profi24ReadyCount || 0);
    console.log(`core_ui_version=${version} ready_events=${readyCount}`);
    if (version !== '1.10.0') fail(`expected Core UI 1.10.0, got ${version}`);
    if (readyCount > 3) fail(`core-ui-ready event storm detected: ${readyCount} events after login`);

    await clickBase(page, 'Клиенты', 'Клиенты');
    await clickBase(page, 'Техника', 'Техника');
    await clickBase(page, 'Финансы', 'Финансы');

    // Staff used to freeze the browser: rbac-ui-v2 rewrote option.textContent on
    // every MutationObserver pass, which scheduled itself forever. Exercise the
    // exact Finance -> Staff path from manual localhost acceptance and prove the
    // page remains responsive after the role select is mounted.
    await clickBase(page, 'Сотрудники', 'Сотрудники');
    await page.getByText('Добавить сотрудника', { exact: true }).waitFor({ state: 'visible', timeout: 6000 });
    const roleSelect = page.locator('main select').first();
    await roleSelect.waitFor({ state: 'visible', timeout: 6000 });
    const roleValues = await roleSelect.locator('option').evaluateAll(opts => opts.map(o => o.value));
    for (const role of ['OWNER','SUPERVISOR','ACCOUNTANT','MANAGER','ENGINEER','TRAINEE']) {
      if (!roleValues.includes(role)) fail(`staff role option missing: ${role}`);
    }
    await page.waitForTimeout(800);
    await clickBase(page, 'Заказы', 'Заказы');
    console.log('staff_navigation=ok');

    await page.getByRole('button', { name: /Новый заказ/ }).click({ timeout: 6000 });
    await page.locator('.drawer').waitFor({ state: 'visible', timeout: 6000 });
    console.log('new_order_drawer=ok');

    // Reload gives the addon assertion a clean base screen while preserving the authenticated session.
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
    await heading(page, 'Заказы');
    await page.waitForTimeout(500);
    const branches = page.locator('aside nav button[data-core-nav-id="branches"]');
    await branches.waitFor({ state: 'visible', timeout: 8000 });
    await branches.click({ timeout: 6000 });
    await page.locator('.branchScreen h1').filter({ hasText: 'Филиалы' }).waitFor({ state: 'visible', timeout: 8000 });
    console.log('addon_branches=ok');

    const finalReadyCount = await page.evaluate(() => window.__profi24ReadyCount || 0);
    if (finalReadyCount > 3) fail(`core-ui-ready event storm detected after reload: ${finalReadyCount}`);
    if (consoleErrors.length) fail(`browser console errors: ${consoleErrors.join(' | ')}`);
    console.log('ui_browser_acceptance=pass');
  } catch (err) {
    console.error('ui_browser_acceptance=fail', err);
    console.error('console_errors=', JSON.stringify(consoleErrors));
    try { await page.screenshot({ path: path.join(artifacts, 'failure.png'), fullPage: true }); } catch {}
    try {
      const state = await page.evaluate(() => ({
        title: document.title,
        heading: document.querySelector('main h1')?.textContent || null,
        coreVersion: window.Profi24UI?.version || null,
        readyEvents: window.__profi24ReadyCount || 0,
        nav: [...document.querySelectorAll('aside nav button')].map(b => ({text:(b.textContent||'').trim(),id:b.dataset.coreNavId||null,hidden:b.hidden,disabled:b.disabled}))
      }));
      fs.writeFileSync(path.join(artifacts, 'state.json'), JSON.stringify(state, null, 2));
      console.error('browser_state=', JSON.stringify(state));
    } catch {}
    await browser.close();
    process.exit(1);
  }
  await browser.close();
})();
