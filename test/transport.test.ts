// closeTransport() es crítico para el shutdown gradual del server HTTP
// (src/server.ts): sin liberar los sockets de undici, process.exit() en
// win32 aborta con "Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)".
// Antes cubría el mismo contrato para el probe CLI; ahora es el server quien
// depende de esto en SIGTERM/SIGINT.

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { callSoap, closeTransport } from '../src/soap/transport.js';

const FAULT_BODY =
  '<soap-env:Envelope xmlns:soap-env="http://schemas.xmlsoap.org/soap/envelope/">' +
  '<soap-env:Body><soap-env:Fault><faultcode>soap-env:Server</faultcode>' +
  '<faultstring>stub</faultstring></soap-env:Fault></soap-env:Body></soap-env:Envelope>';

function startStub(): Promise<{ server: Server; url: string }> {
  return new Promise((resolve) => {
    const server = createServer((_req, res) => {
      // Refleja el comportamiento real de DPEC: los faults SOAP 1.1 viajan en HTTP 500.
      res.writeHead(500, { 'Content-Type': 'text/xml' });
      res.end(FAULT_BODY);
    });
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolve({ server, url: `http://127.0.0.1:${port}/soap` });
    });
  });
}

describe('transport teardown', () => {
  let stub: { server: Server; url: string } | null = null;

  after(() => {
    stub?.server.close();
  });

  const socketCount = () =>
    process.getActiveResourcesInfo().filter((r) => /socket|tcp/i.test(r)).length;

  test('closeTransport leaves no socket behind after a real call', async () => {
    stub = await startStub();

    // Baseline tomado con el stub ya escuchando, para no confundir su propio
    // listener/conexión entrante con una fuga del lado cliente.
    const before = socketCount();

    const result = await callSoap({
      url: stub.url,
      xml: '<x/>',
      soapAction: '',
      auth: { user: 'u', password: 'p', charset: 'utf8' },
      timeoutMs: 10_000,
      tls: { mode: 'default' },
    });
    assert.equal(result.httpStatus, 500, 'stub must have been reached');

    await closeTransport();

    // Apaga el stub también, para que sólo queden handles realmente filtrados.
    stub.server.closeAllConnections();
    await new Promise<void>((resolve) => stub!.server.close(() => resolve()));
    stub = null;

    // libuv libera handles de forma asíncrona: un conteo tomado justo después
    // de close() todavía los muestra. Sondear: una fuga real nunca vuelve a bajar.
    const deadline = Date.now() + 2_000;
    while (socketCount() > before && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    const after = socketCount();
    assert.ok(
      after <= before,
      `socket handles stayed at ${after} (baseline ${before}) after 2s — transport leaked`,
    );
  });

  test('closeTransport is safe to call twice', async () => {
    await closeTransport();
    await closeTransport();
  });
});
