import { defineConfig } from 'vite';
import { viteIndesignPlugin } from './plugins/viteIndesign.mjs';

export default defineConfig({
  build: { target: 'esnext' },
  optimizeDeps: { esbuildOptions: { target: 'esnext' } },
  plugins: [viteIndesignPlugin()],
});

