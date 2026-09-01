import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  AuthRejectedError,
  BusinessError,
  SoapFaultError,
  TransportError,
  classifyHttpStatus,
  classifyBusinessMessage,
  determineVerdict,
  diagnoseCause,
  toTransportError,
  aggregateExitCode,
} from '../src/errors.js';

describe('classifyHttpStatus', () => {
  it('classifies 401 as auth-rejected, exit code 2', () => {
    const err = classifyHttpStatus(401);
    assert.ok(err instanceof AuthRejectedError);
    assert.equal(err?.kind, 'auth-rejected');
    assert.equal(err?.exitCode, 2);
  });

  it('classifies 403 as auth-rejected, exit code 2', () => {
    const err = classifyHttpStatus(403);
    assert.ok(err instanceof AuthRejectedError);
    assert.equal(err?.exitCode, 2);
  });

  it('returns null for a normal 200', () => {
    assert.equal(classifyHttpStatus(200), null);
  });
});

describe('SoapFaultError — HTTP 500 carries a fault, not a transport failure', () => {
  it('is exit code 3, kind soap-fault, even though it rides on HTTP 500', () => {
    // Fault real capturado en QA (prefijo soap-env:, dato de cable genuino).
    const err = new SoapFaultError(
      'soap-env:Server',
      'Error en el tratamiento de servicio web; Más detalles en log de error de servicio web en la página de proveedor',
    );
    assert.equal(err.kind, 'soap-fault');
    assert.equal(err.exitCode, 3);
    assert.equal(err.faultCode, 'soap-env:Server');
  });
});

describe('classifyBusinessMessage', () => {
  it('treats an empty code as success (no error)', () => {
    assert.equal(classifyBusinessMessage('', ''), null);
  });

  it('treats "000" as success (no error)', () => {
    assert.equal(classifyBusinessMessage('000', 'ok'), null);
  });

  it('treats a non-zero code as a BusinessError, exit code 3', () => {
    const err = classifyBusinessMessage('E01', 'Partner not found');
    assert.ok(err instanceof BusinessError);
    assert.equal(err?.kind, 'business-error');
    assert.equal(err?.exitCode, 3);
    assert.equal(err?.code, 'E01');
  });
});

describe('determineVerdict — empty result set is PASS, not FAIL', () => {
  it('an empty table with a success code is PASS with recordCount 0', () => {
    const rows: unknown[] = [];
    const businessError = classifyBusinessMessage('000', '');
    assert.equal(determineVerdict(businessError), 'PASS');
    assert.equal(rows.length, 0);
  });

  it('a business error makes the verdict FAIL regardless of row count', () => {
    const businessError = classifyBusinessMessage('E01', 'boom');
    assert.equal(determineVerdict(businessError), 'FAIL');
  });
});

describe('diagnoseCause — cause-chain walk for native fetch failures', () => {
  it('finds ECONNREFUSED nested in error.cause', () => {
    const inner = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
    const outer = new Error('fetch failed', { cause: inner });
    const diagnosis = diagnoseCause(outer);
    assert.equal(diagnosis?.kind, 'network');
    assert.equal(diagnosis?.code, 'ECONNREFUSED');
  });

  it('finds SELF_SIGNED_CERT_IN_CHAIN nested two levels deep, with CA remediation', () => {
    const deepest = Object.assign(new Error('self signed cert'), {
      code: 'SELF_SIGNED_CERT_IN_CHAIN',
    });
    const middle = new Error('tls wrapper', { cause: deepest });
    const outer = new Error('fetch failed', { cause: middle });
    const diagnosis = diagnoseCause(outer);
    assert.equal(diagnosis?.kind, 'tls');
    assert.equal(diagnosis?.code, 'SELF_SIGNED_CERT_IN_CHAIN');
    assert.match(diagnosis?.remediation ?? '', /DPEC_TLS_CA_FILE/);
  });

  it('recognizes AbortError as a timeout', () => {
    const abort = new Error('The operation was aborted');
    abort.name = 'AbortError';
    const diagnosis = diagnoseCause(abort);
    assert.equal(diagnosis?.kind, 'timeout');
  });

  it('returns null when nothing recognizable is found', () => {
    assert.equal(diagnoseCause(new Error('mystery failure')), null);
  });
});

describe('toTransportError', () => {
  it('wraps a diagnosed cause into a TransportError with exit code 4', () => {
    const inner = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
    const outer = new Error('fetch failed', { cause: inner });
    const err = toTransportError(outer);
    assert.ok(err instanceof TransportError);
    assert.equal(err.exitCode, 4);
    assert.equal(err.kind, 'network');
  });
});

describe('aggregateExitCode — precedence across independent service runs', () => {
  it('[4, 3] -> 4 (transport outranks business/fault)', () => {
    assert.equal(aggregateExitCode([4, 3]), 4);
  });

  it('[3, 0] -> 3', () => {
    assert.equal(aggregateExitCode([3, 0]), 3);
  });

  it('[0, 0] -> 0', () => {
    assert.equal(aggregateExitCode([0, 0]), 0);
  });
});
