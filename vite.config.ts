import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import express from 'express';
import sirv from 'serve-static';
import path from 'path';

// Vite plugin to serve the unpacked directory locally without copying it to public/
function serveUnpacked() {
  return {
    name: 'serve-unpacked',
    configureServer(server) {
      server.middlewares.use('/assets', sirv(path.resolve(__dirname, 'unpacked')));
    }
  };
}

export default defineConfig({
  plugins: [react(), serveUnpacked()],
  build: {
    outDir: 'dist/client',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    host: '0.0.0.0',
  },
});
