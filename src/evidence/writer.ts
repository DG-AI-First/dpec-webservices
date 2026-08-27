// Evidence capture to disk. See design §5 — every decision here has a
// documented "why", most of them Windows-specific (this is a win32 machine).
//
// Deliberately NOT unit-tested (design §7: fs writes are the I/O shell,
// verified by the dry-run and live paths, not by mocking the filesystem).

import { mkdirSync, writeFileSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RedactedHeaders } from '../soap/types.js';

const HEADER_DENYLIST = new Set(['authorization', 'proxy-authorization', 'cookie', 'set-cookie']);

/**
 * Redaction is structural, not a filter someone can forget to call: this is
 * the ONLY function that can produce a `RedactedHeaders` value (a branded
 * type — see soap/types.ts), and the evidence writer functions below refuse
 * to accept a raw header map at the type level (design §5, layer 1).
 * Layer 2 is the case-insensitive denylist itself.
 */
export function redactHeaders(headers: Readonly<Record<string, string>>): RedactedHeaders {
  const redacted: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    redacted[key] = HEADER_DENYLIST.has(key.toLowerCase()) ? '<redacted>' : value;
  }
  return redacted as RedactedHeaders;
}

/**
 * Layer 3, defense-in-depth (design §5): a literal-substring scrub applied to
 * every serialized evidence string, independent of the header denylist.
 * Justified because a SAP fault or a proxy/logon page can echo the username
 * back in its BODY — observed live: a `?wsdl` GET returned HTTP 200 with a
 * proprietary `<error><user>WSMICTS</user>...</error>` payload. Header
 * redaction alone would have missed that.
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
 * Evidence write failures are best-effort and reported, never fatal (design
 * §5): the probe's primary answer is the SAP verdict, and a full disk must
 * not turn a PASS into a crash. `runId` is assumed already Windows-safe
 * (config.ts's makeRunId already replaces `:`/`.`  with `-`).
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
 * Written BEFORE the network call goes out (design §5, mandatory ordering):
 * if the process dies, hangs, or the network black-holes, the exact
 * attempted bytes still survive on disk. Raw bytes, byte-identical — never
 * re-serialized; scrubSecrets is a targeted literal replace, not reformatting.
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

/** Written BEFORE parsing (design §5, mandatory ordering) — parse failures must never cost us the raw evidence. */
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
 * `latest-summary.json` is a plain COPY, not a symlink: symlinks on Windows
 * need elevated privileges or Developer Mode enabled, and a copy always
 * works regardless of user permissions (design §5).
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
