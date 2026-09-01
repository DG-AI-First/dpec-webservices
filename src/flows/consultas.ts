// Encadena ZZCS_INFO_IC_WS (DNI -> PARTNER/ANLAGE) con el call de negocio
// correspondiente (deuda, facturas o el propio cliente). Puro: sin
// node:http, fetch, console ni fs -- la capacidad de red se inyecta como
// OperationCaller, así que se testea con fakes planos, cero mocking (igual
// que services/).
//
// Cada flow acepta el DNI (dispara la resolución ZZCS) o los identificadores
// SAP directos (partner/anlage), salteando esa resolución -- necesario para
// reproducir los casos de prueba del PDF de integración de DPEC, que vienen
// dados por PARTNER/ANLAGE, no por DNI.
//
// Chain verificada en vivo (2026-09-01): DNI 30955882 -> PARTNER 0030002708
// -> 1 documento de $26.58 (ZFicaDeudaIcUnif).

import type { SoapOperation } from '../soap/types.js';
import { UpstreamError } from '../errors.js';
import { zzcsInfoIcWs, type ZzcsInfoIcWsInput, type OuInfoIcWsRow } from '../services/zzcsInfoIcWs.js';
import { zFicaDeudaIcUnif, type PoDocumento } from '../services/zFicaDeudaIcUnif.js';
import { zWsSap002, type TFactRow } from '../services/zWsSap002.js';

/** Capacidad inyectada: llama una operación SOAP y devuelve su output ya parseado, o lanza un UpstreamError. */
export type OperationCaller = <TInput, TOutput>(
  op: SoapOperation<TInput, TOutput>,
  input: TInput,
) => Promise<TOutput>;

/**
 * Variantes de falla compartidas por los tres flows (todo menos 'ok'): mismo
 * shape en todos, así que server/mapOutcome.ts puede tratarlas de forma
 * uniforme sin importar cuál de los flows las produjo.
 */
export type ConsultaOutcomeError =
  | { readonly kind: 'no-encontrado' }
  | { readonly kind: 'zzcs-rechazado'; readonly ouResultado: string }
  | { readonly kind: 'error-negocio'; readonly codigo: string; readonly mensaje: string }
  | { readonly kind: 'error'; readonly error: UpstreamError };

type ZzcsLookup =
  | { readonly kind: 'ok'; readonly row: OuInfoIcWsRow }
  | ConsultaOutcomeError;

/**
 * PARTNER/ANLAGE/status/nombre salen siempre de la PRIMERA fila devuelta por
 * ZZCS. El criterio de SAP para ordenar filas cuando hay más de una
 * instalación por DNI no está documentado; se asume la primera hasta que
 * aparezca evidencia en contrario.
 */
async function lookupZzcs(call: OperationCaller, dni: string): Promise<ZzcsLookup> {
  const input: ZzcsInfoIcWsInput = { inNumero: dni, inPartner: '', inTest: '', inTipo: '*' };

  let output;
  try {
    output = await call(zzcsInfoIcWs, input);
  } catch (err) {
    if (err instanceof UpstreamError) return { kind: 'error', error: err };
    throw err;
  }

  const outcome = zzcsInfoIcWs.summarize(output);
  if (outcome.verdict === 'FAIL') {
    return { kind: 'zzcs-rechazado', ouResultado: output.ouResultado };
  }

  const first = output.rows[0];
  if (!first) return { kind: 'no-encontrado' };

  return { kind: 'ok', row: first };
}

type PartnerResolution =
  | { readonly kind: 'resuelto'; readonly partner: string; readonly anlage: string }
  | ConsultaOutcomeError;

async function resolveDniToPartner(call: OperationCaller, dni: string): Promise<PartnerResolution> {
  const lookup = await lookupZzcs(call, dni);
  if (lookup.kind !== 'ok') return lookup;
  return { kind: 'resuelto', partner: lookup.row.partner, anlage: lookup.row.anlage };
}

export type DeudaInput =
  | { readonly kind: 'dni'; readonly dni: string }
  | { readonly kind: 'partner'; readonly partner: string };

export type DeudaOutcome =
  | ConsultaOutcomeError
  | { readonly kind: 'ok'; readonly partner: string; readonly documentos: readonly PoDocumento[] };

/**
 * Deuda: ZZCS_INFO_IC_WS (si `input.kind === 'dni'`) -> ZFicaDeudaIcUnif(piIc=PARTNER).
 * piI/piCc/piFechaHasta quedan vacíos. Con `input.kind === 'partner'` se
 * salta la resolución por completo -- el partner llega ya validado por la
 * capa HTTP.
 */
export async function consultarDeuda(
  call: OperationCaller,
  input: DeudaInput,
  piNumMax = '10',
): Promise<DeudaOutcome> {
  const resolution: PartnerResolution =
    input.kind === 'dni' ? await resolveDniToPartner(call, input.dni) : { kind: 'resuelto', partner: input.partner, anlage: '' };
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
    if (err instanceof UpstreamError) return { kind: 'error', error: err };
    throw err;
  }

  const outcome = zFicaDeudaIcUnif.summarize(output);
  if (outcome.verdict === 'FAIL') {
    const [first] = outcome.businessMessage;
    return { kind: 'error-negocio', codigo: first?.code ?? '', mensaje: first?.text ?? '' };
  }

  return { kind: 'ok', partner: resolution.partner, documentos: output.poDocumentos };
}

export type FacturasInput =
  | { readonly kind: 'dni'; readonly dni: string }
  | { readonly kind: 'partner'; readonly partner: string; readonly anlage: string };

export type FacturasOutcome =
  | ConsultaOutcomeError
  | { readonly kind: 'ok'; readonly partner: string; readonly facturas: readonly TFactRow[] };

/**
 * Facturas: ZZCS_INFO_IC_WS (si `input.kind === 'dni'`) -> ZWsSap002(iPartner=PARTNER, iAnlage=ANLAGE).
 * Con `input.kind === 'partner'` ambos valores llegan directos, sin
 * resolución. Conocido: falla con E9011 para clientes desconectados
 * (instalación sin vínculo) -- eso llega como 'error-negocio', no como un
 * error genérico.
 */
export async function consultarFacturas(
  call: OperationCaller,
  input: FacturasInput,
  iCantfact = '10',
): Promise<FacturasOutcome> {
  const resolution: PartnerResolution =
    input.kind === 'dni'
      ? await resolveDniToPartner(call, input.dni)
      : { kind: 'resuelto', partner: input.partner, anlage: input.anlage };
  if (resolution.kind !== 'resuelto') return resolution;

  let output;
  try {
    output = await call(zWsSap002, {
      iPartner: resolution.partner,
      iAnlage: resolution.anlage,
      iCantfact,
    });
  } catch (err) {
    if (err instanceof UpstreamError) return { kind: 'error', error: err };
    throw err;
  }

  const outcome = zWsSap002.summarize(output);
  if (outcome.verdict === 'FAIL') {
    const [first] = outcome.businessMessage;
    return { kind: 'error-negocio', codigo: first?.code ?? '', mensaje: first?.text ?? '' };
  }

  return { kind: 'ok', partner: resolution.partner, facturas: output.tFact };
}

export interface ClienteResumen {
  readonly partner: string;
  readonly anlage: string;
  readonly status: string;
  readonly nombre: string;
  readonly factAdeudadas: string;
  readonly deuda: string;
}

export type ClienteOutcome =
  | ConsultaOutcomeError
  | { readonly kind: 'ok'; readonly cliente: ClienteResumen };

/**
 * PRIVACIDAD: la fila de ZZCS trae 37 campos con datos personales (nombre,
 * domicilio, teléfono, email). Esta API no tiene autenticación y los DNI son
 * secuenciales -- devolver la fila completa la convertiría en un buscador de
 * personas sobre la cartera de clientes de DPEC. Se expone sólo este
 * subconjunto; no lo amplíes sin resolver antes la autenticación (ver
 * README "Lo que la API todavía NO hace").
 */
function curarCliente(row: OuInfoIcWsRow): ClienteResumen {
  return {
    partner: row.partner,
    anlage: row.anlage,
    status: row.status,
    nombre: row.name1Text,
    factAdeudadas: row.factAdeudadas,
    deuda: row.deuda,
  };
}

/** Expone ZZCS_INFO_IC_WS solo: qué resuelve un DNI antes de encadenar deuda/facturas. */
export async function consultarCliente(call: OperationCaller, dni: string): Promise<ClienteOutcome> {
  const lookup = await lookupZzcs(call, dni);
  if (lookup.kind !== 'ok') return lookup;
  return { kind: 'ok', cliente: curarCliente(lookup.row) };
}
