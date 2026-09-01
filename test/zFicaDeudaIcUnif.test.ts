// Tests unitarios de src/services/zFicaDeudaIcUnif.ts.
// Nombres de campo desde el WSDL real (test/fixtures/fica.wsdl.xml). El
// fixture no-debt es real: capturado en QA a HTTP 200 el 2026-08-28.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseXml, unwrapBody } from '../src/soap/parser.js';
import { buildFields, parseResult, summarize } from '../src/services/zFicaDeudaIcUnif.js';

const INPUT = { piCc: '', piFechaHasta: '', piI: '', piIc: '0010084434', piNumMax: '10' };

describe('zFicaDeudaIcUnif.buildFields', () => {
  it('emits the five input fields in WSDL sequence order', () => {
    assert.deepEqual(buildFields(INPUT).slice(0, 5), [
      { name: 'PiCc', value: '' },
      { name: 'PiFechaHasta', value: '' },
      { name: 'PiI', value: '' },
      { name: 'PiIc', value: '0010084434' },
      { name: 'PiNumMax', value: '10' },
    ]);
  });

  it('also emits empty PoDocumentos and PoMensaje — mandatory in the request element', () => {
    // Verificado en vivo: sin estos dos, QA responde HTTP 500 en 145ms.
    assert.deepEqual(buildFields(INPUT).slice(5), [
      { name: 'PoDocumentos', value: '' },
      { name: 'PoMensaje', value: '' },
    ]);
  });
});

describe('zFicaDeudaIcUnif.parseResult — real captured QA response', () => {
  it('reads the no-debt response captured live at HTTP 200', () => {
    const raw = readFileSync(new URL('./fixtures/zFicaDeudaIcUnif.no-debt.response.xml', import.meta.url), 'utf8');
    const { node, responseElementMismatch } = unwrapBody(parseXml(raw), 'ZFicaDeudaIcUnif');
    assert.equal(responseElementMismatch, undefined);

    const out = parseResult(node);
    assert.deepEqual(out.poDocumentos, []);
    assert.deepEqual(out.poMensaje, [{ codigo: '001', descripcion: 'No se registra deuda' }]);
  });

  it('that same real response summarizes as PASS — 001 is "no debt", not a failure', () => {
    const raw = readFileSync(new URL('./fixtures/zFicaDeudaIcUnif.no-debt.response.xml', import.meta.url), 'utf8');
    const { node } = unwrapBody(parseXml(raw), 'ZFicaDeudaIcUnif');
    const outcome = summarize(parseResult(node));
    assert.equal(outcome.verdict, 'PASS');
    assert.equal(outcome.recordCount, 0);
    assert.deepEqual(outcome.businessMessage, [{ code: '001', text: 'No se registra deuda' }]);
  });
});

describe('zFicaDeudaIcUnif.parseResult — PascalCase wire names, row counts', () => {
  function parse(bodyXml: string) {
    const raw = `<Envelope><Body><ZFicaDeudaIcUnifResponse>${bodyXml}</ZFicaDeudaIcUnifResponse></Body></Envelope>`;
    const { node } = unwrapBody(parseXml(raw), 'ZFicaDeudaIcUnif');
    return parseResult(node);
  }

  const doc = (n: string) =>
    `<item><Budat>2026-01-0${n}</Budat><Faedn>2026-02-0${n}</Faedn><Xblnr>009000123${n}</Xblnr>` +
    `<Ltext>Factura ${n}</Ltext><Betrw>${n}.50</Betrw><TotalAmnt>${n}.50</TotalAmnt>` +
    `<CodBarraVisual>c${n}</CodBarraVisual></item>`;

  it('0 rows: self-closed <PoDocumentos/> and <PoMensaje/>', () => {
    const out = parse('<PoDocumentos/><PoMensaje/>');
    assert.deepEqual(out.poDocumentos, []);
    assert.deepEqual(out.poMensaje, []);
  });

  it('1 row: leading-zero Xblnr and decimal Betrw/TotalAmnt survive as strings', () => {
    const out = parse(`<PoDocumentos>${doc('1')}</PoDocumentos><PoMensaje/>`);
    assert.equal(out.poDocumentos.length, 1);
    assert.equal(out.poDocumentos[0]?.xblnr, '0090001231');
    assert.equal(out.poDocumentos[0]?.betrw, '1.50');
    assert.equal(typeof out.poDocumentos[0]?.betrw, 'string');
  });

  it('3 rows plus a message entry', () => {
    const out = parse(
      `<PoDocumentos>${doc('1')}${doc('2')}${doc('3')}</PoDocumentos>` +
        '<PoMensaje><item><Codigo>000</Codigo><Descripcion>OK</Descripcion></item></PoMensaje>',
    );
    assert.equal(out.poDocumentos.length, 3);
    assert.deepEqual(out.poMensaje, [{ codigo: '000', descripcion: 'OK' }]);
  });

  it('camelCase wire names are NOT accepted — the pre-WSDL bug must stay dead', () => {
    const out = parse('<poDocumentos><item><budat>x</budat></item></poDocumentos><poMensaje/>');
    assert.deepEqual(out.poDocumentos, []);
  });
});

describe('zFicaDeudaIcUnif.summarize', () => {
  it('empty documents with no message is PASS', () => {
    const outcome = summarize({ poDocumentos: [], poMensaje: [] });
    assert.equal(outcome.verdict, 'PASS');
    assert.equal(outcome.recordCount, 0);
  });

  it('code 000 is PASS', () => {
    const outcome = summarize({ poDocumentos: [], poMensaje: [{ codigo: '000', descripcion: 'OK' }] });
    assert.equal(outcome.verdict, 'PASS');
  });

  it('code 001 ("No se registra deuda") is PASS — an empty debt result is success, not an error', () => {
    const outcome = summarize({
      poDocumentos: [],
      poMensaje: [{ codigo: '001', descripcion: 'No se registra deuda' }],
    });
    assert.equal(outcome.verdict, 'PASS');
    assert.deepEqual(outcome.businessMessage, [{ code: '001', text: 'No se registra deuda' }]);
  });

  it('any other code is a business error -> FAIL, carried verbatim', () => {
    const outcome = summarize({
      poDocumentos: [],
      poMensaje: [{ codigo: '002', descripcion: 'Interlocutor inexistente' }],
    });
    assert.equal(outcome.verdict, 'FAIL');
    assert.deepEqual(outcome.businessMessage, [{ code: '002', text: 'Interlocutor inexistente' }]);
  });

  it('recordCount reflects poDocumentos length', () => {
    const row = {
      budat: '', faedn: '', xblnr: '', ltext: '', betrw: '', totalAmnt: '', codBarraVisual: '',
    };
    const outcome = summarize({ poDocumentos: [row, row], poMensaje: [] });
    assert.equal(outcome.recordCount, 2);
  });
});
