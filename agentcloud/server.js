/**
 * Custom server (bukan `next start`) supaya platform hosting bisa menjalankan
 * `node server.js` dengan PORT dari environment.
 * NODE_ENV=production di-set otomatis oleh platform saat aplikasi dipublish,
 * sehingga server ini otomatis memakai build produksi (.next).
 */
const { createServer } = require('node:http');
const { parse } = require('node:url');
const next = require('next');

const dev = process.env.NODE_ENV !== 'production';
const port = Number.parseInt(process.env.PORT || '3000', 10);
const hostname = process.env.HOSTNAME || '0.0.0.0';

const app = next({ dev, dir: __dirname });
const handle = app.getRequestHandler();

app
  .prepare()
  .then(() => {
    const server = createServer((req, res) => {
      const parsedUrl = parse(req.url, true);
      Promise.resolve(handle(req, res, parsedUrl)).catch((err) => {
        console.error('[agentcloud] request error:', err);
        if (!res.headersSent) {
          res.statusCode = 500;
          res.setHeader('content-type', 'text/plain; charset=utf-8');
        }
        res.end('Internal Server Error');
      });
    });

    // Timeout longgar khusus untuk route chat (streaming agent bisa lama).
    server.requestTimeout = 0;
    server.headersTimeout = 65_000;
    server.keepAliveTimeout = 65_000;

    server.listen(port, hostname, () => {
      console.log(`[agentcloud] ready on http://${hostname}:${port} (dev=${dev})`);
    });
  })
  .catch((err) => {
    console.error('[agentcloud] gagal start:', err);
    process.exit(1);
  });
