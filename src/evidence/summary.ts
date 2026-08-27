// summary.json assembly. See design §5. Deliberately NOT unit-tested — pure
// assembly of already-tested data plus fs writes (the I/O shell, design §7).

import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import type { ErrorKind } from '../errors.js';
import { scrubSecrets, writeLatestSummaryCopy, type EvidenceWriteResult } from './writer.js';

export type OverallVerdict = 'PASS' | 'FAIL' | 'DRY-RUN';
export type ServiceVerdict = 'PASS' | 'FAIL' | 'SKIPPED';

export interface ServiceResult {
  readonly serviceName: string;
  readonly operationName: string;
  readonly url: string;
  readonly httpStatus: number | null;
  readonly elapsedMs: number;
  readonly verdict: ServiceVerdict;
  readonly failureKind: ErrorKind | null;
  readonly businessMessage: ReadonlyArray<{ code: string; text: string }>;
  readonly recordCount: number | null;
  readonly evidenceFiles: readonly string[];
  readonly evidenceWriteError?: string;
}

export interface RunSummary {
  readonly runId: string;
  readonly startedAt: string;
  readonly nodeVersion: string;
  readonly env: 'qa' | 'prod';
  readonly targetHost: string;
  readonly scheme: string;
  readonly sapClient: string;
  readonly dryRun: boolean;
  readonly tlsMode: string;
  readonly services: readonly ServiceResult[];
  readonly overallVerdict: OverallVerdict;
  readonly exitCode: 0 | 2 | 3 | 4;
}

export function buildRunSummary(params: {
  runId: string;
  startedAt: string;
  env: 'qa' | 'prod';
  targetHost: string;
  scheme: string;
  sapClient: string;
  dryRun: boolean;
  tlsMode: string;
  services: readonly ServiceResult[];
  overallVerdict: OverallVerdict;
  exitCode: 0 | 2 | 3 | 4;
}): RunSummary {
  return Object.freeze({ ...params, nodeVersion: process.version });
}

/**
 * Writes summary.json inside the run directory, then copies it to
 * `evidenceDir/latest-summary.json`. Evidence write failures are best-effort
 * and never fatal (design §5) — if summary.json itself fails to write, the
 * copy step is skipped rather than crashing.
 */
export function writeRunSummary(
  evidenceDir: string,
  runDir: string,
  summary: RunSummary,
  secrets: readonly string[],
): { summaryWrite: EvidenceWriteResult; latestCopy: EvidenceWriteResult } {
  const summaryPath = join(runDir, 'summary.json');
  const serialized = scrubSecrets(JSON.stringify(summary, null, 2), secrets);

  let summaryWrite: EvidenceWriteResult;
  try {
    writeFileSync(summaryPath, serialized, 'utf8');
    summaryWrite = { ok: true, path: summaryPath };
  } catch (err) {
    summaryWrite = { ok: false, error: err instanceof Error ? err.message : String(err) };
  }

  const latestCopy = summaryWrite.ok
    ? writeLatestSummaryCopy(evidenceDir, summaryPath)
    : { ok: false, error: 'skipped: summary.json was not written' };

  return { summaryWrite, latestCopy };
}
