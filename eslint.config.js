import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  // 'import' holds vendored third-party Phaser demos (phaser.min.js et al) — not our code.
  // Linting them produced ~1480 of ~1554 errors and buried real findings in src/.
  // 'ai-orchestration-review' is an untracked browsing copy of pipeline files —
  // linting it double-counts every src/ finding.
  globalIgnores(['dist', 'import', 'scratch', 'generated_test_assets', 'ai-orchestration-review']),
  // api/ holds Vercel serverless functions — Node runtime, not the browser.
  {
    files: ['api/**/*.js'],
    languageOptions: { globals: globals.node },
  },
  {
    files: ['**/*.{js,jsx}'],
    extends: [
      js.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
      parserOptions: {
        ecmaVersion: 'latest',
        ecmaFeatures: { jsx: true },
        sourceType: 'module',
      },
    },
    rules: {
      'no-unused-vars': ['error', { varsIgnorePattern: '^[A-Z_]' }],
    },
  },
])
