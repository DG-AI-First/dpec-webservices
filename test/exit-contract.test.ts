// The exit-code contract is this deliverable's core value: it answers WHICH SIDE
// the problem is on. A process that crashes on the way out destroys that answer
// no matter how correctly it classified the error internally.
//
// Observed on win32 against the live QA endpoint: calling process.exit() while
// undici still had sockets closing produced
//   Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), src\win\async.c:94
// and the process exited 127 instead of the computed 3. A CI reading 127 cannot
// distinguish "DPEC returned a fault" from "our script blew up".
//
// Two layers of cover:
//  - closeTransport() against a real local server: exercises the actual socket
//    teardown path without depending on DPEC or the network.
//  - a spawned dry run: guards the end-to-end exit contract on the no-network path.

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { callSoap, closeTransport } from '../src/soap/transport.js';

const FAULT_BODY =
  '<soap-env:Envelope xmlns:soap-env="http://schemas.xmlsoap.org/soap/envelope/">' +
  '<soap-env:Body><soap-env:Fault><faultcode>soap-env:Server</faultcode>' +
  '<faultstring>stub</faultstring></soap-env:Fault></soap-env:Body></soap-env:Envelope>';

function startStub(): Promise<{ server: Server; url: string }> {
  return new Promise((resolve) => {
    const server = createServer((_req, res) => {
      // Mirrors the real DPEC behaviour: SOAP 1.1 faults ride on HTTP 500.
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

    // Baseline taken with the stub already listening, so its own listener and
    // inbound connection are not mistaken for a client-side leak.
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

    // Shut the stub down too, so only genuinely leaked handles remain.
    stub.server.closeAllConnections();
    await new Promise<void>((resolve) => stub!.server.close(() => resolve()));
    stub = null;

    // libuv frees handles asynchronously, so a count taken the instant after
    // close() still shows them. Poll: a real leak never comes back down.
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

describe('process exit contract', () => {
  function runDry() {
    return spawnSync(process.execPath, ['--import', 'tsx', 'scripts/dry-run.mjs'], {
      encoding: 'utf8',
      // Deliberately no credentials: a dry run must work without them.
      env: { ...process.env, SAP_USER: '', SAP_PASSWORD: '' },
      timeout: 60_000,
    });
  }

  test('dry run exits with its computed code, not a crash code', () => {
    assert.equal(runDry().status, 0);
  });

  test('no libuv assertion, no signal kill', () => {
    const { stderr, signal } = runDry();
    assert.ok(!/Assertion failed/i.test(stderr), `crashed while exiting:\n${stderr}`);
    assert.equal(signal, null);
  });
});
