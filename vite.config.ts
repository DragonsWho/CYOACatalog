import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react-swc';

export default defineConfig({
  
  optimizeDeps: {
    exclude: ["@jsquash/webp"]
  },
  plugins: [react()],
  define: {
    'global': 'window', 
  },
  
server: {
    proxy: {
      // /all is a server-rendered HTML catalog index (seo_index.go) served by Go, not React — in
      // dev it must be proxied to local `go run . serve` (:8090). Without this vite serves
      // index.html, the router finds no route and redirects home ("the page just redirects"). ⚠️
      // Answered by the LOCAL DB: stale pb_data → honest 503.
      '/all': {
        target: 'http://127.0.0.1:8090',
        changeOrigin: true,
      },
      '/api/similar-games': {
        target: 'http://127.0.0.1:8100',
        changeOrigin: true,
        secure: false,
      },
      
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
      // ⚠️ Everything else under /api goes to PRODUCTION: `make dev` reads and writes the live site.
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

  build: {
    commonjsOptions: {
      // TODO: remove after react-comments-section is gone (it randomly calls require('uuid'))
      transformMixedEsModules: true,
    },
  },
});