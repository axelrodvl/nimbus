import js from '@eslint/js';
import reactHooks from 'eslint-plugin-react-hooks';
import { defineConfig, globalIgnores } from 'eslint/config';
import tseslint from 'typescript-eslint';

const NET_MESSAGE =
  'Сеть — только через src/lib/** (слой API и хуки TanStack Query): компонент не вызывает fetch напрямую.';

const API_MESSAGE = "Литерал '/api/…' запрещён: адрес бэкенда строится через apiUrl()/wsUrl() из '@/lib/platform/urls'.";
const API_LITERALS = [
  { message: API_MESSAGE, selector: 'Literal[value=/^\\/api\\//]' },
  { message: API_MESSAGE, selector: 'TemplateElement[value.raw=/^\\/api\\//]' },
];

export default defineConfig([
  globalIgnores(['dist/**', 'coverage/**', 'playwright-report/**', 'test-results/**', 'node_modules/**', 'src/lib/api/schema.d.ts']),
  js.configs.recommended,
  tseslint.configs.strict,
  reactHooks.configs.flat.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    rules: {
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', ignoreRestSiblings: true }],
      'no-console': 'error',
    },
  },
  {
    // Адреса бэкенда строятся только в lib/platform и lib/api (apiUrl/wsUrl); тесты и мок могут их называть.
    ignores: ['src/lib/platform/**', 'src/lib/api/**', 'src/**/*.test.*', 'tests/**', 'src/test/**', '*.config.ts'],
    files: ['**/*.{ts,tsx}'],
    rules: {
      'no-restricted-syntax': ['error', ...API_LITERALS],
    },
  },
  {
    // В тестах утверждение «значение есть» — часть проверки: падение теста точнее любой защитной ветки.
    files: ['**/*.test.{ts,tsx}', 'src/test/**', 'tests/**'],
    rules: { '@typescript-eslint/no-non-null-assertion': 'off' },
  },
  {
    files: ['src/screens/**/*.{ts,tsx}', 'src/components/**/*.{ts,tsx}'],
    ignores: ['src/**/*.test.*'],
    rules: {
      'no-restricted-globals': ['error', { message: NET_MESSAGE, name: 'fetch' }],
      'no-restricted-imports': ['error', { patterns: [{ group: ['@/lib/api/client'], message: NET_MESSAGE }] }],
      // Правило одного ключа в следующем блоке заменяет предыдущее, поэтому `no-restricted-syntax` повторяется.
      'no-restricted-syntax': ['error', ...API_LITERALS],
    },
  },
]);
