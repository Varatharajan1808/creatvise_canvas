import http from 'node:http';
import { createConversionMiddleware } from './conversionApi.mjs';

const PORT = Number(process.env.PORT || 3000);
const middleware = createConversionMiddleware({ log: (m) => console.log(m) });

middleware.startWarmUp();

const server = http.createServer((req, res) => {
  middleware(req, res, () => {
    res.statusCode = 404;
    res.end('Not Found');
  });
});

server.listen(PORT, () => {
  console.log(`[creatvise-server] Conversion API running on http://localhost:${PORT}`);
});

process.on('SIGINT', () => {
  middleware.shutdown();
  server.close(() => process.exit(0));
});

process.on('SIGTERM', () => {
  middleware.shutdown();
  server.close(() => process.exit(0));
});
