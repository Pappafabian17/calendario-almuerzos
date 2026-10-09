// Servidor local de desarrollo. En producción (Netlify) se usan public/ + netlify/functions/api.mjs.
import './lib/env.js'; // primero: carga .env antes de que otros módulos lean process.env
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { safeHandle } from './lib/handler.js';

const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
const PORT = process.env.PORT || 3000;
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname.startsWith('/api/')) {
    const body = ['GET', 'HEAD'].includes(req.method) ? undefined : await new Promise((ok) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => ok(Buffer.concat(chunks)));
    });
    const r = await safeHandle(new Request(url, { method: req.method, headers: req.headers, body }));
    res.writeHead(r.status, { 'Content-Type': r.headers.get('content-type') });
    return res.end(Buffer.from(await r.arrayBuffer()));
  }
  const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).replace(/^\/+/, '');
  const file = path.join(PUBLIC, rel);
  if (!file.startsWith(PUBLIC + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404);
    return res.end('No encontrado');
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
}).listen(PORT, () => {
  console.log(`Calendario de almuerzos en http://localhost:${PORT}`);
  if (!process.env.ADMIN_PASSWORD) console.log('Contraseña de administrador por defecto: "misioneros" (cámbiala con ADMIN_PASSWORD)');
});
