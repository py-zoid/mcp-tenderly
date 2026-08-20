// Flat config (ESLint 9). Type-aware linting is deliberately scoped to src/ and
// tests/ so config files at the repo root do not need to appear in tsconfig.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', 'coverage/**'] },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  {
    files: ['src/**/*.ts', 'tests/**/*.ts'],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      // The Tenderly API is a third-party boundary we cannot version-lock, so
      // template literals legitimately interpolate values typed as unknown-ish
      // after lenient parsing. The formatter guards these explicitly.
      '@typescript-eslint/restrict-template-expressions': [
        'error',
        { allowNumber: true, allowBoolean: true },
      ],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  {
    // Config files are not part of the type-aware program.
    files: ['*.js', '*.ts'],
    ...tseslint.configs.disableTypeChecked,
  },
  prettier
);
