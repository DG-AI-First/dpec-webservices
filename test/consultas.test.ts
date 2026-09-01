// Tests unitarios de src/flows/consultas.ts.
// Fakes planos como OperationCaller, cero mocking: la capacidad de red se
// inyecta, así que estos tests corren sin node:http ni fetch.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { TransportError, BusinessError } from '../src/errors.js';
import { zzcsInfoIcWs, type ZzcsInfoIcWsOutput, type OuInfoIcWsRow } from '../src/services/zzcsInfoIcWs.js';
import { zFicaDeudaIcUnif, type ZFicaDeudaIcUnifOutput } from '../src/services/zFicaDeudaIcUnif.js';
import { zWsSap002, type ZWsSap002Output } from '../src/services/zWsSap002.js';
import type { SoapOperation } from '../src/soap/types.js';
import {
  consultarDeuda,
  consultarFacturas,
  consultarCliente,
  type OperationCaller,
} from '../src/flows/consultas.js';

// Fila de ZZCS_INFO_IC_WS -- overrides opcionales para los campos que le
// importan a /api/cliente (status/nombre/factAdeudadas/deuda), el resto
// queda vacío porque a deuda/facturas sólo les importa partner/anlage.
function row(partner: string, anlage: string, overrides: Partial<OuInfoIcWsRow> = {}): OuInfoIcWsRow {
  return {
    partner, type: '', idnumberDni: '', idnumberCuit: '', idnumberCuil: '', idnumberCi: '',
    idnumberOtr: '', name1Text: '', streetIc: '', houseNum1Ic: '', floorIc: '', roomnumberIc: '',
    city1Ic: '', postCode1Ic: '', anlage, tariftyp: '', equnr: '', gernr: '', ableinh: '',
    streetIn: '', houseNum1In: '', floorIn: '', roomnumberIn: '', city1In: '', postCode1In: '',
    einzdat: '', auszdat: '', status: '', factAdeudadas: '', deuda: '', discStatus: '',
    smtpAddr: '', telNumber: '', mobNumber: '', eqfnr: '', lockreason: '', descripcion: '',
    ...overrides,
  };
}

/** Caller fake dirigido por operationName, con respuesta u error por servicio. */
function fakeCaller(
  responses: Partial<
    Record<string, { readonly output?: unknown; readonly error?: Error }>
  >,
): OperationCaller {
  return (async (op: SoapOperation<unknown, unknown>) => {
    const entry = responses[op.operationName];
    if (!entry) throw new Error(`fakeCaller: no response configured for ${op.operationName}`);
    if (entry.error) throw entry.error;
    return entry.output;
  }) as OperationCaller;
}

const ZZCS_OK: ZzcsInfoIcWsOutput = { ouResultado: '0', rows: [row('0030002708', '0060002445')] };
const ZZCS_NO_ROWS: ZzcsInfoIcWsOutput = { ouResultado: '0', rows: [] };
const ZZCS_RECHAZADO: ZzcsInfoIcWsOutput = { ouResultado: '99', rows: [] };

describe('consultarDeuda', () => {
  it('resuelve PARTNER por ZZCS y devuelve los documentos de FICA (chain verificada en vivo 2026-09-01)', async () => {
    const ficaOutput: ZFicaDeudaIcUnifOutput = {
      poDocumentos: [
        { budat: '20260101', faedn: '20260201', xblnr: '1', ltext: 'Factura', betrw: '26.58', totalAmnt: '26.58', codBarraVisual: '' },
      ],
      poMensaje: [],
    };
    const call = fakeCaller({
      [zzcsInfoIcWs.operationName]: { output: ZZCS_OK },
      [zFicaDeudaIcUnif.operationName]: { output: ficaOutput },
    });

    const outcome = await consultarDeuda(call, { kind: 'dni', dni: '30955882' });
    assert.equal(outcome.kind, 'ok');
    assert.ok(outcome.kind === 'ok');
    assert.equal(outcome.partner, '0030002708');
    assert.equal(outcome.documentos.length, 1);
    assert.equal(outcome.documentos[0]?.betrw, '26.58');
  });

  it('DNI sin filas (OU_RESULTADO="0", 0 rows) -> no-encontrado, sin llamar a FICA', async () => {
    let ficaCalled = false;
    const call: OperationCaller = (async (op: SoapOperation<unknown, unknown>) => {
      if (op.operationName === zFicaDeudaIcUnif.operationName) ficaCalled = true;
      return ZZCS_NO_ROWS;
    }) as OperationCaller;

    const outcome = await consultarDeuda(call, { kind: 'dni', dni: '99999999' });
    assert.equal(outcome.kind, 'no-encontrado');
    assert.equal(ficaCalled, false, 'no debe encadenar el segundo call si no hay PARTNER');
  });

  it('ZZCS con OU_RESULTADO no-"0" (ej. "99") -> zzcs-rechazado, verbatim', async () => {
    const call = fakeCaller({ [zzcsInfoIcWs.operationName]: { output: ZZCS_RECHAZADO } });

    const outcome = await consultarDeuda(call, { kind: 'dni', dni: '' });
    assert.equal(outcome.kind, 'zzcs-rechazado');
    assert.ok(outcome.kind === 'zzcs-rechazado');
    assert.equal(outcome.ouResultado, '99');
  });

  it('FICA devuelve error de negocio -> error-negocio con codigo/mensaje verbatim', async () => {
    const ficaOutput: ZFicaDeudaIcUnifOutput = {
      poDocumentos: [],
      poMensaje: [{ codigo: 'E01', descripcion: 'Partner inexistente' }],
    };
    const call = fakeCaller({
      [zzcsInfoIcWs.operationName]: { output: ZZCS_OK },
      [zFicaDeudaIcUnif.operationName]: { output: ficaOutput },
    });

    const outcome = await consultarDeuda(call, { kind: 'dni', dni: '30955882' });
    assert.equal(outcome.kind, 'error-negocio');
    assert.ok(outcome.kind === 'error-negocio');
    assert.equal(outcome.codigo, 'E01');
    assert.equal(outcome.mensaje, 'Partner inexistente');
  });

  it('timeout/falla de transporte en ZZCS -> outcome error, con el UpstreamError original', async () => {
    const transportErr = new TransportError('Transport failure: AbortError', 'timeout');
    const call = fakeCaller({ [zzcsInfoIcWs.operationName]: { error: transportErr } });

    const outcome = await consultarDeuda(call, { kind: 'dni', dni: '30955882' });
    assert.equal(outcome.kind, 'error');
    assert.ok(outcome.kind === 'error');
    assert.equal(outcome.error, transportErr);
    assert.equal(outcome.error.kind, 'timeout');
  });

  it('falla de transporte en el segundo call (FICA) -> outcome error también', async () => {
    const transportErr = new TransportError('boom', 'network');
    const call = fakeCaller({
      [zzcsInfoIcWs.operationName]: { output: ZZCS_OK },
      [zFicaDeudaIcUnif.operationName]: { error: transportErr },
    });

    const outcome = await consultarDeuda(call, { kind: 'dni', dni: '30955882' });
    assert.equal(outcome.kind, 'error');
    assert.ok(outcome.kind === 'error');
    assert.equal(outcome.error, transportErr);
  });

  it('un error que NO es UpstreamError se propaga (rejects), no se traga como outcome', async () => {
    const bug = new Error('bug de programación, no de negocio');
    const call = fakeCaller({ [zzcsInfoIcWs.operationName]: { error: bug } });

    await assert.rejects(() => consultarDeuda(call, { kind: 'dni', dni: '30955882' }), bug);
  });

  it('input {kind: partner} salta ZZCS por completo y usa el partner directo', async () => {
    let zzcsCalled = false;
    const ficaOutput: ZFicaDeudaIcUnifOutput = { poDocumentos: [], poMensaje: [] };
    const call: OperationCaller = (async (op: SoapOperation<unknown, unknown>) => {
      if (op.operationName === zzcsInfoIcWs.operationName) zzcsCalled = true;
      return ficaOutput;
    }) as OperationCaller;

    const outcome = await consultarDeuda(call, { kind: 'partner', partner: '0010084414' });
    assert.equal(zzcsCalled, false, 'no debe resolver DNI si ya viene el partner');
    assert.equal(outcome.kind, 'ok');
    assert.ok(outcome.kind === 'ok');
    assert.equal(outcome.partner, '0010084414', 'echoea el partner recibido, no uno inventado');
  });

  it('piNumMax por defecto es "10", pero se puede pisar (ej. PDF de DPEC usa 1)', async () => {
    let capturedInput: unknown;
    const call: OperationCaller = (async (op: SoapOperation<unknown, unknown>, input: unknown) => {
      if (op.operationName === zFicaDeudaIcUnif.operationName) {
        capturedInput = input;
        return { poDocumentos: [], poMensaje: [] } satisfies ZFicaDeudaIcUnifOutput;
      }
      return ZZCS_OK;
    }) as OperationCaller;

    await consultarDeuda(call, { kind: 'dni', dni: '30955882' }, '1');
    assert.deepEqual(capturedInput, { piIc: '0030002708', piCc: '', piI: '', piFechaHasta: '', piNumMax: '1' });
  });
});

describe('consultarFacturas', () => {
  it('resuelve PARTNER/ANLAGE por ZZCS y pasa ambos a ZWsSap002', async () => {
    let capturedInput: unknown;
    const wsOutput: ZWsSap002Output = {
      eMsgnro: '000',
      eMsgtxt: '',
      tFact: [{ opbel: '1', exbel: 'e1', faedn: '20260201', totalAmnt: '10.00' }],
    };
    const call: OperationCaller = (async (op: SoapOperation<unknown, unknown>, input: unknown) => {
      if (op.operationName === zWsSap002.operationName) {
        capturedInput = input;
        return wsOutput;
      }
      return ZZCS_OK;
    }) as OperationCaller;

    const outcome = await consultarFacturas(call, { kind: 'dni', dni: '30955882' });
    assert.equal(outcome.kind, 'ok');
    assert.ok(outcome.kind === 'ok');
    assert.equal(outcome.partner, '0030002708');
    assert.equal(outcome.facturas.length, 1);
    assert.deepEqual(capturedInput, { iPartner: '0030002708', iAnlage: '0060002445', iCantfact: '10' });
  });

  it('DNI sin filas -> no-encontrado, sin llamar a ZWsSap002', async () => {
    let wsCalled = false;
    const call: OperationCaller = (async (op: SoapOperation<unknown, unknown>) => {
      if (op.operationName === zWsSap002.operationName) wsCalled = true;
      return ZZCS_NO_ROWS;
    }) as OperationCaller;

    const outcome = await consultarFacturas(call, { kind: 'dni', dni: '99999999' });
    assert.equal(outcome.kind, 'no-encontrado');
    assert.equal(wsCalled, false);
  });

  it('ZZCS rechazado (OU_RESULTADO="99") -> zzcs-rechazado', async () => {
    const call = fakeCaller({ [zzcsInfoIcWs.operationName]: { output: ZZCS_RECHAZADO } });

    const outcome = await consultarFacturas(call, { kind: 'dni', dni: '' });
    assert.equal(outcome.kind, 'zzcs-rechazado');
    assert.ok(outcome.kind === 'zzcs-rechazado');
    assert.equal(outcome.ouResultado, '99');
  });

  it('E9011 (cliente desconectado): ZWsSap002 responde error de negocio -> error-negocio verbatim, no un error genérico', async () => {
    const wsOutput: ZWsSap002Output = { eMsgnro: 'E9011', eMsgtxt: 'Instalación desconectada', tFact: [] };
    const call = fakeCaller({
      [zzcsInfoIcWs.operationName]: { output: ZZCS_OK },
      [zWsSap002.operationName]: { output: wsOutput },
    });

    const outcome = await consultarFacturas(call, { kind: 'dni', dni: '30955882' });
    assert.equal(outcome.kind, 'error-negocio');
    assert.ok(outcome.kind === 'error-negocio');
    assert.equal(outcome.codigo, 'E9011');
    assert.equal(outcome.mensaje, 'Instalación desconectada');
  });

  it('falla de transporte en el segundo call -> outcome error', async () => {
    const transportErr = new BusinessError('E01', 'no debería pasar por acá, pero se propaga igual');
    const call = fakeCaller({
      [zzcsInfoIcWs.operationName]: { output: ZZCS_OK },
      [zWsSap002.operationName]: { error: transportErr },
    });

    const outcome = await consultarFacturas(call, { kind: 'dni', dni: '30955882' });
    assert.equal(outcome.kind, 'error');
    assert.ok(outcome.kind === 'error');
    assert.equal(outcome.error, transportErr);
  });

  it('input {kind: partner} salta ZZCS y pasa partner/anlage directos a ZWsSap002', async () => {
    let zzcsCalled = false;
    let capturedInput: unknown;
    const wsOutput: ZWsSap002Output = { eMsgnro: '000', eMsgtxt: '', tFact: [] };
    const call: OperationCaller = (async (op: SoapOperation<unknown, unknown>, input: unknown) => {
      if (op.operationName === zzcsInfoIcWs.operationName) zzcsCalled = true;
      if (op.operationName === zWsSap002.operationName) capturedInput = input;
      return wsOutput;
    }) as OperationCaller;

    const outcome = await consultarFacturas(call, { kind: 'partner', partner: '0010099044', anlage: '0010099044' });
    assert.equal(zzcsCalled, false, 'no debe resolver DNI si ya vienen partner y anlage');
    assert.equal(outcome.kind, 'ok');
    assert.ok(outcome.kind === 'ok');
    assert.equal(outcome.partner, '0010099044', 'echoea el partner recibido');
    assert.deepEqual(capturedInput, { iPartner: '0010099044', iAnlage: '0010099044', iCantfact: '10' });
  });

  it('iCantfact por defecto es "10", pero se puede pisar (ej. PDF de DPEC usa 1)', async () => {
    let capturedInput: unknown;
    const call: OperationCaller = (async (op: SoapOperation<unknown, unknown>, input: unknown) => {
      if (op.operationName === zWsSap002.operationName) {
        capturedInput = input;
        return { eMsgnro: '000', eMsgtxt: '', tFact: [] } satisfies ZWsSap002Output;
      }
      return ZZCS_OK;
    }) as OperationCaller;

    await consultarFacturas(call, { kind: 'dni', dni: '30955882' }, '1');
    assert.deepEqual(capturedInput, { iPartner: '0030002708', iAnlage: '0060002445', iCantfact: '1' });
  });
});

describe('consultarCliente', () => {
  it('devuelve el subconjunto curado: partner, anlage, status, nombre, factAdeudadas, deuda', async () => {
    const output: ZzcsInfoIcWsOutput = {
      ouResultado: '0',
      rows: [
        row('0030002708', '0060002445', {
          status: 'ACTIVO',
          name1Text: 'Juan Perez',
          factAdeudadas: '1',
          deuda: '26.58',
          streetIc: 'Calle Falsa 123', // dato sensible: no debe aparecer en el resultado
          smtpAddr: 'juan@example.com', // dato sensible: no debe aparecer en el resultado
        }),
      ],
    };
    const call = fakeCaller({ [zzcsInfoIcWs.operationName]: { output } });

    const outcome = await consultarCliente(call, '30955882');
    assert.equal(outcome.kind, 'ok');
    assert.ok(outcome.kind === 'ok');
    assert.deepEqual(outcome.cliente, {
      partner: '0030002708',
      anlage: '0060002445',
      status: 'ACTIVO',
      nombre: 'Juan Perez',
      factAdeudadas: '1',
      deuda: '26.58',
    });
  });

  it('DNI sin filas -> no-encontrado', async () => {
    const call = fakeCaller({ [zzcsInfoIcWs.operationName]: { output: ZZCS_NO_ROWS } });

    const outcome = await consultarCliente(call, '99999999');
    assert.equal(outcome.kind, 'no-encontrado');
  });

  it('OU_RESULTADO rechazado -> zzcs-rechazado, verbatim', async () => {
    const call = fakeCaller({ [zzcsInfoIcWs.operationName]: { output: ZZCS_RECHAZADO } });

    const outcome = await consultarCliente(call, '1');
    assert.equal(outcome.kind, 'zzcs-rechazado');
    assert.ok(outcome.kind === 'zzcs-rechazado');
    assert.equal(outcome.ouResultado, '99');
  });

  it('falla de transporte -> outcome error', async () => {
    const transportErr = new TransportError('boom', 'timeout');
    const call = fakeCaller({ [zzcsInfoIcWs.operationName]: { error: transportErr } });

    const outcome = await consultarCliente(call, '30955882');
    assert.equal(outcome.kind, 'error');
    assert.ok(outcome.kind === 'error');
    assert.equal(outcome.error, transportErr);
  });
});
