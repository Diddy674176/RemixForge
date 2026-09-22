import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// GitHub Pages project site: https://diddy674176.github.io/remixforge/
export default defineConfig({
  base: '/remixforge/',
  plugins: [react()],
  worker: { format: 'es' },
  build: { target: 'es2022' },
});
