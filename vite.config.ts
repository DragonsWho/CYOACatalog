import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react-swc';

// https://vitejs.dev/config/
export default defineConfig({
  
  optimizeDeps: {
    exclude: ["@jsquash/webp"]
  },
  plugins: [react()],
    define: {
    'global': 'window', // <-- Добавьте эту строку
  },
  build: {
    commonjsOptions: {
      // TODO: remove this after react-comments-section is removed (it is randomly calling require('uuid'))
      transformMixedEsModules: true,
    },
  },
});

  