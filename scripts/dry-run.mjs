// Cross-platform "npm run dry" launcher.
//
// npm's script shell is cmd.exe on Windows, so `DPEC_DRY_RUN=true node ...`
// (which relies on POSIX shell env-var syntax) does not work portably.
// Setting the variable here, before importing the composition root, is a
// zero-dependency way to force dry-run mode regardless of the host shell —
// same Node process, so process.env is already set by the time
// src/index.ts calls loadConfig(process.env).
process.env.DPEC_DRY_RUN = 'true';

await import('../src/index.ts');
