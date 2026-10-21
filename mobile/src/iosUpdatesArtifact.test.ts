import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import plist from '@expo/plist';
import { afterEach, describe, expect, it } from 'vitest';

const workflow = readFileSync(new URL('../../.github/workflows/ios-dev.yml', import.meta.url), 'utf8');
const match = workflow.match(/python3 -I - \.\.\/app\.json Payload\/\*\.app <<'PY'\n([\s\S]*?)\n          PY/);
if (!match) throw new Error('Verificação do IPA não encontrada no workflow');
const verifyArtifact = match[1].split('\n').map((line) => line.slice(10)).join('\n');
const temporaryDirectories: string[] = [];

function releaseArtifact(channel = 'preview', runtime = 'native-2', configuredRuntime = 'native-2') {
  const directory = mkdtempSync(join(tmpdir(), 'hangar-ota-'));
  temporaryDirectories.push(directory);
  writeFileSync(join(directory, 'app.json'), JSON.stringify({ expo: { runtimeVersion: configuredRuntime } }));
  const app = join(directory, 'Hangar.app');
  mkdirSync(app);
  writeFileSync(join(app, 'main.jsbundle'), Buffer.from('c61fbc03c103191f', 'hex'));
  writeFileSync(join(app, 'Info.plist'), plist.build({ CFBundleShortVersionString: '0.1.0' }));
  writeFileSync(join(app, 'Expo.plist'), plist.build({
    EXUpdatesEnabled: true,
    EXUpdatesURL: 'https://u.expo.dev/9fd06001-323e-4b82-835f-6dfc3674236d',
    EXUpdatesRequestHeaders: { 'expo-channel-name': channel },
    EXUpdatesRuntimeVersion: runtime,
    EXUpdatesCheckOnLaunch: 'ALWAYS',
    EXUpdatesLaunchWaitMs: 0,
  }));
  mkdirSync(join(app, 'EXUpdates.bundle'));
  writeFileSync(join(app, 'EXUpdates.bundle/app.manifest'), JSON.stringify({
    id: 'd3e4d147-d36a-41aa-97a2-8d5bef32dc33',
    commitTime: 1792282800000,
    assets: [],
  }));
  return app;
}

// O CI sempre define GITHUB_RUN_NUMBER; o passo grava esse número no CFBundleVersion.
const RUN_NUMBER = '4242';

function verify(app: string) {
  return spawnSync('python3', ['-I', '-', join(app, '../app.json'), app],
    { input: verifyArtifact, encoding: 'utf8', env: { ...process.env, GITHUB_RUN_NUMBER: RUN_NUMBER } });
}

// O Info.plist sai em formato binário, que o @expo/plist não lê.
function bundleVersion(app: string) {
  const read = 'import plistlib, sys; print(plistlib.load(open(sys.argv[1], "rb"))["CFBundleVersion"])';
  return spawnSync('python3', ['-I', '-c', read, join(app, 'Info.plist')], { encoding: 'utf8' }).stdout.trim();
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('verificação OTA do IPA no GitHub', () => {
  it('aceita o Release com preview e runtime nativo independente da versão visível', () => {
    const app = releaseArtifact();
    const result = verify(app);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(bundleVersion(app)).toBe(RUN_NUMBER);
  });

  it('aceita o Release quando app.json e artefato usam native-3', () => {
    const result = verify(releaseArtifact('preview', 'native-3', 'native-3'));
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
  });

  it('recusa o Release que receberia updates do canal errado', () => {
    const result = verify(releaseArtifact('production'));
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('EXUpdatesRequestHeaders');
  });

  it.each(['0.1.0', '', 'native-1'])('recusa o Release com runtime diferente do app.json: %j', (runtime) => {
    const result = verify(releaseArtifact('preview', runtime));
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('EXUpdatesRuntimeVersion');
  });

  it('recusa o Release sem o manifesto embutido necessário para abrir offline', () => {
    const app = releaseArtifact();
    rmSync(join(app, 'EXUpdates.bundle/app.manifest'));
    const result = verify(app);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('app.manifest');
  });

  it.each(['not-json', '{}'])('recusa o Release com manifesto inválido: %j', (manifest) => {
    const app = releaseArtifact();
    writeFileSync(join(app, 'EXUpdates.bundle/app.manifest'), manifest);
    const result = verify(app);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('app.manifest');
  });

  it.each([
    { id: 'not-a-uuid', commitTime: 1792282800000, assets: [] },
    { id: 'd3e4d147-d36a-41aa-97a2-8d5bef32dc33', assets: [] },
    { id: 'd3e4d147-d36a-41aa-97a2-8d5bef32dc33', commitTime: 1792282800000, assets: [{}] },
  ])('recusa manifesto que o carregador nativo rejeitaria: %j', (manifest) => {
    const app = releaseArtifact();
    writeFileSync(join(app, 'EXUpdates.bundle/app.manifest'), JSON.stringify(manifest));
    const result = verify(app);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('app.manifest');
  });
});
