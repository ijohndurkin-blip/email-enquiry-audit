// Local preview: serves public/ and the /api/audit function, like Vercel does.
// Run: AUDIT_ACCESS_KEY=test npm run dev  → http://localhost:3000
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const api = { audit: require('./api/audit'), connect: require('./api/connect'), status: require('./api/status'), classify: require('./api/classify'), summary: require('./api/summary'), store: require('./api/store'), thread: require('./api/thread') };

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
const root = path.join(__dirname, 'public');

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const fn = url.pathname.startsWith('/api/') && api[url.pathname.slice(5)];
  if (fn) return fn(req, res);
  const file = path.join(root, path.normalize(url.pathname === '/' ? '/index.html' : url.pathname));
  if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.statusCode = 404; return res.end('Not found'); }
  res.setHeader('Content-Type', TYPES[path.extname(file)] || 'application/octet-stream');
  fs.createReadStream(file).pipe(res);
}).listen(process.env.PORT || 3000, () => console.log(`Enquiry audit on http://localhost:${process.env.PORT || 3000}`));
