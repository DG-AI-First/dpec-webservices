// Configuration model. process.env is read ONCE here (via loadConfig) and
// nowhere else in the codebase — see design §4 "config.ts is read once".
//
// The injectable `env` parameter (defaulting to process.env) is what makes
// the entire PROD-safety enforcement matrix testable with plain objects.

const HOSTS = { qa: 'sapqas.dpec.com.ar', prod: 'sapprd.dpec.com.ar' } as const;

export type Environment = 'qa' | 'prod';
export type Scheme = 'https' | 'http';
export type BasicAuthCharset = 'utf8' | 'latin1';

export type TlsMode =
  | { readonly mode: 'default' }
  | { readonly mode: 'custom-ca'; readonly caFile: string }
  | { readonly mode: 'insecure' };

/**
 * Branded wrapper so the SAP password cannot leak through a template
 * literal, JSON.stringify(config), or console.log(config). The only way
 * out is the explicit .reveal() call, made once, in soap/transport.ts.
 */
export class Secret {
  constructor(private readonly value: string) {}

  reveal(): string {
    return this.value;
  }

  toString(): string {
    return '***REDACTED***';
  }

  toJSON(): string {
    return '***REDACTED***';
  }

  [Symbol.for('nodejs.util.inspect.custom')](): string {
    return '***REDACTED***';
  }
}

export interface AppConfig {
  readonly runId: string;
  readonly env: Environment;
  readonly scheme: Scheme;
  readonly host: string;
  readonly sapClient: string;
  readonly user: string | null;
  readonly password: Secret | null;
  readonly basicAuthCharset: BasicAuthCharset;
  readonly dryRun: boolean;
  readonly timeoutMs: number;
  readonly evidenceDir: string;
  readonly tls: TlsMode;
}

export class ConfigError extends Error {
  readonly kind: 'config-missing' | 'config-invalid';
  readonly exitCode = 2 as const;

  constructor(message: string, kind: 'config-missing' | 'config-invalid' = 'config-invalid') {
    super(message);
    this.name = 'ConfigError';
    this.kind = kind;
  }
}

function makeRunId(): string {
  // Windows forbids ':' in filenames — see design §5. Every consumer of
  // runId (evidence dir naming) depends on this format already being safe.
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function trimmed(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const raw = env[key];
  return raw === undefined ? undefined : raw.trim();
}

function resolveEnvironment(env: NodeJS.ProcessEnv): Environment {
  const raw = trimmed(env, 'DPEC_ENV');
  if (raw === undefined) return 'qa';
  if (raw === 'qa' || raw === 'prod') return raw;
  throw new ConfigError(
    `DPEC_ENV must be exactly "qa" or "prod" (got ${JSON.stringify(env.DPEC_ENV)}). ` +
      'Refusing to guess or fall back to a default.',
  );
}

function assertProdConfirmed(env: NodeJS.ProcessEnv, resolvedEnv: Environment): void {
  if (resolvedEnv !== 'prod') return;
  const token = env.DPEC_CONFIRM_PROD;
  if (token !== 'I_UNDERSTAND_THIS_HITS_PRODUCTION') {
    throw new ConfigError(
      'DPEC_ENV=prod requires DPEC_CONFIRM_PROD=I_UNDERSTAND_THIS_HITS_PRODUCTION. ' +
        'Absence of this flag is not consent.',
    );
  }
}

function resolveScheme(env: NodeJS.ProcessEnv): Scheme {
  const raw = trimmed(env, 'DPEC_SCHEME');
  if (raw === undefined || raw === '') return 'https';
  if (raw === 'https' || raw === 'http') return raw;
  throw new ConfigError(`DPEC_SCHEME must be "https" or "http" (got ${JSON.stringify(env.DPEC_SCHEME)}).`);
}

function resolveSapClient(env: NodeJS.ProcessEnv): string {
  const raw = trimmed(env, 'SAP_CLIENT');
  if (raw === undefined || raw === '') return '100';
  if (/^\d{3}$/.test(raw)) return raw;
  throw new ConfigError(`SAP_CLIENT must be exactly 3 digits (got ${JSON.stringify(env.SAP_CLIENT)}).`);
}

function resolveDryRun(env: NodeJS.ProcessEnv): boolean {
  const raw = trimmed(env, 'DPEC_DRY_RUN');
  if (raw === undefined || raw === '') return false;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  throw new ConfigError(`DPEC_DRY_RUN must be "true" or "false" (got ${JSON.stringify(env.DPEC_DRY_RUN)}).`);
}

function resolveTimeoutMs(env: NodeJS.ProcessEnv): number {
  const raw = trimmed(env, 'DPEC_TIMEOUT_MS');
  if (raw === undefined || raw === '') return 30_000;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new ConfigError(`DPEC_TIMEOUT_MS must be a positive integer (got ${JSON.stringify(env.DPEC_TIMEOUT_MS)}).`);
  }
  return parsed;
}

function resolveBasicAuthCharset(env: NodeJS.ProcessEnv): BasicAuthCharset {
  const raw = trimmed(env, 'DPEC_BASIC_AUTH_CHARSET');
  if (raw === undefined || raw === '') return 'utf8';
  if (raw === 'utf8' || raw === 'latin1') return raw;
  throw new ConfigError(
    `DPEC_BASIC_AUTH_CHARSET must be "utf8" or "latin1" (got ${JSON.stringify(env.DPEC_BASIC_AUTH_CHARSET)}).`,
  );
}

function resolveTls(env: NodeJS.ProcessEnv, resolvedEnv: Environment): TlsMode {
  const insecureRaw = trimmed(env, 'DPEC_TLS_INSECURE');
  const caFile = trimmed(env, 'DPEC_TLS_CA_FILE');

  if (insecureRaw !== undefined && insecureRaw !== '') {
    // Rung 3 is QA-only, and that is a config-time impossibility under prod —
    // rejected regardless of value, never a runtime branch that could be missed.
    if (resolvedEnv === 'prod') {
      throw new ConfigError(
        'DPEC_TLS_INSECURE cannot be set under DPEC_ENV=prod, regardless of its value.',
      );
    }
    if (insecureRaw !== 'YES_I_ACCEPT_INSECURE_TLS_ON_QA') {
      throw new ConfigError(
        'DPEC_TLS_INSECURE must be exactly "YES_I_ACCEPT_INSECURE_TLS_ON_QA" or unset.',
      );
    }
    return { mode: 'insecure' };
  }

  if (caFile !== undefined && caFile !== '') {
    return { mode: 'custom-ca', caFile };
  }

  return { mode: 'default' };
}

function resolveCredentials(
  env: NodeJS.ProcessEnv,
  dryRun: boolean,
): { user: string | null; password: Secret | null } {
  const user = trimmed(env, 'SAP_USER');
  const password = env.SAP_PASSWORD; // never trim a password — whitespace may be intentional

  if (dryRun) {
    return { user: user ?? null, password: password ? new Secret(password) : null };
  }

  if (!user || !password) {
    throw new ConfigError(
      'SAP_USER / SAP_PASSWORD are required outside dry-run mode. Copy .env.example to .env and fill them in.',
      'config-missing',
    );
  }

  return { user, password: new Secret(password) };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const resolvedEnv = resolveEnvironment(env);
  assertProdConfirmed(env, resolvedEnv);

  const scheme = resolveScheme(env);
  const sapClient = resolveSapClient(env);
  const dryRun = resolveDryRun(env);
  const timeoutMs = resolveTimeoutMs(env);
  const basicAuthCharset = resolveBasicAuthCharset(env);
  const tls = resolveTls(env, resolvedEnv);
  const { user, password } = resolveCredentials(env, dryRun);

  const evidenceDirRaw = trimmed(env, 'DPEC_EVIDENCE_DIR');
  const evidenceDir = evidenceDirRaw === undefined || evidenceDirRaw === '' ? './evidence' : evidenceDirRaw;

  return Object.freeze({
    runId: makeRunId(),
    env: resolvedEnv,
    scheme,
    host: HOSTS[resolvedEnv],
    sapClient,
    user,
    password,
    basicAuthCharset,
    dryRun,
    timeoutMs,
    evidenceDir,
    tls,
  });
}
