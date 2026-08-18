import { defineConfig } from 'vite'

/**
 * En Android la app llama directamente a la web oficial mediante CapacitorHttp,
 * que no esta sujeto a CORS. En el navegador (npm run dev) si lo esta, asi que se
 * enruta por este proxy, que ademas inyecta el User-Agent de navegador que la
 * fuente oficial exige (sin el responde 403).
 */
export default defineConfig({
  server: {
    proxy: {
      '/api/arrivals': {
        target: 'https://salamancadetransportes.com',
        changeOrigin: true,
        secure: true,
        rewrite: (path) => path.replace(/^\/api\/arrivals/, '/tiempos-de-llegada/'),
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
          'Accept-Language': 'es-ES,es;q=0.9',
        },
      },
    },
  },
  build: {
    // El GTFS y la red oficial se sirven como assets estaticos, no como modulos.
    assetsInlineLimit: 4096,
    chunkSizeWarningLimit: 1200,
  },
})
