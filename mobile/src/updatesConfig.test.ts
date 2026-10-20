import { fileURLToPath } from 'node:url';
import { getPrebuildConfigAsync } from '@expo/prebuild-config';
import { getConfig } from 'expo/config';
import { AndroidConfig, IOSConfig, compileModsAsync } from 'expo/config-plugins';
import { describe, expect, it } from 'vitest';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const { exp: config } = getConfig(projectRoot);
const updateUrl = 'https://u.expo.dev/9fd06001-323e-4b82-835f-6dfc3674236d';

describe('OTA na configuração nativa', () => {
  it('gera o IPA local no canal preview com runtime nativo explícito e sem esperar a rede', async () => {
    const plist = await IOSConfig.Updates.setUpdatesConfigAsync(projectRoot, config, {}, null);

    expect(plist).toMatchObject({
      EXUpdatesEnabled: true,
      EXUpdatesURL: updateUrl,
      EXUpdatesRequestHeaders: { 'expo-channel-name': 'preview' },
      EXUpdatesRuntimeVersion: 'native-3',
      EXUpdatesCheckOnLaunch: 'ALWAYS',
      EXUpdatesLaunchWaitMs: 0,
    });
    expect(plist.EXUpdatesHasEmbeddedUpdate).not.toBe(false);
  });

  it('preserva o runtime quando só a versão visível do app muda', async () => {
    const nextConfig = { ...config, version: '0.2.0' };
    const plist = await IOSConfig.Updates.setUpdatesConfigAsync(projectRoot, nextConfig, {}, null);
    expect(plist.EXUpdatesRuntimeVersion).toBe('native-3');
  });

  it('muda o runtime quando a versão nativa explícita sobe', async () => {
    const nextConfig = { ...config, runtimeVersion: 'native-4' };
    const plist = await IOSConfig.Updates.setUpdatesConfigAsync(projectRoot, nextConfig, {}, null);
    expect(plist.EXUpdatesRuntimeVersion).toBe('native-4');
  });

  it('gera o Android com a mesma busca automática e o runtime nativo explícito', async () => {
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
    expect(strings.resources.string).toContainEqual({ $: { name: 'expo_runtime_version' }, _: 'native-3' });
  });
});

// O introspect roda os config plugins sem prebuild, como o `expo config --type introspect`.
async function generatedNative() {
  const { exp } = await getPrebuildConfigAsync(projectRoot, { platforms: ['ios', 'android'] });
  const out = await compileModsAsync(exp, {
    projectRoot,
    introspect: true,
    platforms: ['ios', 'android'],
    assertMissingModProviders: false,
  });
  // Campo interno do Expo, o mesmo que o `expo config --type introspect` lê.
  const results = (out as any)._internal.modResults;
  return { plist: results.ios.infoPlist, entitlements: results.ios.entitlements, manifest: results.android.manifest };
}

const pluginOptions = (name: string) => {
  const entry = config.plugins?.find((p) => (Array.isArray(p) ? p[0] : p) === name);
  return Array.isArray(entry) ? entry[1] : entry;
};

describe('native-3: tablet, ditado em segundo plano e push', () => {
  it('iPhone só em retrato e iPad nas quatro orientações', async () => {
    const { plist } = await generatedNative();
    expect(config.orientation).toBe('portrait');
    expect(config.ios?.supportsTablet).toBe(true);
    expect(plist.UISupportedInterfaceOrientations).toEqual(['UIInterfaceOrientationPortrait']);
    expect(plist['UISupportedInterfaceOrientations~ipad']).toEqual([
      'UIInterfaceOrientationPortrait',
      'UIInterfaceOrientationPortraitUpsideDown',
      'UIInterfaceOrientationLandscapeLeft',
      'UIInterfaceOrientationLandscapeRight',
    ]);
  }, 60_000);

  it('Android grava em segundo plano pelo serviço do expo-audio', async () => {
    expect(pluginOptions('expo-audio')).toMatchObject({ enableBackgroundRecording: true });
    const { manifest } = await generatedNative();
    const services = manifest.manifest.application[0].service ?? [];
    expect(services).toContainEqual(expect.objectContaining({
      $: expect.objectContaining({
        'android:name': 'expo.modules.audio.service.AudioRecordingService',
        'android:foregroundServiceType': 'microphone',
      }),
    }));
    const permissions = manifest.manifest['uses-permission'].map((p: any) => p.$['android:name']);
    expect(permissions).toContain('android.permission.FOREGROUND_SERVICE_MICROPHONE');
  }, 60_000);

  it('traz o plugin do expo-notifications', () => {
    expect(config.plugins?.some((p) => (Array.isArray(p) ? p[0] : p) === 'expo-notifications')).toBe(true);
  });

  it('iOS sai sem o entitlement de push, que o SideStore com Apple ID gratuito não assina', async () => {
    const { entitlements } = await generatedNative();
    expect(entitlements).toBeDefined();
    expect(entitlements).not.toHaveProperty('aps-environment');
  }, 60_000);

  it('lê o google-services.json do ambiente do EAS', () => {
    process.env.GOOGLE_SERVICES_JSON = '/tmp/x.json';
    try {
      expect(getConfig(projectRoot).exp.android?.googleServicesFile).toBe('/tmp/x.json');
    } finally {
      delete process.env.GOOGLE_SERVICES_JSON;
    }
  });
});
