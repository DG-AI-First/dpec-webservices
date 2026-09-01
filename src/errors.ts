// Taxonomía de errores del lado SAP/transporte, consumida por
// http/mapOutcome.ts para elegir el status HTTP de respuesta. La versión
// previa también cargaba un exit code (0/2/3/4): eso era el contrato de
// salida del probe CLI, que ya no existe.

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

/** Errores clasificados al llamar a SAP: auth, fault SOAP, negocio o transporte. */
export abstract class UpstreamError extends Error {
  abstract readonly kind: ErrorKind;
  readonly remediation?: string;
}

export class AuthRejectedError extends UpstreamError {
  readonly kind: ErrorKind = 'auth-rejected';

  constructor(
    message: string,
    readonly httpStatus: number,
  ) {
    super(message);
    this.name = 'AuthRejectedError';
  }
}

export class SoapFaultError extends UpstreamError {
  readonly kind: ErrorKind = 'soap-fault';

  constructor(
    readonly faultCode: string,
    readonly faultString: string,
  ) {
    super(`SOAP Fault ${faultCode}: ${faultString}`);
    this.name = 'SoapFaultError';
  }
}

export class BusinessError extends UpstreamError {
  readonly kind: ErrorKind = 'business-error';

  constructor(
    readonly code: string,
    readonly text: string,
  ) {
    super(`Business error ${code}: ${text}`);
    this.name = 'BusinessError';
  }
}

export class TransportError extends UpstreamError {
  constructor(
    message: string,
    readonly kind: ErrorKind,
    readonly remediation?: string,
  ) {
    super(message);
    this.name = 'TransportError';
  }
}

export class ParseError extends UpstreamError {
  readonly kind: ErrorKind = 'malformed-response';

  constructor(message: string) {
    super(message);
    this.name = 'ParseError';
  }
}

/** Status HTTP -> clasificación. null si no es 401/403. */
export function classifyHttpStatus(status: number): AuthRejectedError | null {
  if (status === 401 || status === 403) {
    return new AuthRejectedError(`Authentication rejected (HTTP ${status})`, status);
  }
  return null;
}

/**
 * La convención de éxito de negocio de SAP es asumida, no confirmada: código
 * vacío o todo-ceros ("000") es éxito. Cualquier otro es error, verbatim.
 */
export function classifyBusinessMessage(code: string, text: string): BusinessError | null {
  const normalized = code.trim();
  const isSuccess = normalized === '' || /^0+$/.test(normalized);
  if (isSuccess) return null;
  return new BusinessError(normalized, text);
}

export type Verdict = 'PASS' | 'FAIL';

/**
 * Un resultado vacío es PASS: la ausencia de filas es un dato, no una falla
 * del servicio. Sólo un error de negocio real produce FAIL.
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
 * fetch nativo envuelve toda falla de red como "TypeError: fetch failed": el
 * código útil está en error.cause (a veces anidado, o en cause.errors[] para
 * agregados happy-eyeballs). Hay que recorrer la cadena.
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

/** Convierte cualquier valor lanzado por un fetch() fallido en un TransportError clasificado. */
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
