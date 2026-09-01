// Tests unitarios de src/flows/consultaPorDni.ts.
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
  consultarDeudaPorDni,
  consultarFacturasPorDni,
  type OperationCaller,
} from '../src/flows/consultaPorDni.js';

// Fila mínima válida de ZZCS_INFO_IC_WS -- sólo partner/anlage importan al flow.
function row(partner: string, anlage: string): OuInfoIcWsRow {
  return {
    partner, type: '', idnumberDni: '', idnumberCuit: '', idnumberCuil: '', idnumberCi: '',
    idnumberOtr: '', name1Text: '', streetIc: '', houseNum1Ic: '', floorIc: '', roomnumberIc: '',
    city1Ic: '', postCode1Ic: '', anlage, tariftyp: '', equnr: '', gernr: '', ableinh: '',
    streetIn: '', houseNum1In: '', floorIn: '', roomnumberIn: '', city1In: '', postCode1In: '',
    einzdat: '', auszdat: '', status: '', factAdeudadas: '', deuda: '', discStatus: '',
    smtpAddr: '', telNumber: '', mobNumber: '', eqfnr: '', lockreason: '', descripcion: '',
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

describe('consultarDeudaPorDni', () => {
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

    const outcome = await consultarDeudaPorDni(call, '30955882');
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

    const outcome = await consultarDeudaPorDni(call, '99999999');
    assert.equal(outcome.kind, 'no-encontrado');
    assert.equal(ficaCalled, false, 'no debe encadenar el segundo call si no hay PARTNER');
  });

  it('ZZCS con OU_RESULTADO no-"0" (ej. "99") -> zzcs-rechazado, verbatim', async () => {
    const call = fakeCaller({ [zzcsInfoIcWs.operationName]: { output: ZZCS_RECHAZADO } });

    const outcome = await consultarDeudaPorDni(call, '');
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

    const outcome = await consultarDeudaPorDni(call, '30955882');
    assert.equal(outcome.kind, 'error-negocio');
    assert.ok(outcome.kind === 'error-negocio');
    assert.equal(outcome.codigo, 'E01');
    assert.equal(outcome.mensaje, 'Partner inexistente');
  });

  it('timeout/falla de transporte en ZZCS -> outcome error, con el ProbeError original', async () => {
    const transportErr = new TransportError('Transport failure: AbortError', 'timeout');
    const call = fakeCaller({ [zzcsInfoIcWs.operationName]: { error: transportErr } });

    const outcome = await consultarDeudaPorDni(call, '30955882');
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

    const outcome = await consultarDeudaPorDni(call, '30955882');
    assert.equal(outcome.kind, 'error');
    assert.ok(outcome.kind === 'error');
    assert.equal(outcome.error, transportErr);
  });

  it('un error que NO es ProbeError se propaga (rejects), no se traga como outcome', async () => {
    const bug = new Error('bug de programación, no de negocio');
    const call = fakeCaller({ [zzcsInfoIcWs.operationName]: { error: bug } });

    await assert.rejects(() => consultarDeudaPorDni(call, '30955882'), bug);
  });
});

describe('consultarFacturasPorDni', () => {
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

    const outcome = await consultarFacturasPorDni(call, '30955882');
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

    const outcome = await consultarFacturasPorDni(call, '99999999');
    assert.equal(outcome.kind, 'no-encontrado');
    assert.equal(wsCalled, false);
  });

  it('ZZCS rechazado (OU_RESULTADO="99") -> zzcs-rechazado', async () => {
    const call = fakeCaller({ [zzcsInfoIcWs.operationName]: { output: ZZCS_RECHAZADO } });

    const outcome = await consultarFacturasPorDni(call, '');
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

    const outcome = await consultarFacturasPorDni(call, '30955882');
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

    const outcome = await consultarFacturasPorDni(call, '30955882');
    assert.equal(outcome.kind, 'error');
    assert.ok(outcome.kind === 'error');
    assert.equal(outcome.error, transportErr);
  });
});
