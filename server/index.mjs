import express from 'express';
import path from 'node:path';
import { app } from './app.mjs';
const production = process.argv.includes('--production') || process.env.NODE_ENV === 'production';
if (production) {
  app.use(express.static(path.resolve('dist')));
  app.get('/{*path}', (_req, res) => res.sendFile(path.resolve('dist/index.html')));
} else {
  const { createServer } = await import('vite');
  const vite = await createServer({ server: { middlewareMode: true, hmr: false, fs: { deny: ['.env', '.env.*', '**/data/**', '**/.demo-access.txt', '**/server/**', '**/scripts/**', '**/tests/**'] } }, appType: 'spa' });
  app.use(vite.middlewares);
}
const port = Number(process.env.PORT || 4173);
const server = app.listen(port, process.env.HOST || '127.0.0.1', () => console.log(`Club PELSA: ${process.env.APP_URL || `http://localhost:${port}`}`));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => process.exit(0)));
