import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';

// Tamanho de texto sai da escala do tema (`theme.base.text.*`), nunca de um número solto.
const ROOT = join(__dirname, '..', '..');

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return e.name === 'node_modules' || e.name === 'paraglide' || e.name === '__mocks__' ? [] : files(p);
    return /\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) ? [p] : [];
  });
}

it('nenhum fontSize fixo em app/ e src/', () => {
  const found = [join(ROOT, 'app'), join(ROOT, 'src')].flatMap(files).flatMap((f) =>
    readFileSync(f, 'utf8').split('\n').flatMap((line, i) => (/fontSize: ?\d/.test(line) ? [`${f.slice(ROOT.length + 1)}:${i + 1}`] : [])));
  expect(found).toEqual([]);
});
