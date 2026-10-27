/** @type {import('playwright/test').PlaywrightTestConfig} */
const config = {
  testDir: './tests/e2e',
  testMatch: '**/*-test.js',
  timeout: 30000,
  retries: 0,
  expect: {
    timeout: 5000,
  },

  use: {
    // Base URL will be overridden by process.env.BASE_URL in test files
    baseURL: 'http://localhost:20127',
    // Collect artifacts after each test
    trace: 'on-first-retry',
    // screenshot: 'only-on-failure',
  },

  projects: [
    {
      name: 'Chromium',
      use: {
        baseURL: 'http://localhost:20127',
        trace: 'on-first-retry',
        browserName: 'chromium',
      },
    },
    {
      name: 'Firefox',
      use: {
        baseURL: 'http://localhost:20127',
        trace: 'on-first-retry',
        browserName: 'firefox',
      },
    },
    {
      name: 'WebKit',
      use: {
        baseURL: 'http://localhost:20127',
        trace: 'on-first-retry',
        browserName: 'webkit',
      },
    },
  ],

  // Run tests in parallel
  parallel: true,
};

module.exports = config;