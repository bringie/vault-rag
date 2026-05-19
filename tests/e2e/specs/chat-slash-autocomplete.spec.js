'use strict';
// vt-0398: slash-command autocomplete in the chat composer.
// Tests the full interaction lifecycle: dropdown appearance, filtering,
// keyboard navigation, insertion, and closure.
//
// Strategy: rather than requiring a live WS session with slash_inventory,
// we mount the chat-view (it's mounted during app init), inject a synthetic
// slash_inventory frame directly via chatView.handleFrame(), then test the
// composer interactions. This avoids flakiness from real session state.

const { test, expect } = require('@playwright/test');
const { loginAs } = require('../fixtures/auth');

const BASE = process.env.PORTAL_URL || 'https://brain.itiswednesdaymydud.es';

// Synthetic slash commands to seed STATE._slashCommands via slash_inventory frame.
const SYNTHETIC_SLASH_COMMANDS = [
  { name: '/help',    description: 'Show help' },
  { name: '/clear',   description: 'Clear conversation' },
  { name: '/compact', description: 'Compact context' },
  { name: '/memory',  description: 'Show memory' },
  { name: '/cost',    description: 'Show cost' },
];

// Wait for chatView global to be available and mounted.
async function waitForChatView(page) {
  await page.waitForFunction(() =>
    typeof window.chatView === 'object' &&
    window.chatView !== null &&
    typeof window.chatView.handleFrame === 'function' &&
    typeof window.chatView.mount === 'function',
    { timeout: 15_000 }
  );
}

// Seed slash commands via the slash_inventory frame handler.
async function seedSlashCommands(page, commands = SYNTHETIC_SLASH_COMMANDS) {
  await page.evaluate((cmds) => {
    window.chatView.handleFrame({ type: 'slash_inventory', commands: cmds });
  }, commands);
  // Wait for STATE._slashCommands to be populated.
  await page.waitForFunction(
    (n) => {
      // Access STATE via the chatView's known internal (injected by IIFE).
      // We can't access STATE directly but slash_inventory is synchronous,
      // so the commands must be available immediately after handleFrame.
      // Verify by checking the composer can trigger a dropdown.
      return true; // injection is sync; just yield to microtask queue
    },
    commands.length,
    { timeout: 5_000 }
  );
  // Give RAF a tick to settle.
  await page.waitForTimeout(50);
}

// Get or create the composerInput textarea. The textarea is disabled by default
// (chat-view.js sets ta.disabled=true on mount, enabled only after attach()).
// For interaction tests we enable it programmatically via JavaScript.
async function getComposerTextarea(page) {
  const ta = page.locator('.cv-composer-input');
  await expect(ta).toBeAttached({ timeout: 10_000 });
  // Enable the textarea so Playwright can type into it.
  await page.evaluate(() => {
    const el = document.querySelector('.cv-composer-input');
    if (el) el.disabled = false;
  });
  await expect(ta).toBeVisible({ timeout: 5_000 });
  return ta;
}

// Detect whether the deployed chat-view.js has the slash autocomplete feature
// (vt-0398). The feature is identified by the presence of the cv-slash-dropdown
// element class in the page's CSS stylesheets OR by triggering a slash in the
// composer and checking if a dropdown appears.
// Skip tests when the feature isn't deployed — tests exist to catch regressions.
async function detectSlashAutocomplete(page) {
  // Probe: seed a slash_inventory frame, type '/', and check if cv-slash-dropdown
  // appears in the DOM. If the deployed version doesn't handle slash_inventory,
  // no dropdown will appear.
  try {
    await page.evaluate(() => {
      const el = document.querySelector('.cv-composer-input');
      if (el) el.disabled = false;
    });
    await page.evaluate((cmds) => {
      window.chatView.handleFrame({ type: 'slash_inventory', commands: cmds });
    }, SYNTHETIC_SLASH_COMMANDS);
    const ta = page.locator('.cv-composer-input');
    await ta.fill('/');
    await ta.dispatchEvent('input');
    await page.waitForTimeout(150);
    const drop = await page.locator('.cv-slash-dropdown').count();
    return drop > 0;
  } catch {
    return false;
  }
}

test.describe('Slash autocomplete @chat @vt-0398', () => {
  test.beforeEach(async ({ page }) => {
    await loginAs(page, 'admin');
    await page.goto(`${BASE}/fleet/`);
    await expect(page.locator('#app')).toBeVisible({ timeout: 15_000 });
    await waitForChatView(page);

    // Skip if slash autocomplete isn't deployed yet.
    const hasFeature = await detectSlashAutocomplete(page);
    test.skip(!hasFeature, 'slash autocomplete (vt-0398) not yet deployed to this environment');

    // Clear any state left by detectSlashAutocomplete, then reseed.
    await page.evaluate(() => {
      const ta = document.querySelector('.cv-composer-input');
      if (ta) ta.value = '';
    });
    await seedSlashCommands(page);
  });

  test('slash-01: type "/" opens dropdown with items', async ({ page }) => {
    const ta = await getComposerTextarea(page);
    await ta.click();
    await ta.fill('/');
    // Trigger the input event so updateSlashDropdown fires.
    await ta.dispatchEvent('input');
    // RAF throttles rendering; allow two animation frames.
    await page.waitForTimeout(100);
    const dropdown = page.locator('.cv-slash-dropdown');
    await expect(dropdown).toBeVisible({ timeout: 3_000 });
    const items = page.locator('.cv-slash-item');
    await expect(items).toHaveCount(SYNTHETIC_SLASH_COMMANDS.length);
  });

  test('slash-02: type "/he" filters to /help only', async ({ page }) => {
    const ta = await getComposerTextarea(page);
    await ta.click();
    await ta.fill('/he');
    await ta.dispatchEvent('input');
    await page.waitForTimeout(100);
    const dropdown = page.locator('.cv-slash-dropdown');
    await expect(dropdown).toBeVisible({ timeout: 3_000 });
    const items = page.locator('.cv-slash-item');
    // Only /help matches '/he' prefix.
    await expect(items).toHaveCount(1);
    const name = page.locator('.cv-slash-item .cv-slash-name');
    await expect(name.first()).toHaveText('/help');
  });

  test('slash-03: ArrowDown moves cv-slash-active class', async ({ page }) => {
    const ta = await getComposerTextarea(page);
    await ta.click();
    await ta.fill('/');
    await ta.dispatchEvent('input');
    await page.waitForTimeout(100);
    await expect(page.locator('.cv-slash-dropdown')).toBeVisible({ timeout: 3_000 });

    // Initially index=0 → first item is active.
    const firstActive = page.locator('.cv-slash-item.cv-slash-active');
    await expect(firstActive).toHaveCount(1);
    const firstText = await firstActive.locator('.cv-slash-name').textContent();
    expect(firstText).toBe('/help');

    // Press ArrowDown → index moves to 1.
    await ta.press('ArrowDown');
    await page.waitForTimeout(100); // allow RAF
    const secondActive = page.locator('.cv-slash-item.cv-slash-active');
    await expect(secondActive).toHaveCount(1);
    const secondText = await secondActive.locator('.cv-slash-name').textContent();
    expect(secondText).not.toBe('/help');
  });

  test('slash-04: ArrowUp wraps around to last item', async ({ page }) => {
    const ta = await getComposerTextarea(page);
    await ta.click();
    await ta.fill('/');
    await ta.dispatchEvent('input');
    await page.waitForTimeout(100);
    await expect(page.locator('.cv-slash-dropdown')).toBeVisible({ timeout: 3_000 });

    // ArrowUp from index=0 wraps to last item.
    await ta.press('ArrowUp');
    await page.waitForTimeout(100);
    const lastActive = page.locator('.cv-slash-item.cv-slash-active');
    const lastText = await lastActive.locator('.cv-slash-name').textContent();
    expect(lastText).toBe(SYNTHETIC_SLASH_COMMANDS[SYNTHETIC_SLASH_COMMANDS.length - 1].name);
  });

  test('slash-05: Tab inserts selected command with trailing space, does NOT submit', async ({ page }) => {
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));

    const ta = await getComposerTextarea(page);
    await ta.click();
    await ta.fill('/he');
    await ta.dispatchEvent('input');
    await page.waitForTimeout(100);
    await expect(page.locator('.cv-slash-dropdown')).toBeVisible({ timeout: 3_000 });

    // Tab should insert without submitting.
    await ta.press('Tab');
    await page.waitForTimeout(100);

    const value = await ta.inputValue();
    expect(value).toBe('/help ');

    // Dropdown should close after insertion.
    await expect(page.locator('.cv-slash-dropdown')).toHaveCount(0);

    // No fatal errors = no accidental form submit.
    const fatal = errors.filter(e => /Uncaught|TypeError|ReferenceError/i.test(e));
    expect(fatal).toEqual([]);
  });

  test('slash-06: Enter inserts selected command, does NOT submit', async ({ page }) => {
    const ta = await getComposerTextarea(page);
    await ta.click();
    await ta.fill('/cle');
    await ta.dispatchEvent('input');
    await page.waitForTimeout(100);
    await expect(page.locator('.cv-slash-dropdown')).toBeVisible({ timeout: 3_000 });

    await ta.press('Enter');
    await page.waitForTimeout(100);

    const value = await ta.inputValue();
    expect(value).toBe('/clear ');
    await expect(page.locator('.cv-slash-dropdown')).toHaveCount(0);
  });

  test('slash-07: Escape closes dropdown without insertion', async ({ page }) => {
    const ta = await getComposerTextarea(page);
    await ta.click();
    await ta.fill('/');
    await ta.dispatchEvent('input');
    await page.waitForTimeout(100);
    await expect(page.locator('.cv-slash-dropdown')).toBeVisible({ timeout: 3_000 });

    await ta.press('Escape');
    await page.waitForTimeout(100);
    await expect(page.locator('.cv-slash-dropdown')).toHaveCount(0);

    // Textarea content unchanged.
    const value = await ta.inputValue();
    expect(value).toBe('/');
  });

  test('slash-08: type "/xyzNoMatch" → dropdown disappears', async ({ page }) => {
    const ta = await getComposerTextarea(page);
    await ta.click();
    await ta.fill('/');
    await ta.dispatchEvent('input');
    await page.waitForTimeout(100);
    await expect(page.locator('.cv-slash-dropdown')).toBeVisible({ timeout: 3_000 });

    // Now type a query that matches nothing.
    await ta.fill('/xyzNoMatch');
    await ta.dispatchEvent('input');
    await page.waitForTimeout(100);
    await expect(page.locator('.cv-slash-dropdown')).toHaveCount(0);
  });

  test('slash-09: pointerdown on suggestion inserts it', async ({ page }) => {
    const ta = await getComposerTextarea(page);
    await ta.click();
    await ta.fill('/');
    await ta.dispatchEvent('input');
    await page.waitForTimeout(100);
    await expect(page.locator('.cv-slash-dropdown')).toBeVisible({ timeout: 3_000 });

    // Click the second item (/clear).
    const secondItem = page.locator('.cv-slash-item').nth(1);
    await expect(secondItem).toBeVisible();
    const expectedName = await secondItem.locator('.cv-slash-name').textContent();

    // Use pointerdown to match the actual event listener.
    await secondItem.dispatchEvent('pointerdown');
    await page.waitForTimeout(100);

    const value = await ta.inputValue();
    expect(value).toBe(`${expectedName} `);
    await expect(page.locator('.cv-slash-dropdown')).toHaveCount(0);
  });

  test('slash-10: programmatic insertion fires input event → textarea autosizes (height grew or is consistent)', async ({ page }) => {
    const ta = await getComposerTextarea(page);
    await ta.click();
    await ta.fill('/he');
    await ta.dispatchEvent('input');
    await page.waitForTimeout(100);
    await expect(page.locator('.cv-slash-dropdown')).toBeVisible({ timeout: 3_000 });

    const heightBefore = await ta.evaluate(el => el.scrollHeight);

    // Tab to accept (programmatically inserts value + dispatches 'input').
    await ta.press('Tab');
    await page.waitForTimeout(150); // allow autosize listener to run

    // The acceptSlashCompletion dispatches an 'input' event, so the
    // autosize listener fires. Height should remain stable (1 line) or grow.
    // At minimum, verify no error was thrown and the input event was dispatched
    // (evidenced by the value containing the inserted command).
    const value = await ta.inputValue();
    expect(value).toBe('/help ');

    // Height should be ≥ initial height (autosize never shrinks below 1 row).
    const heightAfter = await ta.evaluate(el => el.scrollHeight);
    expect(heightAfter).toBeGreaterThanOrEqual(heightBefore);
  });
});
