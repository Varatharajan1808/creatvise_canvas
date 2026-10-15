import { createConversionMiddleware } from '../server/conversionApi.mjs';

export function viteIndesignPlugin() {
  let middleware = null;
  return {
    name: 'vite-indesign-api',
    configureServer(server) {
      middleware = createConversionMiddleware({ log: (m) => console.log(m) });
      server.middlewares.use(middleware);
      middleware.startWarmUp();
      return () => middleware?.shutdown();
    },
  };
}
