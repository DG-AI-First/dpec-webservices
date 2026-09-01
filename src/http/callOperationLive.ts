// Implementación real de OperationCaller (flows/consultaPorDni.ts) para el
// server HTTP: arma el envelope, llama SOAP y clasifica la respuesta en
// UpstreamError, sin escribir evidencia a disco -- eso era exclusivo del
// probe (ya eliminado), el server no escribe evidence/.
//
// Deliberadamente sin test unitario propio (igual criterio que
// soap/transport.ts): es red real. Se ejerce con el stub de test/server.test.ts.

import type { AppConfig } from '../config.js';

/**
 * Subconjunto mínimo de AppConfig que esta capacidad necesita -- así se
 * puede construir un config de test en memoria (sin pasar por loadConfig())
 * apuntando a un stub local, en vez de a sapqas/sapprd.dpec.com.ar.
 */
export type LiveCallerConfig = Pick<
  AppConfig,
  'scheme' | 'host' | 'sapClient' | 'user' | 'password' | 'basicAuthCharset' | 'timeoutMs' | 'tls'
>;
import { UpstreamError, SoapFaultError, TransportError, classifyHttpStatus, toTransportError } from '../errors.js';
import { buildEnvelope } from '../soap/envelope.js';
import { parseXml, findFault, unwrapBody } from '../soap/parser.js';
import { callSoap } from '../soap/transport.js';
import type { SoapOperation } from '../soap/types.js';
import type { OperationCaller } from '../flows/consultas.js';

/** Construye un OperationCaller atado a la config del server (host/credenciales/TLS/timeout). */
export function makeLiveOperationCaller(config: LiveCallerConfig): OperationCaller {
  return async function callOperation<TInput, TOutput>(
    op: SoapOperation<TInput, TOutput>,
    input: TInput,
  ): Promise<TOutput> {
    // Invariante: el server siempre corre en modo vivo (no hay dry-run para
    // HTTP). Si esto dispara, es un error de configuración/arranque, no un
    // caso de negocio -- por eso no es un UpstreamError: el catch de arriba
    // (router) lo trata como 500 genérico.
    if (config.user === null || config.password === null) {
      throw new Error('Invariant violated: the server requires resolved SAP credentials.');
    }

    const url = `${config.scheme}://${config.host}${op.endpointPath}?sap-client=${config.sapClient}`;
    const fields = op.buildFields(input);
    const xml = buildEnvelope(op, fields);

    try {
      const callResult = await callSoap({
        url,
        xml,
        soapAction: op.soapAction,
        auth: { user: config.user, password: config.password.reveal(), charset: config.basicAuthCharset },
        timeoutMs: config.timeoutMs,
        tls: config.tls,
      });

      const parsed = parseXml(callResult.rawBody);

      // Fault ANTES que status: los faults SOAP 1.1 viajan en HTTP 500.
      const fault = findFault(parsed);
      if (fault) throw new SoapFaultError(fault.faultCode, fault.faultString);

      const authError = classifyHttpStatus(callResult.httpStatus);
      if (authError) throw authError;

      if (callResult.httpStatus < 200 || callResult.httpStatus >= 300) {
        throw new TransportError(`Unexpected HTTP status ${callResult.httpStatus}`, 'http-error');
      }

      const unwrapped = unwrapBody(parsed, op.operationName);
      return op.parseResult(unwrapped.node);
    } catch (err) {
      if (err instanceof UpstreamError) throw err;
      throw toTransportError(err);
    }
  };
}
