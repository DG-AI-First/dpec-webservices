// Captura de evidencia a disco. Deliberadamente sin test unitario: los
// writes a fs son la capa de I/O, verificada por dry-run y por el camino en
// vivo, no mockeando el filesystem.

import { mkdirSync, writeFileSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RedactedHeaders } from '../soap/types.js';

const HEADER_DENYLIST = new Set(['authorization', 'proxy-authorization', 'cookie', 'set-cookie']);

/**
 * La redacción es estructural: ésta es la ÚNICA función que puede producir
 * un RedactedHeaders (tipo con marca, ver soap/types.ts). Capa 2 es la
 * denylist case-insensitive en sí.
 */
export function redactHeaders(headers: Readonly<Record<string, string>>): RedactedHeaders {
  const redacted: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    redacted[key] = HEADER_DENYLIST.has(key.toLowerCase()) ? '<redacted>' : value;
  }
  return redacted as RedactedHeaders;
}

/**
 * Capa 3, defensa en profundidad: scrub por substring literal sobre cada
 * string de evidencia, independiente de la denylist de headers. Un fault SAP
 * o una página de logon pueden devolver el username en el BODY: observado en
 * vivo, un GET a ?wsdl devolvió `<error><user>WSMICTS</user>...</error>`.
 */
export function scrubSecrets(text: string, secrets: readonly string[]): string {
  let scrubbed = text;
  for (const secret of secrets) {
    if (!secret) continue;
    scrubbed = scrubbed.split(secret).join('***');
  }
  return scrubbed;
}

export interface EvidenceWriteResult {
  readonly ok: boolean;
  readonly path?: string;
  readonly error?: string;
}

function safeWrite(path: string, content: string): EvidenceWriteResult {
  try {
    writeFileSync(path, content, 'utf8');
    return { ok: true, path };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Fallas al escribir evidencia son best-effort y no fatales: el veredicto
 * principal es el de SAP, un disco lleno no debe convertir un PASS en un
 * crash. `runId` ya viene sanitizado para Windows (makeRunId en config.ts).
 */
export function createRunDirectory(evidenceDir: string, runId: string): EvidenceWriteResult {
  const runDir = join(evidenceDir, `run-${runId}`);
  try {
    mkdirSync(runDir, { recursive: true });
    return { ok: true, path: runDir };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function ordinalPrefix(index: number): string {
  return String(index).padStart(2, '0');
}

/**
 * Escrito ANTES del call de red: si el proceso muere, cuelga, o la red se
 * pierde, los bytes exactos que se intentaron mandar sobreviven en disco.
 */
export function writeRequestEvidence(
  runDir: string,
  index: number,
  serviceName: string,
  xml: string,
  secrets: readonly string[],
): EvidenceWriteResult {
  const path = join(runDir, `${ordinalPrefix(index)}-${serviceName}.request.xml`);
  return safeWrite(path, scrubSecrets(xml, secrets));
}

/** Escrito ANTES de parsear: una falla de parseo nunca debe costarnos la evidencia cruda. */
export function writeResponseEvidence(
  runDir: string,
  index: number,
  serviceName: string,
  raw: string,
  secrets: readonly string[],
): EvidenceWriteResult {
  const path = join(runDir, `${ordinalPrefix(index)}-${serviceName}.response.xml`);
  return safeWrite(path, scrubSecrets(raw, secrets));
}

export interface CallMeta {
  readonly url: string;
  readonly method: 'POST';
  readonly soapAction: string;
  readonly requestHeaders: RedactedHeaders;
  readonly httpStatus: number | null;
  readonly responseHeaders: Record<string, string> | null;
  readonly startedAt: string;
  readonly elapsedMs: number;
  readonly requestBytes: number;
  readonly responseBytes: number;
  readonly classification: string;
  readonly errorKind: string | null;
  readonly tlsMode: string;
  readonly responseElementMismatch?: string;
}

export function writeMetaEvidence(
  runDir: string,
  index: number,
  serviceName: string,
  meta: CallMeta,
  secrets: readonly string[],
): EvidenceWriteResult {
  const path = join(runDir, `${ordinalPrefix(index)}-${serviceName}.meta.json`);
  return safeWrite(path, scrubSecrets(JSON.stringify(meta, null, 2), secrets));
}

/**
 * Copia real, no symlink: los symlinks en Windows piden privilegios elevados
 * o Developer Mode; una copia siempre funciona.
 */
export function writeLatestSummaryCopy(evidenceDir: string, summaryPath: string): EvidenceWriteResult {
  const latestPath = join(evidenceDir, 'latest-summary.json');
  try {
    copyFileSync(summaryPath, latestPath);
    return { ok: true, path: latestPath };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
