import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const withPasteInput = createRequire(import.meta.url)('../plugins/withPasteInput.js');
const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const appDelegate = `internal import Expo
import React
import ReactAppDependencyProvider

@main
class AppDelegate: ExpoAppDelegate {
  var window: UIWindow?

  var reactNativeDelegate: ExpoReactNativeFactoryDelegate?
  var reactNativeFactory: RCTReactNativeFactory?

  public override func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    let delegate = ReactNativeDelegate()
    let factory = ExpoReactNativeFactory(delegate: delegate)
    delegate.dependencyProvider = RCTAppDependencyProvider()

    reactNativeDelegate = delegate
    reactNativeFactory = factory

#if os(iOS) || os(tvOS)
    window = UIWindow(frame: UIScreen.main.bounds)
    factory.startReactNative(
      withModuleName: "main",
      in: window,
      launchOptions: launchOptions)
#endif

    return super.application(application, didFinishLaunchingWithOptions: launchOptions)
  }
}

class ReactNativeDelegate: ExpoReactNativeFactoryDelegate {
  // Extension point for config-plugins

  override func sourceURL(for bridge: RCTBridge) -> URL? {
    // needed to return the correct URL for expo-dev-client.
    bridge.bundleURL ?? bundleURL()
  }

  override func bundleURL() -> URL? {
#if DEBUG
    return RCTBundleURLProvider.sharedSettings().jsBundleURL(forBundleRoot: ".expo/.virtual-metro-entry")
#else
    return Bundle.main.url(forResource: "main", withExtension: "jsbundle")
#endif
  }
}
`;
const podfile = `require File.join(File.dirname(\`node --print "require.resolve('expo/package.json')"\`), "scripts/autolinking")
require File.join(File.dirname(\`node --print "require.resolve('react-native/package.json')"\`), "scripts/react_native_pods")

platform :ios, '16.4'
prepare_react_native_project!
target 'Hangar' do
  use_expo_modules!
end
`;

async function runMod(modName: 'appDelegate' | 'podfile', contents: string, language = 'swift'): Promise<string> {
  const config = withPasteInput({ name: 'Hangar', slug: 'hangar' });
  const result = await config.mods.ios[modName]({
    ...config,
    modResults: { contents, language, path: modName === 'appDelegate' ? 'ios/Hangar/AppDelegate.swift' : 'ios/Podfile' },
    modRequest: { projectRoot, platformProjectRoot: `${projectRoot}/ios`, platform: 'ios', modName, introspect: false },
    modRawConfig: config,
  });
  return result.modResults.contents;
}

describe('withPasteInput', () => {
  it('configura a colagem em customize, depois que o Expo Updates criou o host', async () => {
    const swift = await runMod('appDelegate', appDelegate);
    const [application, delegate] = swift.split('class ReactNativeDelegate: ExpoReactNativeFactoryDelegate {');
    const customize = delegate.match(/override func customize\(_ rootView: UIView\) \{([\s\S]*?)^  \}/m)?.[1];

    expect(customize).toBeDefined();
    expect(delegate).toContain('weak var pasteInputRootViewFactory: RCTRootViewFactory?');
    const binding = application.indexOf('delegate.pasteInputRootViewFactory = factory.rootViewFactory');
    expect(binding).toBeGreaterThan(application.indexOf('let factory = ExpoReactNativeFactory(delegate: delegate)'));
    expect(binding).toBeLessThan(application.indexOf('factory.startReactNative('));
    expect(application).not.toMatch(/NSClassFromString|perform\(|setup:/);
    expect(customize).toMatch(/super\.customize\(rootView\)[\s\S]*perform\(NSSelectorFromString\("setup:"\), with: rootViewFactory\)/);
    expect(customize).toMatch(/guard let rootViewFactory = pasteInputRootViewFactory else \{\s*fatalError\("[^"]+"\)/);
    expect(customize).toMatch(/guard let pasteInput = NSClassFromString\("PasteInputModule"\) else \{\s*fatalError\("[^"]+"\)/);
    expect(swift.match(/NSSelectorFromString\("setup:"\)/g)).toHaveLength(1);
    expect(swift).toContain('bridge.bundleURL ?? bundleURL()');
  });

  it('preserva a nova arquitetura e não duplica a geração de Swift nem Podfile', async () => {
    const swift = await runMod('appDelegate', appDelegate);
    const generatedPodfile = await runMod('podfile', podfile);

    expect(await runMod('appDelegate', swift)).toBe(swift);
    expect(generatedPodfile).toBe(`ENV['RCT_NEW_ARCH_ENABLED'] = '1'\n${podfile}`);
    expect(await runMod('podfile', generatedPodfile)).toBe(generatedPodfile);
  });

  it.each([
    ['delegate.dependencyProvider = RCTAppDependencyProvider()', 'dependencyProvider'],
    ['class ReactNativeDelegate: ExpoReactNativeFactoryDelegate {', 'ReactNativeDelegate'],
    ['factory.startReactNative(', 'factory.startReactNative'],
  ])('recusa AppDelegate sem a âncora %s', async (anchor, error) => {
    await expect(runMod('appDelegate', appDelegate.replace(anchor, ''))).rejects.toThrow(`withPasteInput: ${error}`);
  });
});
