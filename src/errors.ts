// Error taxonomy -> exit codes. See design §6.
//
// Exit codes answer "who acts next", not "what broke":
//   0 both services answered correctly           -> nobody
//   2 our config/credentials are the problem      -> us (chase credentials)
//   3 SAP was reached and answered with a fault   -> DPEC
//   4 we could not get a usable answer out        -> infra/network/TLS

export type ExitCode = 0 | 2 | 3 | 4;

export type ErrorKind =
  | 'config-missing'
  | 'config-invalid'
  | 'auth-rejected'
  | 'soap-fault'
  | 'business-error'
  | 'network'
  | 'dns'
  | 'tls'
  | 'timeout'
  | 'http-error'
  | 'malformed-response';

export abstract class ProbeError extends Error {
  abstract readonly kind: ErrorKind;
  abstract readonly exitCode: ExitCode;
  readonly remediation?: string;
}

export class AuthRejectedError extends ProbeError {
  readonly kind: ErrorKind = 'auth-rejected';
  readonly exitCode: ExitCode = 2;

  constructor(
    message: string,
    readonly httpStatus: number,
  ) {
    super(message);
    this.name = 'AuthRejectedError';
  }
}

export class SoapFaultError extends ProbeError {
  readonly kind: ErrorKind = 'soap-fault';
  readonly exitCode: ExitCode = 3;

  constructor(
    readonly faultCode: string,
    readonly faultString: string,
  ) {
    super(`SOAP Fault ${faultCode}: ${faultString}`);
    this.name = 'SoapFaultError';
  }
}

export class BusinessError extends ProbeError {
  readonly kind: ErrorKind = 'business-error';
  readonly exitCode: ExitCode = 3;

  constructor(
    readonly code: string,
    readonly text: string,
  ) {
    super(`Business error ${code}: ${text}`);
    this.name = 'BusinessError';
  }
}

export class TransportError extends ProbeError {
  readonly exitCode: ExitCode = 4;

  constructor(
    message: string,
    readonly kind: ErrorKind,
    readonly remediation?: string,
  ) {
    super(message);
    this.name = 'TransportError';
  }
}

export class ParseError extends ProbeError {
  readonly kind: ErrorKind = 'malformed-response';
  readonly exitCode: ExitCode = 4;

  constructor(message: string) {
    super(message);
    this.name = 'ParseError';
  }
}

/** HTTP status -> classification. Returns null for anything that isn't 401/403. */
export function classifyHttpStatus(status: number): AuthRejectedError | null {
  if (status === 401 || status === 403) {
    return new AuthRejectedError(`Authentication rejected (HTTP ${status})`, status);
  }
  return null;
}

/**
 * SAP's business-success convention is unverified (design §11, open question #7).
 * Treat an empty code, or an all-zeros code (e.g. "000"), as success. Anything
 * else is a business error, printed verbatim.
 */
export function classifyBusinessMessage(code: string, text: string): BusinessError | null {
  const normalized = code.trim();
  const isSuccess = normalized === '' || /^0+$/.test(normalized);
  if (isSuccess) return null;
  return new BusinessError(normalized, text);
}

export type Verdict = 'PASS' | 'FAIL';

/**
 * An empty result set is a PASS (design §6) — the absence of rows is a data
 * question, not a service failure. This function never inspects row count;
 * only a genuine business error (SAP itself saying so) can produce FAIL.
 */
export function determineVerdict(businessError: BusinessError | null): Verdict {
  return businessError ? 'FAIL' : 'PASS';
}

export interface CauseDiagnosis {
  readonly kind: 'tls' | 'dns' | 'network' | 'timeout';
  readonly code: string;
  readonly remediation: string;
}

const TLS_CODES = new Set([
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'CERT_HAS_EXPIRED',
  'ERR_TLS_CERT_ALTNAME_INVALID',
]);
const DNS_CODES = new Set(['ENOTFOUND', 'EAI_AGAIN']);
const NETWORK_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH', 'ETIMEDOUT']);

const TLS_REMEDIATION = 'Set DPEC_TLS_CA_FILE=/path/to/dpec-ca.pem (see design §8 TLS ladder).';
const DNS_REMEDIATION = 'Host does not resolve — VPN required?';
const NETWORK_REMEDIATION = 'Check firewall / port / reachability.';
const TIMEOUT_REMEDIATION = 'Raise DPEC_TIMEOUT_MS.';

function classifyCode(code: string): CauseDiagnosis | null {
  if (TLS_CODES.has(code)) return { kind: 'tls', code, remediation: TLS_REMEDIATION };
  if (DNS_CODES.has(code)) return { kind: 'dns', code, remediation: DNS_REMEDIATION };
  if (NETWORK_CODES.has(code)) return { kind: 'network', code, remediation: NETWORK_REMEDIATION };
  return null;
}

interface NodeErrorLike {
  code?: unknown;
  name?: unknown;
  errors?: unknown;
  cause?: unknown;
}

/**
 * Native `fetch` wraps every network failure as `TypeError: fetch failed` —
 * the actionable code is buried in error.cause (sometimes nested two deep,
 * or in cause.errors[] for happy-eyeballs aggregates). Walk the chain.
 */
export function diagnoseCause(err: unknown): CauseDiagnosis | null {
  let current: NodeErrorLike | undefined = err as NodeErrorLike;

  for (let depth = 0; depth < 6 && current; depth += 1) {
    if (typeof current.code === 'string') {
      const diagnosis = classifyCode(current.code);
      if (diagnosis) return diagnosis;
    }

    if (Array.isArray(current.errors)) {
      for (const nested of current.errors as unknown[]) {
        const nestedCode = (nested as NodeErrorLike | undefined)?.code;
        if (typeof nestedCode === 'string') {
          const diagnosis = classifyCode(nestedCode);
          if (diagnosis) return diagnosis;
        }
      }
    }

    if (current.name === 'AbortError') {
      return { kind: 'timeout', code: 'AbortError', remediation: TIMEOUT_REMEDIATION };
    }

    current = current.cause as NodeErrorLike | undefined;
  }

  return null;
}

/** Converts any thrown value from a failed fetch() into a classified TransportError. */
export function toTransportError(err: unknown): TransportError {
  const diagnosis = diagnoseCause(err);
  if (diagnosis) {
    return new TransportError(
      `Transport failure: ${diagnosis.code}`,
      diagnosis.kind,
      diagnosis.remediation,
    );
  }
  const message = err instanceof Error ? err.message : String(err);
  return new TransportError(`Transport failure: ${message}`, 'network');
}

/**
 * Both services run independently; one failure must never block the other's
 * evidence. Final exit code by precedence: any 4 -> 4; else any 3 -> 3; else 0.
 * Transport outranks business/fault because an unreachable service tells you
 * nothing about its business behaviour — the unknown is strictly bigger.
 */
export function aggregateExitCode(codes: readonly ExitCode[]): ExitCode {
  if (codes.includes(4)) return 4;
  if (codes.includes(3)) return 3;
  if (codes.includes(2)) return 2;
  return 0;
}
