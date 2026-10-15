import { createIndesignService } from './indesignService.mjs';

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
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

      // ADD — core routes inside createConversionMiddleware
      if (req.method === 'GET' && url.pathname === '/api/health') {
        /* JSON health via service.getHealth({ queueLength, lastJob }) */
        const health = service.getHealth({ queueLength, lastJob });
        res.setHeader('Content-Type', 'application/json');
        res.statusCode = 200;
        res.end(JSON.stringify(health));
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/indd-to-idml') {
        const body = await readBody(req);
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
