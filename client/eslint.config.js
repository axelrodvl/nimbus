import js from '@eslint/js';
import reactHooks from 'eslint-plugin-react-hooks';
import { defineConfig, globalIgnores } from 'eslint/config';
import tseslint from 'typescript-eslint';

const NET_MESSAGE =
  'Сеть — только через src/lib/** (слой API и хуки TanStack Query): компонент не вызывает fetch напрямую.';

const AUDIO_MESSAGE =
  'Звук и Media Session — только за интерфейсом AudioEngine: HTMLAudioElement и mediaSession допустимы лишь в src/lib/player/audio/web-engine.ts и src/lib/player/media-session.ts.';
const AUDIO_GLOBALS = ['Audio', 'HTMLAudioElement', 'HTMLMediaElement', 'MediaMetadata'].map(name => ({
  message: AUDIO_MESSAGE,
  name,
}));

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
    files: ['src/**/*.{ts,tsx}'],
    ignores: ['src/lib/player/audio/web-engine.ts', 'src/lib/player/media-session.ts', 'src/**/*.test.*', 'src/test/**'],
    rules: {
      'no-restricted-globals': ['error', ...AUDIO_GLOBALS],
      'no-restricted-properties': ['error', { message: AUDIO_MESSAGE, property: 'mediaSession' }],
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
      'no-restricted-globals': ['error', { message: NET_MESSAGE, name: 'fetch' }, ...AUDIO_GLOBALS],
      'no-restricted-imports': ['error', { patterns: [{ group: ['@/lib/api/client'], message: NET_MESSAGE }] }],
      // Правило одного ключа в следующем блоке заменяет предыдущее, поэтому `no-restricted-syntax` повторяется.
      'no-restricted-syntax': ['error', ...API_LITERALS],
    },
  },
]);
