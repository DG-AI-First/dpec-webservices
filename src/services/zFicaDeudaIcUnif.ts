// Z_FICA_DEUDA_IC_UNIF — unified-debt operation descriptor. See design §1:
// pure functions of data in, data out (test/zFicaDeudaIcUnif.test.ts).
//
// Field order below matches the live-captured request envelope verbatim
// (evidence/spike-2026-08-27T01-39-07-793Z/deuda.request.xml).

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
  ];
}

/**
 * `responseNode` is already unwrapped to the `ZFicaDeudaIcUnifResponse`
 * element (unwrapBody, soap/parser.ts).
 */
export function parseResult(responseNode: XmlNode): ZFicaDeudaIcUnifOutput {
  const poDocumentos: PoDocumento[] = toArray<XmlNode>(responseNode.poDocumentos).map((row) => ({
    budat: extractText(row.budat),
    faedn: extractText(row.faedn),
    xblnr: extractText(row.xblnr),
    ltext: extractText(row.ltext),
    betrw: extractText(row.betrw),
    totalAmnt: extractText(row.totalAmnt),
    codBarraVisual: extractText(row.codBarraVisual),
  }));

  const poMensaje: PoMensaje[] = toArray<XmlNode>(responseNode.poMensaje).map((row) => ({
    codigo: extractText(row.codigo),
    descripcion: extractText(row.descripcion),
  }));

  return { poDocumentos, poMensaje };
}

/**
 * WS01 signals a business error via poMensaje[] (design §1) — unlike WS02
 * there is no single eMsgnro pair, so every message is classified and the
 * first genuine error (if any) drives the verdict. An empty poDocumentos
 * with no error message is PASS (spec "Empty debt result is success").
 */
export function summarize(output: ZFicaDeudaIcUnifOutput): ServiceOutcome {
  const businessMessage = output.poMensaje.map((m) => ({ code: m.codigo, text: m.descripcion }));
  const errors = output.poMensaje
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
  namespace: 'urn:sap-com:document:sap:rfc:functions',
  endpointPath: '/sap/bc/srt/rfc/sap/z_fica_deuda_ic_unif/100/z_fica_deuda_ic_unif/z_fica_deuda_ic_unif',
  soapAction: '',
  buildFields,
  parseResult,
  summarize,
};
