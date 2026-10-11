import { defineConfig } from 'vite';

// Bind to 0.0.0.0 so the live preview can reach the dev server.
// allowedHosts: true lets the preview host (for example *.e2b.app) through Vite's host check.
export default defineConfig({
  server: {
    host: '0.0.0.0',
    port: 5173,
    allowedHosts: true,
  },
  preview: {
    host: '0.0.0.0',
    port: 4173,
    allowedHosts: true,
  },
  optimizeDeps: {
    exclude: ['@huggingface/transformers'],
  },
});
