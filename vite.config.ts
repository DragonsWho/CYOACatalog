import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react-swc';

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      output: {
        // Обеспечиваем правильную обработку WASM-файлов
        assetFileNames: (assetInfo) => {
          if (assetInfo.name && assetInfo.name.endsWith('.wasm')) {
            return 'assets/wasm/[name].[hash][extname]';
          }
          return 'assets/[name].[hash][extname]';
        },
      },
    },
  },
  // Используем optimizeDeps для включения модулей, зависящих от WASM
  optimizeDeps: {
    include: ['@jsquash/webp'],
    exclude: [], // Не исключаем эти модули
  },
  // Включаем поддержку WASM
  worker: {
    format: 'es',
  },
  // Правильно разрешаем импорты WASM
  resolve: {
    dedupe: ['@jsquash/webp', '@jsquash/avif'],
  },
  // Обеспечиваем правильную загрузку WASM
  assetsInclude: ['**/*.wasm'],
});