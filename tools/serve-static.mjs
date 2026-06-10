#!/usr/bin/env node
// Minimal static file server for E2E tests. No watching, no reload, no browser open.
// Usage: node tools/serve-static.mjs [port]

import { createServer } from 'node:http';
import { createReadStream, statSync } from 'node:fs';
import { resolve, dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const port = Number(process.argv[2] || process.env.PORT || 8888);

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js':   'application/javascript; charset=utf-8',
    '.mjs':  'application/javascript; charset=utf-8',
    '.css':  'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg':  'image/svg+xml',
    '.png':  'image/png',
    '.jpg':  'image/jpeg',
    '.ico':  'image/x-icon',
    '.woff': 'font/woff',
    '.woff2':'font/woff2',
    '.ttf':  'font/ttf',
    '.mp3':  'audio/mpeg',
    '.m4a':  'audio/mp4',
    '.webm': 'video/webm',
    '.webmanifest':'application/manifest+json',
};

const server = createServer((req, res) => {
    try {
        let urlPath = decodeURIComponent(req.url.split('?')[0]);
        if (urlPath === '/') urlPath = '/index.html';
        const filePath = join(root, urlPath);
        if (!filePath.startsWith(root)) {
            res.writeHead(403); res.end('forbidden'); return;
        }
        const st = statSync(filePath);
        if (st.isDirectory()) {
            res.writeHead(302, { Location: urlPath.replace(/\/?$/, '/') + 'index.html' });
            res.end();
            return;
        }
        const ext = extname(filePath).toLowerCase();
        res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
        createReadStream(filePath).pipe(res);
    } catch {
        res.writeHead(404); res.end('not found');
    }
});

server.listen(port, () => {
    console.log(`Static server: http://localhost:${port}`);
});
