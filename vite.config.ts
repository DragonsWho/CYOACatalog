import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react-swc';

// https://vitejs.dev/config/
export default defineConfig({
  optimizeDeps: {
    exclude: ['@jsquash/webp', '@jsquash/avif'], // Исключаем из оптимизации зависимостей
  },
  plugins: [react()],
  build: {
    commonjsOptions: {
      transformMixedEsModules: true, // Сохраняем для совместимости
    },
    rollupOptions: {
      external: [
        '@jsquash/avif', // Исключаем весь модуль
        '@jsquash/avif/codec/enc/avif_enc_mt.js', // Дополнительно исключаем проблемный файл
      ],
      output: {
        manualChunks: undefined, // Отключаем ручное разделение чанков, если оно мешает
      },
    },
  },
});