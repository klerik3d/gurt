import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  { ignores: ['out/**', 'dist/**', 'node_modules/**', 'resources/**'] },

  js.configs.recommended,

  // TypeScript sources. `projectService` resolves each file to its real project
  // through the solution-style tsconfig.json (node config for main/preload/
  // shared, web config for the renderer), which is what the type-aware rules
  // below need.
  {
    files: ['src/**/*.{ts,tsx}', 'electron.vite.config.ts'],
    extends: [tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname }
    },
    rules: {
      // tsc already resolves every identifier, and no-undef cannot see type-only
      // declarations — leaving it on only produces false positives here.
      'no-undef': 'off',
      // `_name` is the codebase's existing "deliberately unused" marker — the
      // omit half of a rest destructuring, a parameter kept for its position.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }
      ],
      // Off by design, not by surrender. Nearly every `async` without an `await`
      // in this codebase is satisfying a promise-returning contract somebody
      // else declared — the GurtApi surface reached over ipcMain.handle, the
      // ForgeProvider seam, an MCP SDK tool handler — where dropping `async`
      // would be a type error, not a cleanup. The rule cannot see the contract,
      // so it only ever fires on those.
      '@typescript-eslint/require-await': 'off'
    }
  },

  {
    files: ['src/main/**/*.ts', 'src/preload/**/*.ts', 'src/shared/**/*.ts', 'electron.vite.config.ts'],
    languageOptions: { globals: globals.node }
  },

  {
    files: ['src/renderer/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    languageOptions: { globals: globals.browser },
    rules: {
      // The two classic hook rules. The rest of the plugin's `recommended`
      // preset is the React Compiler rule set; this app does not run the
      // compiler, so those are out of scope here.
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'error'
    }
  },

  // Test and smoke scripts: plain ESM run straight through node, not part of a
  // tsconfig, so the type-aware rules cannot apply. Playwright smoke drivers
  // pass browser-context callbacks to page.evaluate(), hence the DOM globals.
  {
    files: ['scripts/**/*.mjs'],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: { globals: { ...globals.node, ...globals.browser } }
  }
)
