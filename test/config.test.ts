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
