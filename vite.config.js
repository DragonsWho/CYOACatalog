import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { nodePolyfills } from 'vite-plugin-node-polyfills'
import commonjs from 'vite-plugin-commonjs'

export default defineConfig({
    plugins: [
        react(),
        nodePolyfills({
            globals: {
                global: true,
            },
        }),
        commonjs(),
    ],
    server: {
        port: 3000,
        host: '0.0.0.0'
    },
    preview: {
        port: 3000,
        host: '0.0.0.0'
    },
    build: {
        commonjsOptions: {
            transformMixedEsModules: true,
        },
        rollupOptions: {
            external: ['require']
        }
    },
    optimizeDeps: {
        include: ['react', 'react-dom'],
    },
})
