// E2E Test globals for 9router critical paths
// These are shared fixtures and test utilities used across E2E tests

// Base URL for the application
const BASE_URL = process.env.BASE_URL || 'http://localhost:20127';

// Test timeouts
exports.testTimeout = 30000;
exports.expectTimeout = 5000;

// Page fixtures accessible across tests
exports.pageFixtures = {
  baseUrl: BASE_URL,
};

// Assertion helpers
exports.assertionHelpers = {
  // Wait for page to be fully loaded
  async waitForPageLoad(page) {
    await page.waitForLoadState('networkidle');
    await page.waitForSelector('body', { state: 'visible' });
  },

  // Take a screenshot for debugging
  async takeScreenshot(page, name) {
    await page.screenshot({ path: `screenshots/${name}.png`, fullPage: true });
  },
};

// Navigation utilities
exports.navigation = {
  // Navigate to root path
  async goToHome(page) {
    await page.goto(BASE_URL);
    await this.waitForPageLoad(page);
  },

  // Navigate to API endpoint
  async goToApi(path, page) {
    await page.goto(`${BASE_URL}${path}`);
    await this.waitForPageLoad(page);
  },
};

// OAuth flow utilities
exports.oauth = {
  // Wait for onboarding to complete
  async waitForOnboardingCompletion(page) {
    await page.waitForSelector('[data-testid="onboarding-complete"]', { timeout: 5000 });
  },

  // Check if onboarding is in progress
  async isOnboardingInProgress(page) {
    return await page.locator('[data-testid="onboarding-in-progress"]').isVisible();
  },
};

// Error boundary test helpers
exports.sentry = {
  // Check if Sentry error boundary captured an error
  async checkSentryErrorCaptured(page) {
    // Look for Sentry React Error Boundary indicators
    const hasSentryBoundary = await page.locator('.sentry-error-boundary').count() > 0;
    const hasDataTestId = await page.locator('[data-testid="sentry-captured-error"]').count() > 0;
    return hasSentryBoundary || hasDataTestId;
  },

  // Verify error appears in Sentry dashboard (check network requests)
  async verifySentryNetworkRequest(page) {
    const sentryRequests = await page.waitForSelector('text=/sentry[^/]/i', {
      timeout: 3000,
    });
    return sentryRequests !== null;
  },
};

// Test IDs for data-testid attributes
exports.testIds = {
  landingPage: 'landing-page',
  navigationLink: (name) => `nav-${name}`,
  onboardingStart: 'onboarding-start',
  onboardingComplete: 'onboarding-complete',
  errorTriggerButton: 'trigger-error-boundary',
  sentryDashboardLink: 'sentry-dashboard',
};