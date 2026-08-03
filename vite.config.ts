import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react-swc';

// https://vitejs.dev/config/
export default defineConfig({
  
  optimizeDeps: {
    exclude: ["@jsquash/webp"]
  },
  plugins: [react()],
  define: {
    'global': 'window', 
  },
  
  // --- ДОБАВЛЕННЫЙ БЛОК ДЛЯ ЛОКАЛЬНОЙ РАЗРАБОТКИ ---
server: {
    proxy: {
      // --- ВОТ ТУТ ДОБАВЬ НОВЫЙ ПУТЬ ---
      '/api/similar-games': {
        target: 'http://127.0.0.1:8100',
        changeOrigin: true,
        secure: false,
      },
      // ---------------------------------
      
      '/api/semantic-search': {
        target: 'http://127.0.0.1:8100',
        changeOrigin: true,
        secure: false,
      },
      '/stats': {
        target: 'http://127.0.0.1:8100',
        changeOrigin: true,
      },
      '/games': {
        target: 'http://127.0.0.1:8100',
        changeOrigin: true,
      },
      '/api': {
        target: 'https://cyoa.cafe',
        changeOrigin: true,
        secure: true,
        configure: (proxy, ) => {
          proxy.on('proxyReq', (proxyReq,) => {
            proxyReq.setHeader('Origin', 'https://cyoa.cafe');
          });
        },
      }
    }
  },
  // -------------------------------------------------

  build: {
    commonjsOptions: {
      // TODO: remove this after react-comments-section is removed (it is randomly calling require('uuid'))
      transformMixedEsModules: true,
    },
  },
});