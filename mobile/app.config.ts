import type { ConfigContext, ExpoConfig } from 'expo/config';

// O google-services.json não entra no git: o EAS entrega o caminho pela variável de ambiente.
export default ({ config }: ConfigContext): ExpoConfig => ({
  ...config,
  android: {
    ...config.android,
    googleServicesFile: process.env.GOOGLE_SERVICES_JSON ?? config.android?.googleServicesFile,
  },
}) as ExpoConfig;
