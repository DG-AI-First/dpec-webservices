import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig, ConfigError, Secret } from '../src/config.js';

function baseLiveEnv(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    SAP_USER: 'wsuser',
    SAP_PASSWORD: 'wspass',
    ...overrides,
  };
}

describe('loadConfig — DPEC_ENV resolution', () => {
  it('defaults to qa when unset', () => {
    const config = loadConfig(baseLiveEnv());
    assert.equal(config.env, 'qa');
  });

  it('accepts exact "qa"', () => {
    const config = loadConfig(baseLiveEnv({ DPEC_ENV: 'qa' }));
    assert.equal(config.env, 'qa');
  });

  it('trims surrounding whitespace', () => {
    const config = loadConfig(baseLiveEnv({ DPEC_ENV: '  qa  ' }));
    assert.equal(config.env, 'qa');
  });

  it('rejects "prod" without a confirmation token', () => {
    assert.throws(
      () => loadConfig(baseLiveEnv({ DPEC_ENV: 'prod' })),
      ConfigError,
    );
  });

  it('rejects "prod" with the wrong confirmation token', () => {
    assert.throws(
      () =>
        loadConfig(
          baseLiveEnv({ DPEC_ENV: 'prod', DPEC_CONFIRM_PROD: 'yes' }),
        ),
      ConfigError,
    );
  });

  it('accepts "prod" with the exact confirmation token', () => {
    const config = loadConfig(
      baseLiveEnv({
        DPEC_ENV: 'prod',
        DPEC_CONFIRM_PROD: 'I_UNDERSTAND_THIS_HITS_PRODUCTION',
      }),
    );
    assert.equal(config.env, 'prod');
  });

  it('rejects "PROD" (case-sensitive, no case folding)', () => {
    assert.throws(
      () =>
        loadConfig(
          baseLiveEnv({
            DPEC_ENV: 'PROD',
            DPEC_CONFIRM_PROD: 'I_UNDERSTAND_THIS_HITS_PRODUCTION',
          }),
        ),
      ConfigError,
    );
  });

  it('rejects an unrecognized value like "produccion" — never falls through to qa', () => {
    assert.throws(
      () => loadConfig(baseLiveEnv({ DPEC_ENV: 'produccion' })),
      ConfigError,
    );
  });

  it('rejects an explicit empty string (distinct from unset)', () => {
    assert.throws(() => loadConfig(baseLiveEnv({ DPEC_ENV: '' })), ConfigError);
  });
});

describe('loadConfig — insecure TLS gate', () => {
  it('rejects DPEC_TLS_INSECURE under prod regardless of value', () => {
    assert.throws(
      () =>
        loadConfig(
          baseLiveEnv({
            DPEC_ENV: 'prod',
            DPEC_CONFIRM_PROD: 'I_UNDERSTAND_THIS_HITS_PRODUCTION',
            DPEC_TLS_INSECURE: 'YES_I_ACCEPT_INSECURE_TLS_ON_QA',
          }),
        ),
      ConfigError,
    );
  });

  it('rejects an arbitrary DPEC_TLS_INSECURE value even under qa', () => {
    assert.throws(
      () => loadConfig(baseLiveEnv({ DPEC_TLS_INSECURE: 'sure why not' })),
      ConfigError,
    );
  });

  it('accepts the exact insecure token under qa', () => {
    const config = loadConfig(
      baseLiveEnv({ DPEC_TLS_INSECURE: 'YES_I_ACCEPT_INSECURE_TLS_ON_QA' }),
    );
    assert.deepEqual(config.tls, { mode: 'insecure' });
  });

  it('defaults to tls mode "default" when unset', () => {
    const config = loadConfig(baseLiveEnv());
    assert.deepEqual(config.tls, { mode: 'default' });
  });
});

describe('loadConfig — credential presence', () => {
  it('throws ConfigError when credentials are missing in live mode', () => {
    assert.throws(() => loadConfig({}), ConfigError);
  });

  it('does not require credentials in dry-run mode', () => {
    const config = loadConfig({ DPEC_DRY_RUN: 'true' });
    assert.equal(config.dryRun, true);
    assert.equal(config.user, null);
    assert.equal(config.password, null);
  });
});

describe('loadConfig — SOAPAction is per-operation, not a config override', () => {
  // ZZCS_INFO_IC_WS necesita SOAPAction no vacío; los mc-style necesitan ''.
  // Por eso no hay AppConfig.soapAction / DPEC_SOAP_ACTION: la fuente única
  // es SoapOperation.soapAction (src/index.ts). Este test cuida que no vuelva.
  it('AppConfig carries no soapAction property, even when DPEC_SOAP_ACTION is set', () => {
    const config = loadConfig(baseLiveEnv({ DPEC_SOAP_ACTION: 'urn:whatever' }));
    assert.equal('soapAction' in config, false);
  });
});

describe('loadConfig — PORT (server-only, pero resuelto acá: única lectura de process.env del repo)', () => {
  it('defaults to 3000 when unset', () => {
    const config = loadConfig(baseLiveEnv());
    assert.equal(config.port, 3000);
  });

  it('accepts a valid custom port', () => {
    const config = loadConfig(baseLiveEnv({ PORT: '8080' }));
    assert.equal(config.port, 8080);
  });

  it('rejects a non-integer PORT', () => {
    assert.throws(() => loadConfig(baseLiveEnv({ PORT: 'abc' })), ConfigError);
  });

  it('rejects PORT out of the 1-65535 range', () => {
    assert.throws(() => loadConfig(baseLiveEnv({ PORT: '70000' })), ConfigError);
  });
});

describe('loadConfig — DPEC_SERVER_DEADLINE_MS', () => {
  // Crítico: ZZCS_INFO_IC_WS cuelga sin responder ante un DNI inexistente en
  // vez de devolver "no encontrado" (verificado 2026-09-01). El server debe
  // aplicar su propio deadline, más corto que DPEC_TIMEOUT_MS, y contestar
  // 504 en vez de sostener el socket.
  it('defaults to 15000ms, clearly shorter than the 30000ms DPEC_TIMEOUT_MS default', () => {
    const config = loadConfig(baseLiveEnv());
    assert.equal(config.serverDeadlineMs, 15_000);
    assert.ok(config.serverDeadlineMs < config.timeoutMs);
  });

  it('accepts a valid custom deadline shorter than the SOAP timeout', () => {
    const config = loadConfig(baseLiveEnv({ DPEC_SERVER_DEADLINE_MS: '5000', DPEC_TIMEOUT_MS: '30000' }));
    assert.equal(config.serverDeadlineMs, 5_000);
  });

  it('rejects a non-integer deadline', () => {
    assert.throws(() => loadConfig(baseLiveEnv({ DPEC_SERVER_DEADLINE_MS: 'abc' })), ConfigError);
  });

  it('rejects a deadline that is not clearly shorter than DPEC_TIMEOUT_MS', () => {
    assert.throws(
      () => loadConfig(baseLiveEnv({ DPEC_SERVER_DEADLINE_MS: '30000', DPEC_TIMEOUT_MS: '30000' })),
      ConfigError,
    );
  });
});

describe('loadConfig — Secret redaction', () => {
  it('never leaks the password through JSON.stringify or template coercion', () => {
    const config = loadConfig(baseLiveEnv({ SAP_PASSWORD: 'super-secret-value' }));
    const dumped = JSON.stringify(config);
    assert.ok(!dumped.includes('super-secret-value'));
    assert.ok(!dumped.includes('reveal'));
    assert.ok(config.password instanceof Secret);
    assert.equal(config.password?.reveal(), 'super-secret-value');
    assert.equal(String(config.password), '***REDACTED***');
  });
});
