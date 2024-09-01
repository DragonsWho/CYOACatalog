// vite.config.js
import { defineConfig } from 'file:///D:/Coding/dragonWhore/CYOACatalog/node_modules/vite/dist/node/index.js'
import react from 'file:///D:/Coding/dragonWhore/CYOACatalog/node_modules/@vitejs/plugin-react/dist/index.mjs'
import { nodePolyfills } from 'file:///D:/Coding/dragonWhore/CYOACatalog/node_modules/vite-plugin-node-polyfills/dist/index.js'
import commonjs from 'file:///D:/Coding/dragonWhore/CYOACatalog/node_modules/vite-plugin-commonjs/dist/index.mjs'
var vite_config_default = defineConfig(({ command, mode }) => {
  const config = {
    plugins: [
      react(),
      nodePolyfills({
        globals: {
          global: true
        }
      }),
      commonjs()
    ],
    server: {
      port: 3e3,
      host: '0.0.0.0'
    },
    preview: {
      port: 3e3,
      host: '0.0.0.0'
    },
    build: {
      commonjsOptions: {
        transformMixedEsModules: true
      },
      rollupOptions: {
        external: ['require']
      },
      minify: mode === 'production',
      sourcemap: true
    },
    optimizeDeps: {
      include: ['react', 'react-dom']
    }
  }
  if (mode === 'development') {
    config.build.rollupOptions = {
      ...config.build.rollupOptions,
      output: {
        manualChunks: void 0,
        entryFileNames: '[name].js',
        chunkFileNames: '[name].js',
        assetFileNames: '[name].[ext]'
      }
    }
  }
  return config
})
export {
  vite_config_default as default
}
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsidml0ZS5jb25maWcuanMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbImNvbnN0IF9fdml0ZV9pbmplY3RlZF9vcmlnaW5hbF9kaXJuYW1lID0gXCJEOlxcXFxDb2RpbmdcXFxcZHJhZ29uV2hvcmVcXFxcQ1lPQUNhdGFsb2dcIjtjb25zdCBfX3ZpdGVfaW5qZWN0ZWRfb3JpZ2luYWxfZmlsZW5hbWUgPSBcIkQ6XFxcXENvZGluZ1xcXFxkcmFnb25XaG9yZVxcXFxDWU9BQ2F0YWxvZ1xcXFx2aXRlLmNvbmZpZy5qc1wiO2NvbnN0IF9fdml0ZV9pbmplY3RlZF9vcmlnaW5hbF9pbXBvcnRfbWV0YV91cmwgPSBcImZpbGU6Ly8vRDovQ29kaW5nL2RyYWdvbldob3JlL0NZT0FDYXRhbG9nL3ZpdGUuY29uZmlnLmpzXCI7aW1wb3J0IHsgZGVmaW5lQ29uZmlnIH0gZnJvbSAndml0ZSdcclxuaW1wb3J0IHJlYWN0IGZyb20gJ0B2aXRlanMvcGx1Z2luLXJlYWN0J1xyXG5pbXBvcnQgeyBub2RlUG9seWZpbGxzIH0gZnJvbSAndml0ZS1wbHVnaW4tbm9kZS1wb2x5ZmlsbHMnXHJcbmltcG9ydCBjb21tb25qcyBmcm9tICd2aXRlLXBsdWdpbi1jb21tb25qcydcclxuXHJcbmV4cG9ydCBkZWZhdWx0IGRlZmluZUNvbmZpZygoeyBjb21tYW5kLCBtb2RlIH0pID0+IHtcclxuICBjb25zdCBjb25maWcgPSB7XHJcbiAgICBwbHVnaW5zOiBbXHJcbiAgICAgIHJlYWN0KCksXHJcbiAgICAgIG5vZGVQb2x5ZmlsbHMoe1xyXG4gICAgICAgIGdsb2JhbHM6IHtcclxuICAgICAgICAgIGdsb2JhbDogdHJ1ZSxcclxuICAgICAgICB9LFxyXG4gICAgICB9KSxcclxuICAgICAgY29tbW9uanMoKSxcclxuICAgIF0sXHJcbiAgICBzZXJ2ZXI6IHtcclxuICAgICAgcG9ydDogMzAwMCxcclxuICAgICAgaG9zdDogJzAuMC4wLjAnXHJcbiAgICB9LFxyXG4gICAgcHJldmlldzoge1xyXG4gICAgICBwb3J0OiAzMDAwLFxyXG4gICAgICBob3N0OiAnMC4wLjAuMCdcclxuICAgIH0sXHJcbiAgICBidWlsZDoge1xyXG4gICAgICBjb21tb25qc09wdGlvbnM6IHtcclxuICAgICAgICB0cmFuc2Zvcm1NaXhlZEVzTW9kdWxlczogdHJ1ZSxcclxuICAgICAgfSxcclxuICAgICAgcm9sbHVwT3B0aW9uczoge1xyXG4gICAgICAgIGV4dGVybmFsOiBbJ3JlcXVpcmUnXVxyXG4gICAgICB9LFxyXG4gICAgICBtaW5pZnk6IG1vZGUgPT09ICdwcm9kdWN0aW9uJyxcclxuICAgICAgc291cmNlbWFwOiB0cnVlLFxyXG4gICAgfSxcclxuICAgIG9wdGltaXplRGVwczoge1xyXG4gICAgICBpbmNsdWRlOiBbJ3JlYWN0JywgJ3JlYWN0LWRvbSddLFxyXG4gICAgfSxcclxuICB9XHJcblxyXG4gIGlmIChtb2RlID09PSAnZGV2ZWxvcG1lbnQnKSB7XHJcbiAgICBjb25maWcuYnVpbGQucm9sbHVwT3B0aW9ucyA9IHtcclxuICAgICAgLi4uY29uZmlnLmJ1aWxkLnJvbGx1cE9wdGlvbnMsXHJcbiAgICAgIG91dHB1dDoge1xyXG4gICAgICAgIG1hbnVhbENodW5rczogdW5kZWZpbmVkLFxyXG4gICAgICAgIGVudHJ5RmlsZU5hbWVzOiAnW25hbWVdLmpzJyxcclxuICAgICAgICBjaHVua0ZpbGVOYW1lczogJ1tuYW1lXS5qcycsXHJcbiAgICAgICAgYXNzZXRGaWxlTmFtZXM6ICdbbmFtZV0uW2V4dF0nXHJcbiAgICAgIH0sXHJcbiAgICB9XHJcbiAgfVxyXG5cclxuICByZXR1cm4gY29uZmlnXHJcbn0pXHJcbiJdLAogICJtYXBwaW5ncyI6ICI7QUFBNlIsU0FBUyxvQkFBb0I7QUFDMVQsT0FBTyxXQUFXO0FBQ2xCLFNBQVMscUJBQXFCO0FBQzlCLE9BQU8sY0FBYztBQUVyQixJQUFPLHNCQUFRLGFBQWEsQ0FBQyxFQUFFLFNBQVMsS0FBSyxNQUFNO0FBQ2pELFFBQU0sU0FBUztBQUFBLElBQ2IsU0FBUztBQUFBLE1BQ1AsTUFBTTtBQUFBLE1BQ04sY0FBYztBQUFBLFFBQ1osU0FBUztBQUFBLFVBQ1AsUUFBUTtBQUFBLFFBQ1Y7QUFBQSxNQUNGLENBQUM7QUFBQSxNQUNELFNBQVM7QUFBQSxJQUNYO0FBQUEsSUFDQSxRQUFRO0FBQUEsTUFDTixNQUFNO0FBQUEsTUFDTixNQUFNO0FBQUEsSUFDUjtBQUFBLElBQ0EsU0FBUztBQUFBLE1BQ1AsTUFBTTtBQUFBLE1BQ04sTUFBTTtBQUFBLElBQ1I7QUFBQSxJQUNBLE9BQU87QUFBQSxNQUNMLGlCQUFpQjtBQUFBLFFBQ2YseUJBQXlCO0FBQUEsTUFDM0I7QUFBQSxNQUNBLGVBQWU7QUFBQSxRQUNiLFVBQVUsQ0FBQyxTQUFTO0FBQUEsTUFDdEI7QUFBQSxNQUNBLFFBQVEsU0FBUztBQUFBLE1BQ2pCLFdBQVc7QUFBQSxJQUNiO0FBQUEsSUFDQSxjQUFjO0FBQUEsTUFDWixTQUFTLENBQUMsU0FBUyxXQUFXO0FBQUEsSUFDaEM7QUFBQSxFQUNGO0FBRUEsTUFBSSxTQUFTLGVBQWU7QUFDMUIsV0FBTyxNQUFNLGdCQUFnQjtBQUFBLE1BQzNCLEdBQUcsT0FBTyxNQUFNO0FBQUEsTUFDaEIsUUFBUTtBQUFBLFFBQ04sY0FBYztBQUFBLFFBQ2QsZ0JBQWdCO0FBQUEsUUFDaEIsZ0JBQWdCO0FBQUEsUUFDaEIsZ0JBQWdCO0FBQUEsTUFDbEI7QUFBQSxJQUNGO0FBQUEsRUFDRjtBQUVBLFNBQU87QUFDVCxDQUFDOyIsCiAgIm5hbWVzIjogW10KfQo=
