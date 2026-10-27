// Stryker Mutation Testing Configuration for 9router
// https://stryker-mutator.io/docs/stryker-js/setup/

module.exports = {
  // Mutation testing configuration
  // Use vitest as the test runner (vitest-runner plugin provides this)
  testRunner: 'vitest',

  // Files to mutate - production code only
  mutate: ['src/**/*.js'],

  // Files containing tests
  testFiles: ['tests/**/*.test.js'],

  // Reporters to use
  reporters: ['clear-text'],

  // Log level configuration
  logLevel: 'info',

  // Configuration for the vitest runner plugin
  plugins: [
    '@stryker-mutator/vitest-runner'
  ],

  // Disable checkers since we're using plain JS
  checkers: [],

  // Branch statements configuration - keep defaults
};