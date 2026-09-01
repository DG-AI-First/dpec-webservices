// Tests unitarios de src/http/mapOutcome.ts: tabla de status HTTP para los
// outcomes de flows/consultaPorDni.ts y para los UpstreamError que puede lanzar
// la capacidad de llamada SOAP en vivo. El exit-code mapping de errors.ts
// (0/2/3/4, probe CLI) no se toca -- ésta es la tabla equivalente para HTTP.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  AuthRejectedError,
  BusinessError,
  SoapFaultError,
  TransportError,
} from '../src/errors.js';
import type { DeudaOutcome, FacturasOutcome } from '../src/flows/consultaPorDni.js';
import { mapOutcomeToHttpError, validateDni } from '../src/http/mapOutcome.js';

describe('validateDni', () => {
  it('rechaza dni ausente (null) con 400', () => {
    const result = validateDni(null);
    assert.equal('status' in result, true);
    assert.ok('status' in result);
    assert.equal(result.status, 400);
    assert.equal(result.body.error.codigo, 'DNI_INVALIDO');
  });

  it('rechaza dni vacío/blanco con 400', () => {
    const result = validateDni('   ');
    assert.ok('status' in result);
    assert.equal(result.status, 400);
  });

  it('rechaza dni no numérico (malformado) con 400', () => {
    const result = validateDni('30abc955');
    assert.ok('status' in result);
    assert.equal(result.status, 400);
  });

  it('acepta un dni numérico y lo devuelve trimeado', () => {
    const result = validateDni('  30955882  ');
    assert.equal('ok' in result, true);
    assert.ok('ok' in result);
    assert.equal(result.dni, '30955882');
  });
});

describe('mapOutcomeToHttpError — outcomes propios del flow', () => {
  it('no-encontrado -> 404 (SAP respondió, 0 filas)', () => {
    const outcome: DeudaOutcome = { kind: 'no-encontrado' };
    const mapped = mapOutcomeToHttpError(outcome);
    assert.equal(mapped.status, 404);
  });

  it('zzcs-rechazado -> 502, código de OU_RESULTADO verbatim en el body', () => {
    const outcome: DeudaOutcome = { kind: 'zzcs-rechazado', ouResultado: '99' };
    const mapped = mapOutcomeToHttpError(outcome);
    assert.equal(mapped.status, 502);
    assert.equal(mapped.body.error.codigo, '99');
  });

  it('error-negocio -> 409, codigo/mensaje verbatim (ej. E9011 desconectado)', () => {
    const outcome: FacturasOutcome = { kind: 'error-negocio', codigo: 'E9011', mensaje: 'Instalación desconectada' };
    const mapped = mapOutcomeToHttpError(outcome);
    assert.equal(mapped.status, 409);
    assert.equal(mapped.body.error.codigo, 'E9011');
    assert.equal(mapped.body.error.mensaje, 'Instalación desconectada');
  });
});

describe('mapOutcomeToHttpError — outcome "error" (UpstreamError de la capa de transporte)', () => {
  it('timeout -> 504 (SAP colgado, deadline propio del server)', () => {
    const outcome: DeudaOutcome = { kind: 'error', error: new TransportError('boom', 'timeout') };
    const mapped = mapOutcomeToHttpError(outcome);
    assert.equal(mapped.status, 504);
  });

  it('auth-rejected -> 502, nunca expone detalle de auth upstream', () => {
    const outcome: DeudaOutcome = { kind: 'error', error: new AuthRejectedError('Authentication rejected (HTTP 401)', 401) };
    const mapped = mapOutcomeToHttpError(outcome);
    assert.equal(mapped.status, 502);
    assert.ok(!JSON.stringify(mapped.body).includes('401'), 'no debe filtrar el detalle de auth upstream');
    assert.ok(!/basic|authorization/i.test(JSON.stringify(mapped.body)), 'no debe filtrar detalle de credenciales');
  });

  it('soap-fault -> 502', () => {
    const outcome: DeudaOutcome = { kind: 'error', error: new SoapFaultError('soap-env:Server', 'stub') };
    const mapped = mapOutcomeToHttpError(outcome);
    assert.equal(mapped.status, 502);
  });

  it('network/dns/tls/http-error (transporte genérico) -> 502', () => {
    const outcome: DeudaOutcome = { kind: 'error', error: new TransportError('ECONNREFUSED', 'network') };
    const mapped = mapOutcomeToHttpError(outcome);
    assert.equal(mapped.status, 502);
  });

  it('business-error inesperado en la excepción (defensivo) -> 409, verbatim', () => {
    const outcome: DeudaOutcome = { kind: 'error', error: new BusinessError('ZFICA017', 'Instalación distinta') };
    const mapped = mapOutcomeToHttpError(outcome);
    assert.equal(mapped.status, 409);
    assert.equal(mapped.body.error.codigo, 'ZFICA017');
    assert.equal(mapped.body.error.mensaje, 'Instalación distinta');
  });
});
