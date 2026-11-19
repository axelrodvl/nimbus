// @vitest-environment node
import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

const eslint = new ESLint({ cwd: process.cwd() });

async function messages(code: string, filePath: string) {
  const [result] = await eslint.lintText(code, { filePath });
  return result?.messages ?? [];
}

describe('правила линта', () => {
  it("литерал '/api/…' в компоненте запрещён", async () => {
    const found = await messages("export const url = '/api/x';\n", 'src/components/x.tsx');
    expect(found.map(m => m.ruleId)).toContain('no-restricted-syntax');
  });

  it("шаблонная строка '/api/…' тоже", async () => {
    const found = await messages('export const url = (id: string) => `/api/x/${id}`;\n', 'src/screens/x.tsx');
    expect(found.map(m => m.ruleId)).toContain('no-restricted-syntax');
  });

  it('в lib/platform литерал разрешён', async () => {
    const found = await messages("export const url = '/api/x';\n", 'src/lib/platform/x.ts');
    expect(found).toEqual([]);
  });

  it('fetch в компоненте и импорт клиента API запрещены', async () => {
    const found = await messages(
      "import { api } from '@/lib/api/client';\nexport const f = () => fetch('x');\nexport const a = api;\n",
      'src/screens/x.tsx',
    );
    const rules = found.map(m => m.ruleId);
    expect(rules).toContain('no-restricted-globals');
    expect(rules).toContain('no-restricted-imports');
  });

  it('any запрещён', async () => {
    const found = await messages('export const x: any = 1;\n', 'src/lib/x.ts');
    expect(found.map(m => m.ruleId)).toContain('@typescript-eslint/no-explicit-any');
  });

  describe('граница AudioEngine', () => {
    it('HTMLAudioElement и new Audio вне web-engine запрещены (в компонентах и в lib)', async () => {
      for (const file of ['src/components/x.tsx', 'src/lib/x.ts']) {
        const found = await messages(
          'export const a = new Audio();\nexport const b = (x: unknown) => x instanceof HTMLAudioElement;\n',
          file,
        );
        expect(found.filter(m => m.ruleId === 'no-restricted-globals').length, file).toBeGreaterThanOrEqual(2);
      }
    });

    it('navigator.mediaSession и MediaMetadata вне media-session запрещены', async () => {
      const found = await messages(
        'export const m = navigator.mediaSession;\nexport const d = new MediaMetadata({});\n',
        'src/lib/player/x.ts',
      );
      expect(found.map(m => m.ruleId)).toEqual(
        expect.arrayContaining(['no-restricted-properties', 'no-restricted-globals']),
      );
    });

    it('в web-engine.ts и media-session.ts разрешены', async () => {
      const code = 'export const a = new Audio();\nexport const m = navigator.mediaSession;\n';
      expect(await messages(code, 'src/lib/player/audio/web-engine.ts')).toEqual([]);
      expect(await messages(code, 'src/lib/player/media-session.ts')).toEqual([]);
    });
  });
});
