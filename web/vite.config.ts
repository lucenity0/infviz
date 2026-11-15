import { existsSync, readdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig, type Plugin } from 'vite';

// The Envato-licensed font in public/fonts/licensed/ is for local use only. Vite copies
// public/ into dist/, so strip it after every build: a deployed dist/ must never carry it.
function stripLicensedFonts(): Plugin {
  let outDir = 'dist';
  return {
    name: 'infviz-strip-licensed-fonts',
    apply: 'build',
    configResolved(c) {
      outDir = resolve(c.root, c.build.outDir);
    },
    closeBundle() {
      const dir = resolve(outDir, 'fonts/licensed');
      if (existsSync(dir)) {
        rmSync(dir, { recursive: true, force: true });
        this.info?.('removed fonts/licensed/ from the build (not redistributable)');
      }
      const fonts = resolve(outDir, 'fonts');
      if (existsSync(fonts) && readdirSync(fonts).length === 0) rmSync(fonts, { recursive: true });
    },
  };
}

export default defineConfig({
  base: './',
  plugins: [stripLicensedFonts()],
  server: {
    port: 5173,
    proxy: {
      '/ws': { target: 'ws://localhost:8000', ws: true, changeOrigin: true },
      '/api': { target: 'http://localhost:8000', changeOrigin: true },
    },
  },
  build: { target: 'es2022', sourcemap: false },
  test: { environment: 'node', include: ['src/**/*.test.ts'] },
} as any);
