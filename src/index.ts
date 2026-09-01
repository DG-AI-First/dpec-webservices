#!/usr/bin/env node
// Composition root: config -> services -> transport -> evidence -> cli.
// Invariantes: evidencia de request ANTES del call de red, evidencia de
// response ANTES de parsear, fault ANTES que status HTTP (los faults SOAP
// 1.1 viajan en HTTP 500). Ambos servicios corren independientes.

import { loadConfig, ConfigError, type AppConfig } from './config.js';
import {
  AuthRejectedError,
  BusinessError,
  ProbeError,
  SoapFaultError,
  TransportError,
  aggregateExitCode,
  classifyHttpStatus,
  type ExitCode,
} from './errors.js';
import { buildEnvelope } from './soap/envelope.js';
import { parseXml, findFault, unwrapBody } from './soap/parser.js';
import { callSoap, closeTransport } from './soap/transport.js';
import type { SoapOperation, WireField } from './soap/types.js';
import { zWsSap002 } from './services/zWsSap002.js';
import { zFicaDeudaIcUnif } from './services/zFicaDeudaIcUnif.js';
import {
  createRunDirectory,
  redactHeaders,
  writeMetaEvidence,
  writeRequestEvidence,
  writeResponseEvidence,
} from './evidence/writer.js';
import { buildRunSummary, writeRunSummary, type ServiceResult } from './evidence/summary.js';
import { printBanner } from './cli/banner.js';
import { printServiceResult, printFinalVerdict } from './cli/report.js';

// Vars de negocio fuera del schema de infra de AppConfig (no forman parte de
// la matriz de seguridad PROD). Nombres iguales a spike.mjs, la única
// convención para estas vars en todo el repo.
function env(key: string, fallback = ''): string {
  return (process.env[key] ?? fallback).trim();
}

function resolveInputs() {
  return {
    zWsSap002: {
      iAnlage: env('DPEC_ANLAGE'),
      iPartner: env('DPEC_PARTNER'),
      iCantfact: env('DPEC_CANTFACT', '10'),
    },
    zFicaDeudaIcUnif: {
      piCc: env('DPEC_CC'),
      piIc: env('DPEC_IC'),
      piI: env('DPEC_I'),
      piFechaHasta: env('DPEC_FECHA_HASTA'),
      piNumMax: env('DPEC_NUM_MAX', '10'),
    },
  };
}

interface RunContext {
  readonly config: AppConfig;
  readonly runDir: string | null;
  readonly secrets: readonly string[];
}

async function runOperation<TInput, TOutput>(
  ctx: RunContext,
  index: number,
  op: SoapOperation<TInput, TOutput>,
  input: TInput,
): Promise<{ result: ServiceResult; exitCode: ExitCode }> {
  const { config, runDir, secrets } = ctx;
  const url = `${config.scheme}://${config.host}${op.endpointPath}?sap-client=${config.sapClient}`;
  const fields: WireField[] = op.buildFields(input);
  const xml = buildEnvelope(op, fields);

  const evidenceFiles: string[] = [];
  let evidenceWriteError: string | undefined;

  // Escrito ANTES del call de red (ver header del módulo). Corre también en
  // dry-run: mostrar qué se habría mandado es el objetivo del dry run.
  if (runDir) {
    const write = writeRequestEvidence(runDir, index, op.serviceName, xml, secrets);
    if (write.ok && write.path) evidenceFiles.push(write.path);
    else if (write.error) evidenceWriteError = write.error;
  }

  if (config.dryRun) {
    return {
      exitCode: 0,
      result: {
        serviceName: op.serviceName,
        operationName: op.operationName,
        url,
        httpStatus: null,
        elapsedMs: 0,
        verdict: 'SKIPPED',
        failureKind: null,
        businessMessage: [],
        recordCount: null,
        evidenceFiles,
        evidenceWriteError,
      },
    };
  }

  // Invariante: resolveCredentials() en config.ts ya tira ConfigError si
  // !dryRun y faltan user/password. Angostado explícito (no con `!`) para
  // fallar ruidoso ante una regresión futura, no en silencio.
  if (config.user === null || config.password === null) {
    throw new Error('Invariant violated: live mode requires resolved credentials.');
  }
  const user = config.user;
  const password = config.password.reveal();
  // op.soapAction es autoritativo por operación. No hay override de config:
  // DPEC_SOAP_ACTION se sacó porque mc-style necesita '' y ZZCS_INFO_IC_WS
  // necesita su propio valor no vacío.
  const soapAction = op.soapAction;

  const requestHeaders = redactHeaders({
    'Content-Type': 'text/xml;charset=UTF-8',
    SOAPAction: `"${soapAction}"`,
    Authorization: `Basic ${Buffer.from(`${user}:${password}`, config.basicAuthCharset).toString('base64')}`,
  });

  let httpStatus: number | null = null;
  let responseHeaders: Record<string, string> | null = null;
  let elapsedMs = 0;
  let rawBody = '';
  let responseElementMismatch: string | undefined;
  let probeError: ProbeError | null = null;
  let businessMessage: ReadonlyArray<{ code: string; text: string }> = [];
  let recordCount: number | null = null;
  let verdict: ServiceResult['verdict'] = 'PASS';

  try {
    const callResult = await callSoap({
      url,
      xml,
      soapAction,
      auth: { user, password, charset: config.basicAuthCharset },
      timeoutMs: config.timeoutMs,
      tls: config.tls,
    });

    httpStatus = callResult.httpStatus;
    responseHeaders = callResult.responseHeaders;
    elapsedMs = callResult.elapsedMs;
    rawBody = callResult.rawBody;

    // Escrito ANTES de parsear (ver header del módulo).
    if (runDir) {
      const write = writeResponseEvidence(runDir, index, op.serviceName, rawBody, secrets);
      if (write.ok && write.path) evidenceFiles.push(write.path);
      else if (write.error) evidenceWriteError = evidenceWriteError ?? write.error;
    }

    const parsed = parseXml(rawBody); // lanza ParseError si el XML no es válido

    // Fault ANTES que status: los faults SOAP 1.1 viajan en HTTP 500.
    const fault = findFault(parsed);
    if (fault) throw new SoapFaultError(fault.faultCode, fault.faultString);

    const authError = classifyHttpStatus(httpStatus);
    if (authError) throw authError;

    if (httpStatus < 200 || httpStatus >= 300) {
      throw new TransportError(`Unexpected HTTP status ${httpStatus}`, 'http-error');
    }

    const unwrapped = unwrapBody(parsed, op.operationName);
    responseElementMismatch = unwrapped.responseElementMismatch;

    const output = op.parseResult(unwrapped.node);
    const outcome = op.summarize(output);

    recordCount = outcome.recordCount;
    businessMessage = outcome.businessMessage;
    verdict = outcome.verdict;

    if (verdict === 'FAIL') {
      const [first] = outcome.businessMessage;
      probeError = new BusinessError(first?.code ?? '', first?.text ?? '');
    }
  } catch (err) {
    verdict = 'FAIL';
    probeError =
      err instanceof ProbeError
        ? err
        : new TransportError(err instanceof Error ? err.message : String(err), 'network');
    if (probeError instanceof AuthRejectedError) httpStatus = probeError.httpStatus;
  }

  if (runDir) {
    const write = writeMetaEvidence(
      runDir,
      index,
      op.serviceName,
      {
        url,
        method: 'POST',
        soapAction,
        requestHeaders,
        httpStatus,
        responseHeaders,
        startedAt: new Date().toISOString(),
        elapsedMs,
        requestBytes: Buffer.byteLength(xml, 'utf8'),
        responseBytes: Buffer.byteLength(rawBody, 'utf8'),
        classification: probeError?.kind ?? 'ok',
        errorKind: probeError?.kind ?? null,
        tlsMode: config.tls.mode,
        responseElementMismatch,
      },
      secrets,
    );
    if (write.ok && write.path) evidenceFiles.push(write.path);
    else if (write.error) evidenceWriteError = evidenceWriteError ?? write.error;
  }

  return {
    exitCode: probeError ? probeError.exitCode : 0,
    result: {
      serviceName: op.serviceName,
      operationName: op.operationName,
      url,
      httpStatus,
      elapsedMs,
      verdict,
      failureKind: probeError?.kind ?? null,
      businessMessage,
      recordCount,
      evidenceFiles,
      evidenceWriteError,
    },
  };
}

async function main(): Promise<void> {
  let config: AppConfig;
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

  printBanner(config);

  const runDirResult = createRunDirectory(config.evidenceDir, config.runId);
  const runDir = runDirResult.ok ? (runDirResult.path ?? null) : null;
  if (!runDirResult.ok) {
    console.error(`WARNING: could not create evidence directory (non-fatal): ${runDirResult.error}`);
  }

  const secrets = config.password ? [config.password.reveal()] : [];
  const ctx: RunContext = { config, runDir, secrets };
  const inputs = resolveInputs();

  const [fica, invoices] = await Promise.all([
    runOperation(ctx, 1, zFicaDeudaIcUnif, inputs.zFicaDeudaIcUnif),
    runOperation(ctx, 2, zWsSap002, inputs.zWsSap002),
  ]);

  for (const outcome of [fica, invoices]) printServiceResult(outcome.result);

  const overallVerdict = config.dryRun
    ? 'DRY-RUN'
    : [fica, invoices].every((o) => o.result.verdict === 'PASS')
      ? 'PASS'
      : 'FAIL';
  const exitCode: ExitCode = config.dryRun
    ? 0
    : aggregateExitCode([fica.exitCode, invoices.exitCode]);

  const summary = buildRunSummary({
    runId: config.runId,
    startedAt: new Date().toISOString(),
    env: config.env,
    targetHost: config.host,
    scheme: config.scheme,
    sapClient: config.sapClient,
    dryRun: config.dryRun,
    tlsMode: config.tls.mode,
    services: [fica.result, invoices.result],
    overallVerdict,
    exitCode,
  });

  if (runDir) {
    const { summaryWrite, latestCopy } = writeRunSummary(config.evidenceDir, runDir, summary, secrets);
    if (!summaryWrite.ok) console.error(`WARNING: could not write summary.json (non-fatal): ${summaryWrite.error}`);
    if (!latestCopy.ok) console.error(`WARNING: could not write latest-summary.json (non-fatal): ${latestCopy.error}`);
  }

  printFinalVerdict(summary);

  // Libera sockets y deja terminar a Node solo. process.exit() acá aborta en
  // Windows mientras undici sigue cerrando conexiones y devuelve 127 en vez
  // de este código. Ver closeTransport() y test/exit-contract.test.ts.
  await closeTransport();
  process.exitCode = exitCode;
}

main().catch(async (err) => {
  console.error('UNEXPECTED FAILURE (this should never happen — please report it):');
  console.error(err);
  await closeTransport().catch(() => {});
  process.exitCode = 4;
});
