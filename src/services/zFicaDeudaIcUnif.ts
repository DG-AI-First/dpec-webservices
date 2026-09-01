// Z_FICA_DEUDA_IC_UNIF: descriptor de la operación de deuda unificada.
// Nombres de campo y orden desde el WSDL real (test/fixtures/fica.wsdl.xml).

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
    // PoDocumentos/PoMensaje son obligatorios en el elemento de ENTRADA
    // (mc-style, sin minOccurs="0"). Omitirlos = HTTP 500 en 145ms.
    // Verificado 2026-08-28.
    { name: 'PoDocumentos', value: '' },
    { name: 'PoMensaje', value: '' },
  ];
}

/** `responseNode` ya viene desenvuelto a `ZFicaDeudaIcUnifResponse`. */
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

/** Código "001" = "No se registra deuda" = ÉXITO, no error (HTTP 200, QA). */
const NO_DEBT_CODE = '001';

/**
 * WS01 señala error de negocio vía poMensaje[] (no hay un único código como
 * WS02). poDocumentos vacío sin mensaje de error es PASS.
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
