import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': 'http://localhost:9301',
      '/ws': { target: 'ws://localhost:9301', ws: true }
    }
  },
  build: { outDir: 'dist', chunkSizeWarningLimit: 1200 }
});
