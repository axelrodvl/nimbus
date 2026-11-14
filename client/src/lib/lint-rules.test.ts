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
});
