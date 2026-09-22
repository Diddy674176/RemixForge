import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// GitHub Pages project site: https://diddy674176.github.io/RemixForge/
// The base must match the repository name exactly — Pages paths are case-sensitive.
export default defineConfig({
  base: '/RemixForge/',
  plugins: [react()],
  worker: { format: 'es' },
  build: { target: 'es2022' },
});
