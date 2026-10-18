import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import plist from '@expo/plist';
import { afterEach, describe, expect, it } from 'vitest';

const workflow = readFileSync(new URL('../../.github/workflows/ios-dev.yml', import.meta.url), 'utf8');
const match = workflow.match(/python3 -I - Payload\/\*\.app <<'PY'\n([\s\S]*?)\n          PY/);
if (!match) throw new Error('Verificação do IPA não encontrada no workflow');
const verifyArtifact = match[1].split('\n').map((line) => line.slice(10)).join('\n');
const temporaryDirectories: string[] = [];

function releaseArtifact(channel = 'preview', runtime = '0.1.0') {
  const app = mkdtempSync(join(tmpdir(), 'hangar-ota-'));
  temporaryDirectories.push(app);
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

function verify(app: string) {
  return spawnSync('python3', ['-I', '-', app], { input: verifyArtifact, encoding: 'utf8' });
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('verificação OTA do IPA no GitHub', () => {
  it('aceita o Release com preview e runtime igual à versão do binário', () => {
    const result = verify(releaseArtifact());
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
  });

  it('recusa o Release que receberia updates do canal errado', () => {
    const result = verify(releaseArtifact('production'));
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('EXUpdatesRequestHeaders');
  });

  it.each(['', '0.2.0'])('recusa o Release com runtime diferente da versão do binário: %j', (runtime) => {
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
