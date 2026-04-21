/**
 * ESLint 9 flat config for CHM Finance.
 * - Backend: Node-targeted, CJS.
 * - Frontend: browser globals, script-type (no modules yet).
 * - Tests: vitest globals.
 *
 * Config intentionally non-strict while the codebase migrates — only
 * real correctness bugs are errors; style is warn-or-off.
 */

// Inline recommended rules — no dependency on @eslint/js so this works
// whether eslint is installed at root or only in backend/node_modules.
const RECOMMENDED = {
  'constructor-super': 'error',
  'for-direction': 'error',
  'getter-return': 'error',
  'no-async-promise-executor': 'error',
  'no-case-declarations': 'error',
  'no-class-assign': 'error',
  'no-compare-neg-zero': 'error',
  'no-cond-assign': 'error',
  'no-const-assign': 'error',
  'no-constant-condition': 'error',
  'no-control-regex': 'error',
  'no-debugger': 'error',
  'no-delete-var': 'error',
  'no-dupe-args': 'error',
  'no-dupe-class-members': 'error',
  'no-dupe-else-if': 'error',
  'no-dupe-keys': 'error',
  'no-duplicate-case': 'error',
  'no-empty': 'error',
  'no-empty-character-class': 'error',
  'no-empty-pattern': 'error',
  'no-ex-assign': 'error',
  'no-extra-boolean-cast': 'error',
  'no-fallthrough': 'error',
  'no-func-assign': 'error',
  'no-global-assign': 'error',
  'no-import-assign': 'error',
  'no-invalid-regexp': 'error',
  'no-irregular-whitespace': 'error',
  'no-loss-of-precision': 'error',
  'no-misleading-character-class': 'error',
  'no-mixed-spaces-and-tabs': 'error',
  'no-new-symbol': 'error',
  'no-nonoctal-decimal-escape': 'error',
  'no-obj-calls': 'error',
  'no-octal': 'error',
  'no-redeclare': 'error',
  'no-regex-spaces': 'error',
  'no-self-assign': 'error',
  'no-setter-return': 'error',
  'no-sparse-arrays': 'error',
  'no-this-before-super': 'error',
  'no-undef': 'error',
  'no-unexpected-multiline': 'error',
  'no-unreachable': 'error',
  'no-unsafe-finally': 'error',
  'no-unsafe-negation': 'error',
  'no-unsafe-optional-chaining': 'error',
  'no-unused-labels': 'error',
  'no-unused-vars': 'warn',
  'no-useless-backreference': 'error',
  'no-useless-catch': 'error',
  'no-useless-escape': 'warn',
  'no-with': 'error',
  'require-yield': 'error',
  'use-isnan': 'error',
  'valid-typeof': 'error',
};

const BROWSER_GLOBALS = {
  window: 'readonly', document: 'readonly', navigator: 'readonly',
  location: 'readonly', history: 'readonly', localStorage: 'readonly',
  sessionStorage: 'readonly', fetch: 'readonly', FormData: 'readonly',
  URLSearchParams: 'readonly', URL: 'readonly', setTimeout: 'readonly',
  setInterval: 'readonly', clearTimeout: 'readonly', clearInterval: 'readonly',
  requestAnimationFrame: 'readonly', cancelAnimationFrame: 'readonly',
  matchMedia: 'readonly', performance: 'readonly', IntersectionObserver: 'readonly',
  ResizeObserver: 'readonly', MutationObserver: 'readonly', WebSocket: 'readonly',
  Notification: 'readonly', console: 'readonly', alert: 'readonly',
  confirm: 'readonly', atob: 'readonly', btoa: 'readonly',
  Event: 'readonly', CustomEvent: 'readonly', HTMLElement: 'readonly',
  Chart: 'readonly',
  // App globals
  Auth: 'readonly', API: 'readonly', Toast: 'readonly', Fmt: 'readonly',
  I18n: 'readonly', Promos: 'readonly',
};

const NODE_GLOBALS = {
  process: 'readonly', require: 'readonly', module: 'writable',
  exports: 'writable', __dirname: 'readonly', __filename: 'readonly',
  Buffer: 'readonly', global: 'readonly', console: 'readonly',
  setTimeout: 'readonly', setInterval: 'readonly',
  clearTimeout: 'readonly', clearInterval: 'readonly', setImmediate: 'readonly',
  URL: 'readonly', URLSearchParams: 'readonly', fetch: 'readonly',
};

const TEST_GLOBALS = {
  describe: 'readonly', it: 'readonly', test: 'readonly', expect: 'readonly',
  beforeEach: 'readonly', afterEach: 'readonly',
  beforeAll: 'readonly', afterAll: 'readonly',
  vi: 'readonly',
};

const BASE_RULES = {
  ...RECOMMENDED,
  'no-unused-vars': ['warn', {
    argsIgnorePattern: '^_',
    varsIgnorePattern: '^_',
    caughtErrorsIgnorePattern: '^_',
  }],
  'no-empty': ['warn', { allowEmptyCatch: false }],
  'no-constant-condition': ['error', { checkLoops: false }],
  'no-var': 'warn',
  'prefer-const': 'warn',
  'no-throw-literal': 'error',
  'no-unreachable': 'error',
  'no-fallthrough': 'error',
  'no-dupe-keys': 'error',
  'no-duplicate-case': 'error',
  'eqeqeq': ['warn', 'smart'],
  'no-console': 'off',
  // Too strict for current codebase — revisit later
  'no-prototype-builtins': 'off',
  'no-useless-escape': 'off',
  'no-cond-assign': ['error', 'except-parens'],
  'no-inner-declarations': 'off',
};

module.exports = [
  {
    ignores: [
      'node_modules/**',
      '**/node_modules/**',
      'backend/data/**',
      'backend/logs/**',
      'backend/backups/**',
      'frontend/assets/vendor/**',
      'frontend/tailwind.css',
      '**/*.min.js',
      'phase_*.md',
      'academy/**',
    ],
  },
  {
    files: ['backend/**/*.js', 'scripts/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: NODE_GLOBALS,
    },
    rules: BASE_RULES,
  },
  {
    files: ['backend/tests/**/*.js', 'backend/**/*.test.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: { ...NODE_GLOBALS, ...TEST_GLOBALS },
    },
    rules: BASE_RULES,
  },
  {
    files: ['frontend/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'script',
      globals: BROWSER_GLOBALS,
    },
    rules: BASE_RULES,
  },
];
