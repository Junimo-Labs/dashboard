import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import fs from 'fs';
import path from 'path';

// Vite plugin to serve the unpacked directory locally without copying it to public/
function serveUnpacked() {
  return {
    name: 'serve-unpacked',
    configureServer(server) {
      server.middlewares.use('/assets', (req, res, next) => {
        if (!req.url) return next();

        // req.url contains the filename, e.g. "/Fish%20Pond.png"
        const decodedUrl = decodeURIComponent(req.url.split('?')[0]);
        const filePath = path.join(__dirname, 'unpacked', decodedUrl);

        if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
          const ext = path.extname(filePath).toLowerCase();
          if (ext === '.png') {
            res.setHeader('Content-Type', 'image/png');
          }
          const stream = fs.createReadStream(filePath);
          stream.pipe(res);
        } else {
          next();
        }
      });
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
