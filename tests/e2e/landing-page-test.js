/**
 * E2E Smoke Test: Landing Page Load and Navigation
 * 
 * Verifies that the landing page loads correctly and basic navigation works.
 * This is the critical first-path test for the application.
 */

import { test, expect } from '@playwright/test';

test.describe('Landing Page Critical Path', () => {
  test('landing page loads successfully', async ({ page }) => {
    // Navigate to the application root
    const BASE_URL = process.env.BASE_URL || 'http://localhost:20127';
    await page.goto(BASE_URL);

    // Wait for page to be interactive
    await page.waitForLoadState('networkidle');

    // Verify page title or main content is visible
    await expect(page).toHaveTitle(/9Router/);

    // Check that the main content area is visible
    await expect(page.locator('main')).toBeVisible();
    await expect(page.locator('h1')).toBeVisible();
  });

  test('navigation links are functional', async ({ page }) => {
    await page.goto(process.env.BASE_URL || 'http://localhost:20127');

    await page.waitForLoadState('networkidle');

    // Click on a navigation link (e.g., Features, Docs, etc.)
    const navLinks = page.locator('nav a, .nav-link, [role="navigation"] a');
    const linkCount = await navLinks.count();

    for (let i = 0; i < Math.min(linkCount, 3); i++) {
      const link = navLinks.nth(i);
      const href = await link.getAttribute('href');
      if (href && !href.startsWith('#') && href.startsWith('/')) {
        await link.click();
        await page.waitForLoadState('networkidle');
        await expect(page).toHaveURL(new RegExp('^' + process.env.BASE_URL || 'http://localhost:20127'));
        await page.goBack();
        await page.waitForLoadState('networkidle');
      }
    }
  });
});