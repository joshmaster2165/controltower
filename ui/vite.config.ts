import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/admin/api': 'http://localhost:4000',
      '/admin/ws': { target: 'ws://localhost:4000', ws: true },
      '/v1': 'http://localhost:4000',
      '/mcp': 'http://localhost:4000',
      '/healthz': 'http://localhost:4000',
      '/readyz': 'http://localhost:4000',
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    chunkSizeWarningLimit: 1500,
  },
});
