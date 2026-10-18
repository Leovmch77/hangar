import { fileURLToPath } from 'node:url';
import { getConfig } from 'expo/config';
import { AndroidConfig, IOSConfig } from 'expo/config-plugins';
import { describe, expect, it } from 'vitest';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const { exp: config } = getConfig(projectRoot);
const updateUrl = 'https://u.expo.dev/9fd06001-323e-4b82-835f-6dfc3674236d';

describe('OTA na configuração nativa', () => {
  it('gera o IPA local no canal preview com runtime da versão do app e sem esperar a rede', async () => {
    const plist = await IOSConfig.Updates.setUpdatesConfigAsync(projectRoot, config, {}, null);

    expect(plist).toMatchObject({
      EXUpdatesEnabled: true,
      EXUpdatesURL: updateUrl,
      EXUpdatesRequestHeaders: { 'expo-channel-name': 'preview' },
      EXUpdatesRuntimeVersion: '0.1.0',
      EXUpdatesCheckOnLaunch: 'ALWAYS',
      EXUpdatesLaunchWaitMs: 0,
    });
    expect(plist.EXUpdatesHasEmbeddedUpdate).not.toBe(false);
  });

  it('muda o runtime quando a versão do app sobe para um novo binário nativo', async () => {
    const nextConfig = { ...config, version: '0.2.0' };
    const plist = await IOSConfig.Updates.setUpdatesConfigAsync(projectRoot, nextConfig, {}, null);
    expect(plist.EXUpdatesRuntimeVersion).toBe('0.2.0');
  });

  it('gera o Android com a mesma busca automática e o runtime da versão do app', async () => {
    const manifest = await AndroidConfig.Updates.setUpdatesConfigAsync(projectRoot, config, {
      manifest: {
        $: { 'xmlns:android': 'http://schemas.android.com/apk/res/android' },
        queries: [],
        application: [{ $: { 'android:name': '.MainApplication' } }],
      },
    }, null);
    const metadata = Object.fromEntries(
      manifest.manifest.application![0]['meta-data']!.map(({ $: entry }) => [entry['android:name'], entry['android:value']]),
    );
    const strings = await AndroidConfig.Updates.applyRuntimeVersionFromConfigForProjectRootAsync(projectRoot, config, { resources: {} });

    expect(metadata).toMatchObject({
      'expo.modules.updates.ENABLED': 'true',
      'expo.modules.updates.EXPO_UPDATE_URL': updateUrl,
      'expo.modules.updates.UPDATES_CONFIGURATION_REQUEST_HEADERS_KEY': '{"expo-channel-name":"preview"}',
      'expo.modules.updates.EXPO_UPDATES_CHECK_ON_LAUNCH': 'ALWAYS',
      'expo.modules.updates.EXPO_UPDATES_LAUNCH_WAIT_MS': '0',
    });
    expect(strings.resources.string).toContainEqual({ $: { name: 'expo_runtime_version' }, _: '0.1.0' });
  });
});
