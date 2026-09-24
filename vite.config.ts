import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react-swc';
// esbuild ships with vite; used directly only to bundle the tiny pre-paint script.
import { build as esbuild } from 'esbuild';

// Bundles src/prepaint/prepaint.ts into one classic inline <script> at <!--prepaint--> in index.html,
// so the UI mock paints before the main bundle is even fetched. Rebuilt on every HTML transform
// (dev picks up edits on reload).
let snap: { at: number; html: string } | null = null;
async function prodSnapshot(): Promise<string> {
  if (snap && Date.now() - snap.at < 60_000) return snap.html;
  try {
    // Browser UA: Cloudflare blocks bare fetch clients.
    const r = await fetch('https://cyoa.cafe/', { headers: { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) Chrome/140 Safari/537.36' } });
    const doc = await r.text();
    const scripts = doc.match(/<script>window\.__[A-Z_]+__[\s\S]*?<\/script>/g) ?? [];
    snap = { at: Date.now(), html: scripts.join('') };
  } catch (e) {
    console.warn('prepaint: prod snapshot unavailable', e);
    snap = { at: Date.now(), html: '' };
  }
  return snap.html;
}

function prepaint(): Plugin {
  return {
    name: 'prepaint',
    async transformIndexHtml(html, ctx) {
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
      html = html.replace('<!--prepaint-->', `<script>${code}</script>`);
      // Dev has no Go HTML injection (main.go proxies to vite as is): borrow the catalog snapshot /
      // tag-dictionary scripts from production's home HTML so the pre-paint shows real cards here too.
      if (ctx.server) html = html.replace('</head>', `${await prodSnapshot()}</head>`);
      return html;
    },
  };
}

// The entry stylesheet (~10 KB, ~3 KB gzip: Tailwind preflight + global rules) inlined as <style>:
// a <link rel=stylesheet> is render-blocking — the pre-paint waited a full round trip for it
// (Lighthouse "Render-blocking requests"). The .css file stays in dist; nothing links it.
function inlineEntryCss(): Plugin {
  return {
    name: 'inline-entry-css',
    apply: 'build',
    transformIndexHtml: {
      order: 'post',
      handler(html, ctx) {
        return html.replace(/<link rel="stylesheet"[^>]*href="\/(assets\/[^"]+\.css)"[^>]*>/g, (tag, file: string) => {
          const asset = ctx.bundle?.[file];
          if (!asset || asset.type !== 'asset') return tag;
          const css = String(asset.source).replace(/<\/style/gi, '<\\/style');
          return `<style>${css}</style>`;
        });
      },
    },
  };
}

export default defineConfig({
  
  optimizeDeps: {
    exclude: ["@jsquash/webp"]
  },
  plugins: [react(), prepaint(), inlineEntryCss()],
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
    // Read by Go (route_preload.go) to modulepreload a route's lazy chunk with the HTML. Not under
    // .vite/: //go:embed dist skips dot-directories.
    manifest: 'route-manifest.json',
    commonjsOptions: {
      // TODO: remove after react-comments-section is gone (it randomly calls require('uuid'))
      transformMixedEsModules: true,
    },
  },
});