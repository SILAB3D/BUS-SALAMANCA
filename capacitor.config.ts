import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.icuas.bussalamanca',
  appName: 'SALBUS',
  webDir: 'dist',
  server: {
    androidScheme: 'https',
    allowNavigation: ['salamancadetransportes.com'],
  },
  plugins: {
    CapacitorHttp: {
      enabled: true,
    },
  },
};

export default config;
