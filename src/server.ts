#!/usr/bin/env node
// Composition root del server HTTP: config -> caller SOAP en vivo -> router.
// Entrypoint unico del producto ("npm start"). NO escribe nada a disco: un
// archivo por request seria inmanejable en produccion.

import { createServer } from 'node:http';
import { loadConfig, ConfigError } from './config.js';
import { closeTransport } from './soap/transport.js';
import { makeLiveOperationCaller } from './http/callOperationLive.js';
import { createRequestListener } from './http/router.js';

function main(): void {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(`CONFIG ERROR: ${err.message}`);
      process.exitCode = err.exitCode;
      return;
    }
    throw err;
  }

  const call = makeLiveOperationCaller(config);
  const listener = createRequestListener({ call, deadlineMs: config.serverDeadlineMs });
  const server = createServer((req, res) => {
    void listener(req, res);
  });

  server.listen(config.port, () => {
    console.log(`dpec-webServices listening on port ${config.port} (env=${config.env})`);
  });

  // Apaga en dos pasos, igual criterio que closeTransport() en index.ts:
  // dejar de aceptar conexiones, esperar/cerrar las abiertas, y RECIÉN
  // después liberar los sockets undici -- nunca process.exit() con sockets
  // vivos, que aborta en Windows (ver soap/transport.ts).
  let shuttingDown = false;
  function shutdown(signal: NodeJS.Signals): void {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`Received ${signal}, shutting down gracefully...`);
    server.closeAllConnections();
    server.close(() => {
      closeTransport()
        .catch(() => {})
        .finally(() => {
          process.exitCode = 0;
        });
    });
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main();
