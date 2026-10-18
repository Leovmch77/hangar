import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';

const { assertSingleReact } = createRequire(import.meta.url)('../scripts/single-react.cjs') as {
  assertSingleReact: (mobileDir: string) => void;
};
const directories: string[] = [];
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function tree(...installs: ('root' | 'mobile')[]) {
  const root = mkdtempSync(join(tmpdir(), 'hangar-single-react-'));
  directories.push(root);
  mkdirSync(join(root, 'mobile'));
  for (const where of installs) {
    const dir = join(root, where === 'root' ? '' : 'mobile', 'node_modules/react');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'package.json'), '{"name":"react"}');
  }
  return join(root, 'mobile');
}

it('uma instalação só, na raiz ou em mobile/, segue', () => {
  expect(() => assertSingleReact(tree('root'))).not.toThrow();
  expect(() => assertSingleReact(tree('mobile'))).not.toThrow();
});

it('React na raiz e em mobile/ recusa o bundle e diz o que apagar', () => {
  expect(() => assertSingleReact(tree('root', 'mobile'))).toThrow(/mobile\/node_modules/);
});
