// The fetch call site — deliberately NOT unit-tested (design §7: asserting
// "fetch was called with the right URL" requires mocking global fetch, which
// tests the mock). Verified via dry-run (skips this entirely) and the live
// probe. Must stay domain-free: no tFact, no poDocumentos, nothing that
// belongs to services/ — see design §1 layer map.

import { Agent } from 'undici';
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
 * TLS ladder, rungs 2-3 (design §8). Rung 1 (default trust store) needs no
 * dispatcher at all — returning undefined lets fetch use its normal path.
 * Deliberately scoped via an undici Agent rather than
 * NODE_TLS_REJECT_UNAUTHORIZED=0, which would be process-global and disable
 * verification for every connection the process makes.
 */
function buildDispatcher(tls: TlsMode): Agent | undefined {
  if (tls.mode === 'custom-ca') {
    return new Agent({ connect: { ca: readFileSync(tls.caFile) } });
  }
  if (tls.mode === 'insecure') {
    return new Agent({ connect: { rejectUnauthorized: false } });
  }
  return undefined;
}

/**
 * Sends one SOAP request and returns the raw result whatever the HTTP
 * status turned out to be — the mandatory "read body as text always, write
 * evidence before parsing, check fault before status" ordering (design §3)
 * is the CALLER's responsibility (index.ts), not this function's: transport
 * must not know about evidence writing or fault detection, only bytes.
 *
 * Throws a classified TransportError only when fetch itself fails to
 * produce a response at all (network/DNS/TLS/timeout) — never for a non-2xx
 * status, since a 401 or a SOAP-fault-bearing 500 is a real, readable answer.
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
