import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [vue(), tailwindcss()],
  // Load env from the repo root so the single root .env is the source of truth.
  // Only VITE_-prefixed vars are exposed to client code, so no secrets leak.
  envDir: fileURLToPath(new URL('../../', import.meta.url)),
  server: {
    port: 5173,
  },
});
