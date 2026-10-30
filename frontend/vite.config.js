import { defineConfig } from 'vite';

// The /api calls go to the .NET backend. BACKEND_URL overrides its address.
export default defineConfig({
  server: {
    port: 3000,
    proxy: {
      '/api': {
        target: process.env.BACKEND_URL || 'http://localhost:5100',
        changeOrigin: true,
      },
    },
  },
});
