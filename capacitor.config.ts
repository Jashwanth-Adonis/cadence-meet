import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'app.cadencemeet.recorder',
  appName: 'Cadence Meet',
  webDir: 'dist',
  backgroundColor: '#090D16',
  android: {
    allowMixedContent: false,
    backgroundColor: '#090D16',
    captureInput: true,
    webContentsDebuggingEnabled: false,
  },
  server: {
    androidScheme: 'https',
  },
};

export default config;
