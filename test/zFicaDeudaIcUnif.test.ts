// TDD RED-first for src/services/zFicaDeudaIcUnif.ts — see design §1.
//
// HONEST CONSTRAINT: no real successful ZFicaDeudaIcUnif response has ever
// been observed (DPEC's binding is unconfigured in QA — see obs #921). These
// fixtures are RECONSTRUCTED from the design's field list (§10) and the
// live-captured request envelope (evidence/spike-2026-08-27T01-39-07-793Z),
// not captured from a real success response. Named follow-up: promote real
// evidence/**/*.response.xml into fixtures here after the first live PASS.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseXml, unwrapBody } from '../src/soap/parser.js';
import { buildFields, parseResult, summarize } from '../src/services/zFicaDeudaIcUnif.js';

describe('zFicaDeudaIcUnif.buildFields', () => {
  it('emits PiCc, PiFechaHasta, PiI, PiIc, PiNumMax in capture order (design §2 field order)', () => {
    const fields = buildFields({
      piCc: '',
      piFechaHasta: '',
      piI: '',
      piIc: '0010084434',
      piNumMax: '10',
    });
    assert.deepEqual(fields, [
      { name: 'PiCc', value: '' },
      { name: 'PiFechaHasta', value: '' },
      { name: 'PiI', value: '' },
      { name: 'PiIc', value: '0010084434' },
      { name: 'PiNumMax', value: '10' },
    ]);
  });
});

describe('zFicaDeudaIcUnif.parseResult — poDocumentos row counts (0/1/3), reconstructed fixtures', () => {
  function parse(bodyXml: string) {
    const raw = `<Envelope><Body><ZFicaDeudaIcUnifResponse>${bodyXml}</ZFicaDeudaIcUnifResponse></Body></Envelope>`;
    const { node } = unwrapBody(parseXml(raw), 'ZFicaDeudaIcUnif');
    return parseResult(node);
  }

  it('0 rows: self-closed <poDocumentos/> and <poMensaje/>', () => {
    const out = parse('<poDocumentos/><poMensaje/>');
    assert.deepEqual(out.poDocumentos, []);
    assert.deepEqual(out.poMensaje, []);
  });

  it('1 row: leading-zero xblnr and decimal betrw/totalAmnt survive as strings', () => {
    const out = parse(
      '<poDocumentos><budat>2026-01-01</budat><faedn>2026-02-01</faedn>' +
        '<xblnr>0090001234</xblnr><ltext>Factura</ltext><betrw>1234.50</betrw>' +
        '<totalAmnt>1234.50</totalAmnt><codBarraVisual>123456</codBarraVisual></poDocumentos>' +
        '<poMensaje/>',
    );
    assert.equal(out.poDocumentos.length, 1);
    assert.equal(out.poDocumentos[0]?.xblnr, '0090001234');
    assert.equal(out.poDocumentos[0]?.betrw, '1234.50');
    assert.equal(typeof out.poDocumentos[0]?.betrw, 'string');
  });

  it('3 rows: flat repeated <poDocumentos> siblings, plus a poMensaje entry', () => {
    const out = parse(
      '<poDocumentos><budat>1</budat><faedn>1</faedn><xblnr>a</xblnr><ltext>L1</ltext>' +
        '<betrw>1.00</betrw><totalAmnt>1.00</totalAmnt><codBarraVisual>c1</codBarraVisual></poDocumentos>' +
        '<poDocumentos><budat>2</budat><faedn>2</faedn><xblnr>b</xblnr><ltext>L2</ltext>' +
        '<betrw>2.00</betrw><totalAmnt>2.00</totalAmnt><codBarraVisual>c2</codBarraVisual></poDocumentos>' +
        '<poDocumentos><budat>3</budat><faedn>3</faedn><xblnr>c</xblnr><ltext>L3</ltext>' +
        '<betrw>3.00</betrw><totalAmnt>3.00</totalAmnt><codBarraVisual>c3</codBarraVisual></poDocumentos>' +
        '<poMensaje><codigo>000</codigo><descripcion>OK</descripcion></poMensaje>',
    );
    assert.equal(out.poDocumentos.length, 3);
    assert.deepEqual(
      out.poDocumentos.map((r) => r.xblnr),
      ['a', 'b', 'c'],
    );
    assert.deepEqual(out.poMensaje, [{ codigo: '000', descripcion: 'OK' }]);
  });
});

describe('zFicaDeudaIcUnif.summarize', () => {
  it('empty poDocumentos + empty poMensaje is PASS with count 0 (spec: empty debt is success)', () => {
    const outcome = summarize({ poDocumentos: [], poMensaje: [] });
    assert.equal(outcome.verdict, 'PASS');
    assert.equal(outcome.recordCount, 0);
    assert.deepEqual(outcome.businessMessage, []);
  });

  it('poMensaje with success code ("000") is PASS, message still surfaced', () => {
    const outcome = summarize({ poDocumentos: [], poMensaje: [{ codigo: '000', descripcion: 'sin deuda' }] });
    assert.equal(outcome.verdict, 'PASS');
    assert.deepEqual(outcome.businessMessage, [{ code: '000', text: 'sin deuda' }]);
  });

  it('poMensaje with a non-zero code is a business error -> FAIL', () => {
    const outcome = summarize({
      poDocumentos: [],
      poMensaje: [{ codigo: '015', descripcion: 'Cuenta contrato inexistente' }],
    });
    assert.equal(outcome.verdict, 'FAIL');
    assert.deepEqual(outcome.businessMessage, [{ code: '015', text: 'Cuenta contrato inexistente' }]);
  });

  it('3 documents + success message -> PASS with recordCount 3', () => {
    const docs = [
      { budat: '1', faedn: '1', xblnr: 'a', ltext: 'L1', betrw: '1.00', totalAmnt: '1.00', codBarraVisual: 'c1' },
      { budat: '2', faedn: '2', xblnr: 'b', ltext: 'L2', betrw: '2.00', totalAmnt: '2.00', codBarraVisual: 'c2' },
      { budat: '3', faedn: '3', xblnr: 'c', ltext: 'L3', betrw: '3.00', totalAmnt: '3.00', codBarraVisual: 'c3' },
    ];
    const outcome = summarize({ poDocumentos: docs, poMensaje: [{ codigo: '000', descripcion: 'OK' }] });
    assert.equal(outcome.verdict, 'PASS');
    assert.equal(outcome.recordCount, 3);
  });
});
