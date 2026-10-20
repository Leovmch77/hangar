import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildSource } from './sidestore-source.mjs';

const input = {
  version: '0.1.0',
  buildVersion: 42,
  date: '2026-10-20T12:00:00Z',
  ipaUrl: 'https://github.com/jeffer1312/hangar/releases/download/mobile-latest/hangar.ipa',
  ipaSize: 1234,
  sha256: 'ab'.repeat(32),
  iconUrl: 'https://raw.githubusercontent.com/jeffer1312/hangar/main/mobile/assets/icon.png',
};

test('fonte AltStore com o app e a versão do build', () => {
  const source = buildSource(input);
  assert.equal(source.name, 'Hangar');
  const [app] = source.apps;
  assert.equal(app.bundleIdentifier, 'com.hangar.mobile');
  assert.ok(app.developerName);
  assert.ok(app.localizedDescription);
  assert.equal(app.iconURL, input.iconUrl);
  assert.deepEqual(app.versions[0], {
    version: '0.1.0',
    buildVersion: '42',
    date: input.date,
    downloadURL: input.ipaUrl,
    size: 1234,
    sha256: input.sha256,
  });
});

test('sem marketplaceID em nível nenhum', () => {
  assert.doesNotMatch(JSON.stringify(buildSource(input)), /marketplaceID/);
});
