import { createIndesignService } from './indesignService.mjs';

const MAX_BODY_SIZE = 500 * 1024 * 1024; // 500 MB

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let totalSize = 0;
    req.on('data', (chunk) => {
      totalSize += chunk.length;
      if (totalSize > MAX_BODY_SIZE) {
        req.destroy();
        reject(new Error(`Request body exceeds maximum size of ${MAX_BODY_SIZE} bytes.`));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export function createConversionMiddleware(options = {}) {
  const log = options.log || (() => {});
  const service = createIndesignService({ log });

  let queue = Promise.resolve();
  let queueLength = 0;
  let lastJob = null;

  function enqueue(task) {
    queueLength++;
    const run = () =>
      Promise.resolve()
        .then(task)
        .then(
          (result) => {
            lastJob = { ok: true, timestamp: Date.now() };
            return result;
          },
          (err) => {
            lastJob = { ok: false, error: err.message, timestamp: Date.now() };
            throw err;
          },
        )
        .finally(() => {
          queueLength--;
        });

    const next = queue.then(run, run);
    queue = next.catch(() => {});
    return next;
  }

  const middleware = async (req, res, next) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

      if (req.method === 'GET' && url.pathname === '/api/health') {
        const health = service.getHealth({ queueLength, lastJob });
        res.setHeader('Content-Type', 'application/json');
        res.statusCode = 200;
        res.end(JSON.stringify(health));
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/indd-to-idml') {
        const body = await readBody(req);
        if (body.length === 0) {
          res.statusCode = 400;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: 'Request body is empty. Provide an .indd file.' }));
          return;
        }
        const { bytes } = await enqueue(async () => {
          const resBytes = await service.convert('indd-to-idml', body);
          return { bytes: resBytes };
        });
        res.setHeader('Content-Type', 'application/octet-stream');
        res.statusCode = 200;
        res.end(bytes);
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/idml-to-indd') {
        const body = await readBody(req);
        if (body.length === 0) {
          res.statusCode = 400;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: 'Request body is empty. Provide an .idml file.' }));
          return;
        }
        const { bytes } = await enqueue(async () => {
          const resBytes = await service.convert('idml-to-indd', body);
          return { bytes: resBytes };
        });
        res.setHeader('Content-Type', 'application/octet-stream');
        res.statusCode = 200;
        res.end(bytes);
        return;
      }

      if (typeof next === 'function') {
        next();
      } else {
        res.statusCode = 404;
        res.end('Not Found');
      }
    } catch (err) {
      log(`[conversionApi] Error: ${err.message}`);
      res.statusCode = 500;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: err.message }));
    }
  };

  middleware.startWarmUp = () => service.startWarmUp();
  middleware.shutdown = () => service.shutdown();

  return middleware;
}
