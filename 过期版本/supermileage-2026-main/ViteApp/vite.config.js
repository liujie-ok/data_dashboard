import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    proxy: {
      '/data':    'http://localhost:5000',
      '/latest':  'http://localhost:5000',
      '/api':     'http://localhost:5000',
    },
  },
});
