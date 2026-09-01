// Fixtures reales de QA (HTTP 200): 3 del 2026-08-28, ZZCS_INFO_IC_WS del
// 2026-09-01. Único archivo que testea el comportamiento real de SAP, no
// nuestras suposiciones.
//
// Privacidad: dígitos permutados (permutación fija 1-9, 0 fijo, para no
// destruir ceros a la izquierda). Detalle: docs/hallazgos-tecnicos.md#privacidad-de-los-fixtures

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseXml, unwrapBody, findFault } from '../src/soap/parser.js';
import * as fica from '../src/services/zFicaDeudaIcUnif.js';
import * as ws002 from '../src/services/zWsSap002.js';
import * as zzcs from '../src/services/zzcsInfoIcWs.js';

function load(name: string): string {
  return readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
}

describe('ZFicaDeudaIcUnif — real QA response with one document', () => {
  const raw = load('zFicaDeudaIcUnif.one-document.response.xml');

  it('carries no SOAP fault and unwraps by the expected element name', () => {
    const node = parseXml(raw);
    assert.equal(findFault(node), null);
    assert.equal(unwrapBody(node, 'ZFicaDeudaIcUnif').responseElementMismatch, undefined);
  });

  it('parses one document with every field populated', () => {
    const out = fica.parseResult(unwrapBody(parseXml(raw), 'ZFicaDeudaIcUnif').node);
    assert.equal(out.poDocumentos.length, 1);
    assert.deepEqual(out.poDocumentos[0], {
      budat: '2025-07-15',
      faedn: '2025-09-08',
      xblnr: '0054B77137504A',
      ltext: 'Factura ISU',
      betrw: '31090.51',
      totalAmnt: '31090.51',
      codBarraVisual: '136007601346087206034000000014060242',
    });
  });

  it('the 36-digit barcode survives intact — it must never become a number', () => {
    const out = fica.parseResult(unwrapBody(parseXml(raw), 'ZFicaDeudaIcUnif').node);
    const barcode = out.poDocumentos[0]?.codBarraVisual ?? '';
    assert.equal(typeof barcode, 'string');
    assert.equal(barcode.length, 36);
  });

  it('summarizes as PASS with recordCount 1 and code 000', () => {
    const outcome = fica.summarize(fica.parseResult(unwrapBody(parseXml(raw), 'ZFicaDeudaIcUnif').node));
    assert.equal(outcome.verdict, 'PASS');
    assert.equal(outcome.recordCount, 1);
    assert.deepEqual(outcome.businessMessage, [
      { code: '000', text: 'Estado de deuda devuelto correctamente' },
    ]);
  });
});

describe('ZWsSap002 — real QA response with ten invoices', () => {
  const raw = load('zWsSap002.ten-invoices.response.xml');
  const parse = () => ws002.parseResult(unwrapBody(parseXml(raw), 'ZWsSap002').node);

  it('parses all ten rows out of the item-wrapped TFact table', () => {
    assert.equal(parse().tFact.length, 10);
  });

  it('empty EMsgnro/EMsgtxt on success — the message pair is absent, not "000"', () => {
    const out = parse();
    assert.equal(out.eMsgnro, '');
    assert.equal(out.eMsgtxt, '');
  });

  it('Opbel keeps its leading zeros as a 12-character string', () => {
    const opbel = parse().tFact[0]?.opbel ?? '';
    assert.equal(typeof opbel, 'string');
    assert.equal(opbel.length, 12);
    assert.match(opbel, /^0/);
  });

  it('a negative TotalAmnt (a credit) survives sign and precision', () => {
    const amounts = parse().tFact.map((r) => r.totalAmnt);
    assert.ok(amounts.includes('-5517.9'), `no negative amount found in ${amounts.join(', ')}`);
  });

  it('summarizes as PASS with recordCount 10 and no business message', () => {
    const outcome = ws002.summarize(parse());
    assert.equal(outcome.verdict, 'PASS');
    assert.equal(outcome.recordCount, 10);
    assert.deepEqual(outcome.businessMessage, []);
  });
});

describe('ZWsSap002 — real QA business error carried on HTTP 200', () => {
  const raw = load('zWsSap002.business-error.response.xml');
  const parse = () => ws002.parseResult(unwrapBody(parseXml(raw), 'ZWsSap002').node);

  it('EMsgnro is alphanumeric, not a 3-digit number — "ZFICA017"', () => {
    // The reconstructed fixtures all assumed numeric codes like "042". SAP
    // actually returns the ABAP message class + number. classifyBusinessMessage
    // must not depend on the code being numeric.
    assert.equal(parse().eMsgnro, 'ZFICA017');
  });

  it('is FAIL with an empty TFact — HTTP 200 does not mean success', () => {
    const outcome = ws002.summarize(parse());
    assert.equal(outcome.verdict, 'FAIL');
    assert.equal(outcome.recordCount, 0);
    assert.equal(outcome.businessMessage[0]?.code, 'ZFICA017');
    assert.match(outcome.businessMessage[0]?.text ?? '', /diferente a recibida por par/);
  });
});

describe('ZZCS_INFO_IC_WS — real QA response for DNI 30955882 (captured 2026-09-01)', () => {
  const raw = load('zzcsInfoIcWs.response.xml');
  const parse = () => zzcs.parseResult(unwrapBody(parseXml(raw), 'ZZCS_INFO_IC_WS').node);

  it('carries no SOAP fault and unwraps by the expected element name', () => {
    const node = parseXml(raw);
    assert.equal(findFault(node), null);
    assert.equal(unwrapBody(node, 'ZZCS_INFO_IC_WS').responseElementMismatch, undefined);
  });

  it('parses one row out of the item-wrapped OU_INFO_IC_WS table', () => {
    assert.equal(parse().rows.length, 1);
  });

  it('PARTNER and ANLAGE keep their leading zeros as 10-character strings', () => {
    const row = parse().rows[0];
    assert.equal(typeof row?.partner, 'string');
    assert.equal(row?.partner.length, 10);
    assert.match(row?.partner ?? '', /^0/);
    assert.equal(typeof row?.anlage, 'string');
    assert.equal(row?.anlage.length, 10);
    assert.match(row?.anlage ?? '', /^0/);
  });

  it('IDNUMBER_DNI survives as an 8-digit string, not a number', () => {
    const idnumberDni = parse().rows[0]?.idnumberDni ?? '';
    assert.equal(typeof idnumberDni, 'string');
    assert.equal(idnumberDni.length, 8);
  });

  it('STATUS, FACT_ADEUDADAS and DEUDA are the fields the API mainly needs', () => {
    const row = parse().rows[0];
    assert.equal(row?.status, 'DESCONECTADO');
    assert.equal(row?.factAdeudadas, '001');
    assert.equal(row?.deuda, '26.58');
  });

  it('OU_RESULTADO is "0" — the only observed value, and it is not zero-padded away', () => {
    assert.equal(parse().ouResultado, '0');
  });

  it('summarizes as PASS with recordCount 1', () => {
    const outcome = zzcs.summarize(parse());
    assert.equal(outcome.verdict, 'PASS');
    assert.equal(outcome.recordCount, 1);
    assert.deepEqual(outcome.businessMessage, []);
  });

  it('the redacted name and address fields carry no real customer data', () => {
    const row = parse().rows[0];
    assert.match(row?.name1Text ?? '', /^\[REDACTED/);
    assert.match(row?.streetIc ?? '', /^\[REDACTED/);
    assert.match(row?.city1Ic ?? '', /^\[REDACTED/);
  });
});
