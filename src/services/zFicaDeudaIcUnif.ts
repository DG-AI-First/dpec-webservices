// Z_FICA_DEUDA_IC_UNIF — unified-debt operation descriptor. See design §1:
// pure functions of data in, data out (test/zFicaDeudaIcUnif.test.ts).
//
// Field order and every wire name below come from the QA WSDL, promoted to
// test/fixtures/fica.wsdl.xml:
//   ZFicaDeudaIcUnif         :: PiCc?, PiFechaHasta?, PiI?, PiIc, PiNumMax,
//                               PoDocumentos, PoMensaje
//   ZFicaDeudaIcUnifResponse :: PoDocumentos, PoMensaje
//   ZficasDetDeudaCte        :: Budat, Faedn, Xblnr, Ltext, Betrw, TotalAmnt,
//                               CodBarraVisual
//   ZficasMessDeudaCte       :: Codigo, Descripcion

import type { WireField, XmlNode, SoapOperation, ServiceOutcome } from '../soap/types.js';
import { toArray, extractText } from '../soap/parser.js';
import { classifyBusinessMessage, determineVerdict, type BusinessError } from '../errors.js';

export interface ZFicaDeudaIcUnifInput {
  readonly piCc: string;
  readonly piIc: string;
  readonly piI: string;
  readonly piFechaHasta: string;
  readonly piNumMax: string;
}

export interface PoDocumento {
  readonly budat: string;
  readonly faedn: string;
  readonly xblnr: string;
  readonly ltext: string;
  readonly betrw: string;
  readonly totalAmnt: string;
  readonly codBarraVisual: string;
}

export interface PoMensaje {
  readonly codigo: string;
  readonly descripcion: string;
}

export interface ZFicaDeudaIcUnifOutput {
  readonly poDocumentos: readonly PoDocumento[];
  readonly poMensaje: readonly PoMensaje[];
}

export function buildFields(input: ZFicaDeudaIcUnifInput): WireField[] {
  return [
    { name: 'PiCc', value: input.piCc },
    { name: 'PiFechaHasta', value: input.piFechaHasta },
    { name: 'PiI', value: input.piI },
    { name: 'PiIc', value: input.piIc },
    { name: 'PiNumMax', value: input.piNumMax },
    // The RFC's output tables are part of the INPUT element's sequence, and
    // neither carries minOccurs="0" — mc-style makes them mandatory on the
    // way in even though they only ever carry data on the way out. Dropping
    // them is HTTP 500 in 145ms, with a fault that names nothing. Verified
    // live against QA on 2026-08-28.
    { name: 'PoDocumentos', value: '' },
    { name: 'PoMensaje', value: '' },
  ];
}

/**
 * `responseNode` is already unwrapped to the `ZFicaDeudaIcUnifResponse`
 * element (unwrapBody, soap/parser.ts).
 */
export function parseResult(responseNode: XmlNode): ZFicaDeudaIcUnifOutput {
  const poDocumentos: PoDocumento[] = toArray<XmlNode>(responseNode.PoDocumentos).map((row) => ({
    budat: extractText(row.Budat),
    faedn: extractText(row.Faedn),
    xblnr: extractText(row.Xblnr),
    ltext: extractText(row.Ltext),
    betrw: extractText(row.Betrw),
    totalAmnt: extractText(row.TotalAmnt),
    codBarraVisual: extractText(row.CodBarraVisual),
  }));

  const poMensaje: PoMensaje[] = toArray<XmlNode>(responseNode.PoMensaje).map((row) => ({
    codigo: extractText(row.Codigo),
    descripcion: extractText(row.Descripcion),
  }));

  return { poDocumentos, poMensaje };
}

/**
 * Codigo "001" is "No se registra deuda" — SAP's way of saying the account
 * is clear, captured live at HTTP 200 (test/fixtures/*.no-debt.response.xml).
 * It is a SUCCESS, and the generic classifier cannot know that: it treats
 * anything but empty/all-zeros as an error, which would turn every debt-free
 * account into a FAIL. The full Codigo table is still unknown, so this is a
 * narrow, evidence-backed exception rather than a widened rule — add codes
 * here only with a captured response to back them.
 */
const NO_DEBT_CODE = '001';

/**
 * WS01 signals a business error via poMensaje[] (design §1) — unlike WS02
 * there is no single eMsgnro pair, so every message is classified and the
 * first genuine error (if any) drives the verdict. An empty poDocumentos
 * with no error message is PASS (spec "Empty debt result is success").
 */
export function summarize(output: ZFicaDeudaIcUnifOutput): ServiceOutcome {
  const businessMessage = output.poMensaje.map((m) => ({ code: m.codigo, text: m.descripcion }));
  const errors = output.poMensaje
    .filter((m) => m.codigo.trim() !== NO_DEBT_CODE)
    .map((m) => classifyBusinessMessage(m.codigo, m.descripcion))
    .filter((e): e is BusinessError => e !== null);

  return {
    recordCount: output.poDocumentos.length,
    businessMessage,
    verdict: determineVerdict(errors[0] ?? null),
  };
}

export const zFicaDeudaIcUnif: SoapOperation<ZFicaDeudaIcUnifInput, ZFicaDeudaIcUnifOutput> = {
  serviceName: 'z-fica-deuda-ic-unif',
  operationName: 'ZFicaDeudaIcUnif',
  namespace: 'urn:sap-com:document:sap:soap:functions:mc-style',
  endpointPath: '/sap/bc/srt/rfc/sap/z_fica_deuda_ic_unif/100/z_fica_deuda_ic_unif/z_fica_deuda_ic_unif',
  soapAction: '',
  buildFields,
  parseResult,
  summarize,
};
