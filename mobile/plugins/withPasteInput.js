const { withAppDelegate, withPodfile } = require('expo/config-plugins');

const SETUP = `
  weak var pasteInputRootViewFactory: RCTRootViewFactory?

  override func customize(_ rootView: UIView) {
    super.customize(rootView)
    // O Expo Updates cria o host depois de startReactNative.
    guard let rootViewFactory = pasteInputRootViewFactory else {
      fatalError("withPasteInput: rootViewFactory ausente em customize")
    }
    // O header da lib puxa C++, que o Swift não importa.
    guard let pasteInput = NSClassFromString("PasteInputModule") else {
      fatalError("withPasteInput: PasteInputModule ausente")
    }
    _ = (pasteInput as AnyObject).perform(NSSelectorFromString("setup:"), with: rootViewFactory)
  }
`;
const ANCHOR = /(factory\.startReactNative\([\s\S]*?launchOptions: launchOptions\))/;
const FACTORY_ANCHOR = '    delegate.dependencyProvider = RCTAppDependencyProvider()';
const DELEGATE_ANCHOR = 'class ReactNativeDelegate: ExpoReactNativeFactoryDelegate {';

// O podspec da lib recusa instalar sem RCT_NEW_ARCH_ENABLED=1, mas o RN atual só tem a arquitetura
// nova e não define mais a variável: sem ela o pod install falha.
const NEW_ARCH = "ENV['RCT_NEW_ARCH_ENABLED'] = '1'";

const withAppDelegateSetup = (config) => withAppDelegate(config, (cfg) => {
  const { language, contents } = cfg.modResults;
  if (language !== 'swift') throw new Error('withPasteInput: AppDelegate em Swift esperado, veio ' + language);
  if (!ANCHOR.test(contents)) throw new Error('withPasteInput: factory.startReactNative não encontrado no AppDelegate');
  if (!contents.includes(FACTORY_ANCHOR)) throw new Error('withPasteInput: dependencyProvider não encontrado no AppDelegate');
  if (!contents.includes(DELEGATE_ANCHOR)) throw new Error('withPasteInput: ReactNativeDelegate não encontrado no AppDelegate');
  if (contents.includes('weak var pasteInputRootViewFactory: RCTRootViewFactory?')) return cfg;
  cfg.modResults.contents = contents
    .replace(FACTORY_ANCHOR, `${FACTORY_ANCHOR}\n    delegate.pasteInputRootViewFactory = factory.rootViewFactory`)
    .replace(DELEGATE_ANCHOR, `${DELEGATE_ANCHOR}${SETUP}`);
  return cfg;
});

const withNewArchEnv = (config) => withPodfile(config, (cfg) => {
  if (!cfg.modResults.contents.includes(NEW_ARCH)) cfg.modResults.contents = `${NEW_ARCH}\n${cfg.modResults.contents}`;
  return cfg;
});

module.exports = (config) => withNewArchEnv(withAppDelegateSetup(config));
