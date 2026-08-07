'use strict';

// Local development server. Serves the static files in public/ and hands every
// /api/* request to the same handler Vercel uses, so both environments run
// identical code.

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { handleApi } = require('./lib/app');
const db = require('./lib/db');

const PORT = Number(process.env.PORT) || 4000;
const PUBLIC_DIR = path.join(__dirname, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.json': 'application/json; charset=utf-8',
};

function send(res, status, body, headers = {}) {
  const data = Buffer.isBuffer(body) ? body : Buffer.from(body);
  res.writeHead(status, { 'Content-Length': data.length, ...headers });
  res.end(data);
}

function serveStatic(res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const filePath = path.join(PUBLIC_DIR, rel);
  const indexPath = path.join(PUBLIC_DIR, 'index.html');

  if (!filePath.startsWith(PUBLIC_DIR + path.sep) && filePath !== indexPath) {
    return send(res, 403, 'Forbidden');
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      fs.readFile(indexPath, (e2, html) => {
        if (e2) return send(res, 404, 'Not found');
        send(res, 200, html, { 'Content-Type': MIME['.html'] });
      });
      return;
    }
    send(res, 200, data, {
      'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (url.pathname.startsWith('/api/')) return handleApi(req, res, url);
  serveStatic(res, decodeURIComponent(url.pathname));
});

db.ensureReady()
  .then(() => {
    server.listen(PORT, () => {
      const ips = [];
      for (const list of Object.values(os.networkInterfaces())) {
        for (const n of list || []) {
          if (n.family === 'IPv4' && !n.internal) ips.push(n.address);
        }
      }
      console.log('\n  A.N Traders — Inventory Management');
      console.log('  ----------------------------------');
      console.log(`  Database:          ${db.isLocalFile ? 'local file' : 'Turso (cloud)'}`);
      console.log(`  On this computer:  http://localhost:${PORT}`);
      for (const ip of ips) console.log(`  On your network:   http://${ip}:${PORT}`);
      console.log('\n  Press Ctrl+C to stop.\n');
    });
  })
  .catch((err) => {
    console.error('\n  Could not start: ' + err.message + '\n');
    process.exit(1);
  });
