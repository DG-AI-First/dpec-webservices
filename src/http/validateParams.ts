// Validación de query params de /api/deuda y /api/facturas: cada uno acepta
// el DNI (dispara la resolución ZZCS) o los identificadores SAP directos
// (partner/anlage), nunca ambos. PARAMETROS_INVALIDOS es el código genérico
// para cualquier combinación ambigua o malformada que no sea específicamente
// un dni inválido (eso sigue siendo DNI_INVALIDO, ver mapOutcome.ts).

import type { DeudaInput, FacturasInput } from '../flows/consultas.js';
import { validateDni, type HttpErrorResponse } from './mapOutcome.js';

function invalid(mensaje: string): HttpErrorResponse {
  return { status: 400, body: { error: { codigo: 'PARAMETROS_INVALIDOS', mensaje } } };
}

// Entero positivo en base 10, sin signo ni decimales -- para ?max=.
const POSITIVE_INT = /^[1-9]\d*$/;
// Identificador SAP (partner/anlage): sólo dígitos. Nunca se parsea a
// number -- los ceros a la izquierda son significativos.
const NUMERIC_ID = /^\d+$/;

type Ok<T> = { readonly ok: true; readonly value: T };

function numericId(raw: string): string | null {
  const trimmed = raw.trim();
  return NUMERIC_ID.test(trimmed) ? trimmed : null;
}

/** ?max=<n> -> PiNumMax / ICantfact. Ausente o vacío usa `fallback`. */
export function resolveMax(raw: string | null, fallback: string): HttpErrorResponse | Ok<string> {
  if (raw === null || raw.trim() === '') return { ok: true, value: fallback };
  const trimmed = raw.trim();
  if (!POSITIVE_INT.test(trimmed)) {
    return invalid('El parámetro max debe ser un entero positivo.');
  }
  return { ok: true, value: trimmed };
}

/** /api/deuda: dni o partner, nunca ambos, nunca ninguno. */
export function resolveDeudaInput(params: URLSearchParams): HttpErrorResponse | Ok<DeudaInput> {
  const dniRaw = params.get('dni');
  const partnerRaw = params.get('partner');

  if (dniRaw !== null && partnerRaw !== null) {
    return invalid('No se puede enviar dni y partner al mismo tiempo.');
  }
  if (dniRaw === null && partnerRaw === null) {
    return invalid('Se requiere el parámetro dni o partner.');
  }

  if (dniRaw !== null) {
    const dniCheck = validateDni(dniRaw);
    if ('status' in dniCheck) return dniCheck;
    return { ok: true, value: { kind: 'dni', dni: dniCheck.dni } };
  }

  const partner = numericId(partnerRaw as string);
  if (partner === null) return invalid('El parámetro partner debe ser numérico.');
  return { ok: true, value: { kind: 'partner', partner } };
}

/** /api/facturas: dni, o partner+anlage juntos -- nunca dni+partner, nunca uno solo de partner/anlage. */
export function resolveFacturasInput(params: URLSearchParams): HttpErrorResponse | Ok<FacturasInput> {
  const dniRaw = params.get('dni');
  const partnerRaw = params.get('partner');
  const anlageRaw = params.get('anlage');

  if (dniRaw !== null && partnerRaw !== null) {
    return invalid('No se puede enviar dni y partner al mismo tiempo.');
  }
  if (dniRaw === null && partnerRaw === null) {
    return invalid('Se requiere el parámetro dni, o partner junto con anlage.');
  }

  if (dniRaw !== null) {
    const dniCheck = validateDni(dniRaw);
    if ('status' in dniCheck) return dniCheck;
    return { ok: true, value: { kind: 'dni', dni: dniCheck.dni } };
  }

  if (anlageRaw === null) {
    return invalid('El parámetro anlage es obligatorio junto con partner.');
  }
  const partner = numericId(partnerRaw as string);
  const anlage = numericId(anlageRaw);
  if (partner === null || anlage === null) {
    return invalid('Los parámetros partner y anlage deben ser numéricos.');
  }
  return { ok: true, value: { kind: 'partner', partner, anlage } };
}
