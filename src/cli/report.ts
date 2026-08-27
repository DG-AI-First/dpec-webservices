// Per-service block + final verdict. Must be readable by someone unfamiliar
// with the code (spec: "Console summary" requirement). Two rules that are
// easy to get wrong and load-bearing here:
//   - dry run NEVER reports PASS (design §5)
//   - an empty result set IS a PASS, with a line telling the reader to
//     verify the input IDs (design §6, spec "Empty result is success")

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
