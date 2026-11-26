#!/usr/bin/env node
// Serve the package to a browser for the browser check (scripts/browser-check.html):
//   node scripts/browser-serve.mjs [--port 5188]
// Serves this package's folder read-only, and /spec/ from the specification's assets folder.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findSpecDir } from '../src/node/spec.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const spec = findSpecDir();
const port = Number(process.argv[process.argv.indexOf('--port') + 1]) || 5188;
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.wasm': 'application/wasm' };

createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    let path = decodeURIComponent(url.pathname);
    if (path === '/') path = '/scripts/browser-check.html';
    const [base, rel] = path.startsWith('/spec/') && spec ? [spec, path.slice(6)] : [root, path.slice(1)];
    const full = resolve(base, normalize(rel));
    if (!full.startsWith(base + sep)) throw new Error('outside');
    const body = await readFile(full);
    res.writeHead(200, { 'content-type': TYPES[extname(full)] || 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end('not found');
  }
}).listen(port, '127.0.0.1', () => console.log(`browser check: http://127.0.0.1:${port}/`));
