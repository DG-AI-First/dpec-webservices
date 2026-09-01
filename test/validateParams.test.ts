// Tests unitarios de src/http/validateParams.ts: validación de los query
// params de /api/deuda y /api/facturas (dni vs partner/anlage, y max).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveDeudaInput, resolveFacturasInput, resolveMax } from '../src/http/validateParams.js';

function params(entries: Record<string, string>): URLSearchParams {
  return new URLSearchParams(entries);
}

describe('resolveDeudaInput', () => {
  it('ni dni ni partner -> 400 PARAMETROS_INVALIDOS', () => {
    const result = resolveDeudaInput(params({}));
    assert.ok('status' in result);
    assert.equal(result.status, 400);
    assert.equal(result.body.error.codigo, 'PARAMETROS_INVALIDOS');
  });

  it('dni y partner juntos -> 400 PARAMETROS_INVALIDOS (ambiguo)', () => {
    const result = resolveDeudaInput(params({ dni: '30955882', partner: '0030002708' }));
    assert.ok('status' in result);
    assert.equal(result.status, 400);
    assert.equal(result.body.error.codigo, 'PARAMETROS_INVALIDOS');
  });

  it('dni malformado -> 400 DNI_INVALIDO específicamente', () => {
    const result = resolveDeudaInput(params({ dni: 'abc' }));
    assert.ok('status' in result);
    assert.equal(result.status, 400);
    assert.equal(result.body.error.codigo, 'DNI_INVALIDO');
  });

  it('dni válido -> { kind: dni }', () => {
    const result = resolveDeudaInput(params({ dni: '30955882' }));
    assert.ok('ok' in result);
    assert.deepEqual(result.value, { kind: 'dni', dni: '30955882' });
  });

  it('partner vacío -> 400 PARAMETROS_INVALIDOS', () => {
    const result = resolveDeudaInput(params({ partner: '' }));
    assert.ok('status' in result);
    assert.equal(result.status, 400);
    assert.equal(result.body.error.codigo, 'PARAMETROS_INVALIDOS');
  });

  it('partner no numérico -> 400 PARAMETROS_INVALIDOS', () => {
    const result = resolveDeudaInput(params({ partner: '30abc' }));
    assert.ok('status' in result);
    assert.equal(result.status, 400);
    assert.equal(result.body.error.codigo, 'PARAMETROS_INVALIDOS');
  });

  it('partner válido conserva los ceros a la izquierda como string', () => {
    const result = resolveDeudaInput(params({ partner: '0010084414' }));
    assert.ok('ok' in result);
    assert.deepEqual(result.value, { kind: 'partner', partner: '0010084414' });
  });
});

describe('resolveFacturasInput', () => {
  it('ni dni ni partner -> 400 PARAMETROS_INVALIDOS', () => {
    const result = resolveFacturasInput(params({}));
    assert.ok('status' in result);
    assert.equal(result.status, 400);
    assert.equal(result.body.error.codigo, 'PARAMETROS_INVALIDOS');
  });

  it('dni y partner juntos -> 400 PARAMETROS_INVALIDOS (ambiguo)', () => {
    const result = resolveFacturasInput(params({ dni: '30955882', partner: '0010099044' }));
    assert.ok('status' in result);
    assert.equal(result.status, 400);
  });

  it('dni malformado -> 400 DNI_INVALIDO', () => {
    const result = resolveFacturasInput(params({ dni: '  ' }));
    assert.ok('status' in result);
    assert.equal(result.body.error.codigo, 'DNI_INVALIDO');
  });

  it('dni válido -> { kind: dni }', () => {
    const result = resolveFacturasInput(params({ dni: '30955882' }));
    assert.ok('ok' in result);
    assert.deepEqual(result.value, { kind: 'dni', dni: '30955882' });
  });

  it('partner sin anlage -> 400 PARAMETROS_INVALIDOS', () => {
    const result = resolveFacturasInput(params({ partner: '0010099044' }));
    assert.ok('status' in result);
    assert.equal(result.status, 400);
    assert.equal(result.body.error.codigo, 'PARAMETROS_INVALIDOS');
  });

  it('anlage sin partner -> 400 PARAMETROS_INVALIDOS', () => {
    const result = resolveFacturasInput(params({ anlage: '0010099044' }));
    assert.ok('status' in result);
    assert.equal(result.status, 400);
    assert.equal(result.body.error.codigo, 'PARAMETROS_INVALIDOS');
  });

  it('partner/anlage no numéricos -> 400 PARAMETROS_INVALIDOS', () => {
    const result = resolveFacturasInput(params({ partner: 'x', anlage: 'y' }));
    assert.ok('status' in result);
    assert.equal(result.status, 400);
  });

  it('partner+anlage válidos conservan ceros a la izquierda', () => {
    const result = resolveFacturasInput(params({ partner: '0010099044', anlage: '0010099044' }));
    assert.ok('ok' in result);
    assert.deepEqual(result.value, { kind: 'partner', partner: '0010099044', anlage: '0010099044' });
  });
});

describe('resolveMax', () => {
  it('ausente -> usa el fallback', () => {
    const result = resolveMax(null, '10');
    assert.ok('ok' in result);
    assert.equal(result.value, '10');
  });

  it('vacío -> usa el fallback', () => {
    const result = resolveMax('  ', '10');
    assert.ok('ok' in result);
    assert.equal(result.value, '10');
  });

  it('entero positivo -> se acepta tal cual (ej. ICantfact=1 del PDF de DPEC)', () => {
    const result = resolveMax('1', '10');
    assert.ok('ok' in result);
    assert.equal(result.value, '1');
  });

  it('"0" -> 400 PARAMETROS_INVALIDOS', () => {
    const result = resolveMax('0', '10');
    assert.ok('status' in result);
    assert.equal(result.status, 400);
    assert.equal(result.body.error.codigo, 'PARAMETROS_INVALIDOS');
  });

  it('negativo -> 400 PARAMETROS_INVALIDOS', () => {
    const result = resolveMax('-1', '10');
    assert.ok('status' in result);
    assert.equal(result.status, 400);
  });

  it('no numérico -> 400 PARAMETROS_INVALIDOS', () => {
    const result = resolveMax('abc', '10');
    assert.ok('status' in result);
    assert.equal(result.status, 400);
  });

  it('decimal -> 400 PARAMETROS_INVALIDOS', () => {
    const result = resolveMax('3.5', '10');
    assert.ok('status' in result);
    assert.equal(result.status, 400);
  });
});
