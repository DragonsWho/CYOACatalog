import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react-swc';
// esbuild ships with vite; used directly only to bundle the tiny pre-paint script.
import { build as esbuild } from 'esbuild';

// Bundles src/prepaint/prepaint.ts into one classic inline <script> at <!--prepaint--> in index.html,
// so the UI mock paints before the main bundle is even fetched. Rebuilt on every HTML transform
// (dev picks up edits on reload).
function prepaint(): Plugin {
  return {
    name: 'prepaint',
    async transformIndexHtml(html) {
      const out = await esbuild({
        entryPoints: ['src/prepaint/prepaint.ts'],
        bundle: true,
        write: false,
        format: 'iife',
        minify: true,
        target: 'es2019',
        legalComments: 'none',
      });
      const code = out.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
      return html.replace('<!--prepaint-->', `<script>${code}</script>`);
    },
  };
}

export default defineConfig({
  
  optimizeDeps: {
    exclude: ["@jsquash/webp"]
  },
  plugins: [react(), prepaint()],
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