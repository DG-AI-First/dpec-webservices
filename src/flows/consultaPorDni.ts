// Encadena ZZCS_INFO_IC_WS (DNI -> PARTNER/ANLAGE) con el call de negocio
// correspondiente (deuda o facturas). Puro: sin node:http, fetch, console ni
// fs -- la capacidad de red se inyecta como OperationCaller, así que se
// testea con fakes planos, cero mocking (igual que services/).
//
// Chain verificada en vivo (2026-09-01): DNI 30955882 -> PARTNER 0030002708
// -> 1 documento de $26.58 (ZFicaDeudaIcUnif).

import type { SoapOperation } from '../soap/types.js';
import { ProbeError } from '../errors.js';
import { zzcsInfoIcWs, type ZzcsInfoIcWsInput } from '../services/zzcsInfoIcWs.js';
import { zFicaDeudaIcUnif, type PoDocumento } from '../services/zFicaDeudaIcUnif.js';
import { zWsSap002, type TFactRow } from '../services/zWsSap002.js';

/** Capacidad inyectada: llama una operación SOAP y devuelve su output ya parseado, o lanza un ProbeError. */
export type OperationCaller = <TInput, TOutput>(
  op: SoapOperation<TInput, TOutput>,
  input: TInput,
) => Promise<TOutput>;

type PartnerResolution =
  | { readonly kind: 'resuelto'; readonly partner: string; readonly anlage: string }
  | { readonly kind: 'no-encontrado' }
  | { readonly kind: 'zzcs-rechazado'; readonly ouResultado: string }
  | { readonly kind: 'error'; readonly error: ProbeError };

/**
 * PARTNER/ANLAGE salen siempre de la PRIMERA fila devuelta por ZZCS. El
 * criterio de SAP para ordenar filas cuando hay más de una instalación por
 * DNI no está documentado; se asume la primera hasta que aparezca evidencia
 * en contrario.
 */
async function resolveDniToPartner(call: OperationCaller, dni: string): Promise<PartnerResolution> {
  const input: ZzcsInfoIcWsInput = { inNumero: dni, inPartner: '', inTest: '', inTipo: '*' };

  let output;
  try {
    output = await call(zzcsInfoIcWs, input);
  } catch (err) {
    if (err instanceof ProbeError) return { kind: 'error', error: err };
    throw err;
  }

  const outcome = zzcsInfoIcWs.summarize(output);
  if (outcome.verdict === 'FAIL') {
    return { kind: 'zzcs-rechazado', ouResultado: output.ouResultado };
  }

  const first = output.rows[0];
  if (!first) return { kind: 'no-encontrado' };

  return { kind: 'resuelto', partner: first.partner, anlage: first.anlage };
}

/**
 * Variantes de falla compartidas por los dos flows (todo menos 'ok'): mismo
 * shape en ambos, así que server/mapOutcome.ts puede tratarlas de forma
 * uniforme sin importar cuál de los dos flows las produjo.
 */
export type ConsultaOutcomeError =
  | { readonly kind: 'no-encontrado' }
  | { readonly kind: 'zzcs-rechazado'; readonly ouResultado: string }
  | { readonly kind: 'error-negocio'; readonly codigo: string; readonly mensaje: string }
  | { readonly kind: 'error'; readonly error: ProbeError };

export type DeudaOutcome =
  | ConsultaOutcomeError
  | { readonly kind: 'ok'; readonly partner: string; readonly documentos: readonly PoDocumento[] };

/** Deuda por DNI: ZZCS_INFO_IC_WS -> ZFicaDeudaIcUnif(piIc=PARTNER). piI/piCc/piFechaHasta quedan vacíos. */
export async function consultarDeudaPorDni(
  call: OperationCaller,
  dni: string,
  piNumMax = '10',
): Promise<DeudaOutcome> {
  const resolution = await resolveDniToPartner(call, dni);
  if (resolution.kind !== 'resuelto') return resolution;

  let output;
  try {
    output = await call(zFicaDeudaIcUnif, {
      piIc: resolution.partner,
      piCc: '',
      piI: '',
      piFechaHasta: '',
      piNumMax,
    });
  } catch (err) {
    if (err instanceof ProbeError) return { kind: 'error', error: err };
    throw err;
  }

  const outcome = zFicaDeudaIcUnif.summarize(output);
  if (outcome.verdict === 'FAIL') {
    const [first] = outcome.businessMessage;
    return { kind: 'error-negocio', codigo: first?.code ?? '', mensaje: first?.text ?? '' };
  }

  return { kind: 'ok', partner: resolution.partner, documentos: output.poDocumentos };
}

export type FacturasOutcome =
  | ConsultaOutcomeError
  | { readonly kind: 'ok'; readonly partner: string; readonly facturas: readonly TFactRow[] };

/**
 * Facturas por DNI: ZZCS_INFO_IC_WS -> ZWsSap002(iPartner=PARTNER, iAnlage=ANLAGE).
 * Conocido: falla con E9011 para clientes desconectados (instalación sin vínculo) --
 * eso llega como 'error-negocio', no como un error genérico.
 */
export async function consultarFacturasPorDni(
  call: OperationCaller,
  dni: string,
  iCantfact = '10',
): Promise<FacturasOutcome> {
  const resolution = await resolveDniToPartner(call, dni);
  if (resolution.kind !== 'resuelto') return resolution;

  let output;
  try {
    output = await call(zWsSap002, {
      iPartner: resolution.partner,
      iAnlage: resolution.anlage,
      iCantfact,
    });
  } catch (err) {
    if (err instanceof ProbeError) return { kind: 'error', error: err };
    throw err;
  }

  const outcome = zWsSap002.summarize(output);
  if (outcome.verdict === 'FAIL') {
    const [first] = outcome.businessMessage;
    return { kind: 'error-negocio', codigo: first?.code ?? '', mensaje: first?.text ?? '' };
  }

  return { kind: 'ok', partner: resolution.partner, facturas: output.tFact };
}
