import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Dev server for the panel. /api is proxied to the Fastify API, so the browser sees one origin
// (the API allows http://127.0.0.1:5173 as Origin for state-changing requests).
export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: { '/api': { target: 'http://127.0.0.1:3000' } },
  },
  build: { outDir: 'dist', emptyOutDir: true, sourcemap: false },
});
