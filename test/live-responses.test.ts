// Authoritative fixtures: three real QA responses, captured at HTTP 200 on
// 2026-08-28 by `npm run probe`. Everything else in this suite tests our
// assumptions; this file tests SAP's actual behaviour.
//
// PRIVACY: document numbers, invoice references, barcodes and the digits
// inside the error text are digit-scrambled through a fixed permutation of
// 1-9 that maps 0 to 0. Zero is deliberately a fixed point: leading zeros
// are the property these tests exist to defend, so a scramble that moved
// them would quietly delete the assertion's subject. Lengths, decimal
// places and signs are preserved for the same reason. Dates and amounts are
// untouched (they identify no one). The unmodified originals stay in
// evidence/, which is gitignored.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseXml, unwrapBody, findFault } from '../src/soap/parser.js';
import * as fica from '../src/services/zFicaDeudaIcUnif.js';
import * as ws002 from '../src/services/zWsSap002.js';

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
