const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { buildConditions } = require('./lib/conditions');

const PORT = process.env.PORT || 4328;
const HOST = process.env.PORT ? '0.0.0.0' : '127.0.0.1';
const PUB = path.join(__dirname, 'public');
const MIME = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript',
               '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' };

let problemsCache = null;

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname === '/api/conditions') {
      const payload = await buildConditions({});
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(payload));
    }
    if (url.pathname === '/api/problems') {
      problemsCache ??= fs.readFileSync(path.join(__dirname, 'data', 'problems.json'));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(problemsCache);
    }
    let file = path.normalize(path.join(PUB, url.pathname === '/' ? 'index.html' : url.pathname));
    if (!file.startsWith(PUB) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404); return res.end('not found');
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream' });
    return res.end(fs.readFileSync(file));
  } catch (err) {
    console.error(err);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: String(err.message ?? err) }));
  }
});

server.listen(PORT, HOST, () => console.log(`DRYSPELL on http://${HOST}:${PORT}`));
