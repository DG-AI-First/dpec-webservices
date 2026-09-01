// Bloque por servicio + veredicto final. Dos reglas fáciles de romper:
//   - un dry run NUNCA reporta PASS
//   - un resultado vacío ES un PASS, con una línea para verificar los IDs

import type { RunSummary, ServiceResult } from '../evidence/summary.js';

const BORDER = '='.repeat(70);

export function printServiceResult(result: ServiceResult): void {
  console.log(`--- ${result.serviceName} (${result.operationName}) ---`);
  console.log(`  url          ${result.url}`);
  console.log(`  http status  ${result.httpStatus ?? '(no request sent)'}`);
  console.log(`  elapsed      ${result.elapsedMs}ms`);
  console.log(`  verdict      ${result.verdict}${result.failureKind ? ` (${result.failureKind})` : ''}`);

  if (result.verdict === 'SKIPPED') {
    console.log('  skipped — dry run, no request was sent to DPEC.');
  } else if (result.verdict === 'PASS' && result.recordCount === 0) {
    console.log('  service responded correctly, 0 rows — verify the input IDs with DPEC.');
  }

  for (const msg of result.businessMessage) {
    console.log(`  message      [${msg.code}] ${msg.text}`);
  }

  if (result.evidenceFiles.length > 0) {
    for (const file of result.evidenceFiles) console.log(`  evidence     ${file}`);
  }
  if (result.evidenceWriteError) {
    console.log(`  evidence write FAILED (non-fatal): ${result.evidenceWriteError}`);
  }
  console.log('');
}

export function printFinalVerdict(summary: RunSummary): void {
  console.log(BORDER);
  console.log(`  run          ${summary.runId}`);
  console.log(`  verdict      ${summary.overallVerdict}`);

  if (summary.overallVerdict === 'DRY-RUN') {
    console.log("  No live evidence of DPEC's behaviour was produced — this run only verified our own code paths.");
  }

  console.log(`  exit code    ${summary.exitCode}`);
  console.log(BORDER);
}
