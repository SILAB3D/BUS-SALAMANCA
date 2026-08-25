import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  /*
   * appId ES el applicationId de Android, la identidad de la app instalada. No
   * se renombra a "salbus" a proposito: cambiarlo dejaria la app instalada sin
   * ruta de actualizacion y sin sus datos. El nombre del paquete de codigo si
   * es com.icuas.salbus (ver android/app/build.gradle).
   */
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
