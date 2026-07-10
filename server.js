const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { buildConditions } = require('./lib/conditions');
const { acceptPushedCache } = require('./lib/weather');

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
    if (url.pathname === '/api/push-cache' && req.method === 'POST') {
      const key = process.env.DRYSPELL_PUSH_KEY;
      if (!key || req.headers.authorization !== `Bearer ${key}`) {
        res.writeHead(401); return res.end('unauthorized');
      }
      let body = '', size = 0;
      req.on('data', c => {
        size += c.length;
        if (size > 6e6) { res.writeHead(413); res.end(); req.destroy(); }
        else body += c;
      });
      req.on('end', () => {
        try {
          const ok = acceptPushedCache(JSON.parse(body));
          console.log(ok ? 'push-cache: accepted fresh weather' : 'push-cache: rejected payload');
          res.writeHead(ok ? 204 : 422);
          res.end();
        } catch {
          res.writeHead(400); res.end();
        }
      });
      return;
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

// warm the weather cache at boot; keep trying if the API is rate-limiting us
(async function warm() {
  try {
    await buildConditions({});
    console.log('weather cache warmed');
  } catch (err) {
    console.error(`warm fetch failed (${err.message}), retrying in 60s`);
    setTimeout(warm, 60e3);
  }
})();
