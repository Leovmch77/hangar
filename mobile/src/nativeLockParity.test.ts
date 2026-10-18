import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const script = fileURLToPath(new URL('../scripts/check-native-locks.cjs', import.meta.url));
const directories: string[] = [];

function fixture(rootNativeVersion = '57.0.20') {
  const root = mkdtempSync(join(tmpdir(), 'hangar-native-locks-'));
  directories.push(root);
  mkdirSync(join(root, 'mobile/node_modules/expo/ios'), { recursive: true });
  mkdirSync(join(root, 'mobile/node_modules/expo/node_modules/expo-modules-core/ios'), { recursive: true });
  mkdirSync(join(root, 'mobile/node_modules/js-only'), { recursive: true });
  writeFileSync(join(root, 'package-lock.json'), JSON.stringify({ packages: {
    'node_modules/expo': { version: rootNativeVersion },
    'node_modules/expo/node_modules/expo-modules-core': { version: '57.0.16' },
    'node_modules/js-only': { version: '2.0.0' },
  } }));
  writeFileSync(join(root, 'mobile/package-lock.json'), JSON.stringify({ packages: {
    'node_modules/expo': { version: '57.0.20' },
    'node_modules/expo/node_modules/expo-modules-core': { version: '57.0.16' },
    'node_modules/js-only': { version: '1.0.0' },
  } }));
  return root;
}

function verify(root: string) {
  return spawnSync(process.execPath, [script, root], { encoding: 'utf8' });
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('paridade nativa entre os locks', () => {
  it('mantém os locks versionados com o mesmo código nativo', () => {
    const result = verify(fileURLToPath(new URL('../..', import.meta.url)));
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
  });

  it('aceita módulos nativos iguais mesmo com hoisting e diferenças só em JavaScript', () => {
    const result = verify(fixture());
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
  });

  it('identifica a versão nativa que difere entre o binário e a publicação', () => {
    const result = verify(fixture('57.0.21'));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('expo: raiz=57.0.21, mobile=57.0.20');
  });

  it('recusa uma dependência nativa transitiva ausente no lock da raiz', () => {
    const root = fixture();
    writeFileSync(join(root, 'package-lock.json'), JSON.stringify({ packages: {
      'node_modules/expo': { version: '57.0.20' },
    } }));
    const result = verify(root);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('expo-modules-core: raiz=ausente, mobile=57.0.16');
  });

  it('recusa cobertura incompleta com apenas parte dos pacotes instalada', () => {
    const root = fixture();
    rmSync(join(root, 'mobile/node_modules/expo/node_modules/expo-modules-core'), { recursive: true });
    const result = verify(root);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('expo > expo-modules-core: instalação incompleta');
  });
});
