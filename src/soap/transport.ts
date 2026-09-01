// Punto de llamada a fetch. Deliberadamente sin test unitario: mockear fetch
// global testearía el mock, no el comportamiento real. Se ejerce con el stub
// local de test/server.test.ts. No debe conocer nada de services/.

import { Agent, getGlobalDispatcher } from 'undici';
import { readFileSync } from 'node:fs';
import type { TlsMode, BasicAuthCharset } from '../config.js';
import { toTransportError } from '../errors.js';

export interface SoapCallOptions {
  readonly url: string;
  readonly xml: string;
  readonly soapAction: string;
  readonly auth: { readonly user: string; readonly password: string; readonly charset: BasicAuthCharset };
  readonly timeoutMs: number;
  readonly tls: TlsMode;
}

export interface SoapCallResult {
  readonly httpStatus: number;
  readonly responseHeaders: Record<string, string>;
  readonly rawBody: string;
  readonly elapsedMs: number;
}

/**
 * Escalera de TLS, peldaños 2-3. El peldaño 1 (trust store default) no
 * necesita dispatcher. Usa un Agent de undici en vez de
 * NODE_TLS_REJECT_UNAUTHORIZED=0, que sería global a todo el proceso.
 */
/**
 * Todo Agent entregado a fetch, para que closeTransport() los libere. Sin
 * esto, cada Agent sin cerrar deja sockets que hacen abortar process.exit()
 * en Windows.
 */
const openAgents = new Set<Agent>();

function buildDispatcher(tls: TlsMode): Agent | undefined {
  if (tls.mode === 'custom-ca') {
    const agent = new Agent({ connect: { ca: readFileSync(tls.caFile) } });
    openAgents.add(agent);
    return agent;
  }
  if (tls.mode === 'insecure') {
    const agent = new Agent({ connect: { rejectUnauthorized: false } });
    openAgents.add(agent);
    return agent;
  }
  return undefined;
}

/**
 * Libera los sockets abiertos antes de terminar el proceso. La llama el
 * shutdown de src/server.ts (SIGTERM/SIGINT).
 * win32: process.exit() con sockets undici abiertos aborta y devuelve 127.
 * Hay que await esto y recién después dejar terminar al proceso. Errores acá
 * se ignoran a propósito: no cambian el resultado que ya se devolvió.
 */
export async function closeTransport(): Promise<void> {
  const agents = [...openAgents];
  openAgents.clear();
  await Promise.all([
    ...agents.map((agent) => agent.close().catch(() => {})),
    getGlobalDispatcher().close().catch(() => {}),
  ]);
}

/**
 * Envía la request SOAP y devuelve el resultado crudo sin importar el status
 * HTTP. Escribir evidencia antes de parsear y chequear fault antes que
 * status es responsabilidad del caller (index.ts), no de esta función.
 * Sólo lanza TransportError si fetch no produce respuesta (red/DNS/TLS/timeout).
 */
export async function callSoap(options: SoapCallOptions): Promise<SoapCallResult> {
  const { url, xml, soapAction, auth, timeoutMs, tls } = options;

  const authHeader = `Basic ${Buffer.from(`${auth.user}:${auth.password}`, auth.charset).toString('base64')}`;
  const dispatcher = buildDispatcher(tls);
  const started = Date.now();

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/xml;charset=UTF-8',
        SOAPAction: `"${soapAction}"`,
        Authorization: authHeader,
      },
      body: xml,
      // @ts-expect-error -- `dispatcher` is a Node/undici fetch extension,
      // not part of the standard lib.dom.d.ts Fetch typings.
      dispatcher,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw toTransportError(err);
  }

  const rawBody = await response.text();
  const elapsedMs = Date.now() - started;

  const responseHeaders: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    responseHeaders[key] = value;
  });

  return { httpStatus: response.status, responseHeaders, rawBody, elapsedMs };
}
