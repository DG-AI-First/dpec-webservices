// Tabla de status HTTP para el server, sobre los mismos outcomes/UpstreamError
// ya clasificados en errors.ts.

import { BusinessError, UpstreamError } from '../errors.js';
import type { ConsultaOutcomeError } from '../flows/consultaPorDni.js';

export interface HttpErrorResponse {
  readonly status: number;
  readonly body: { readonly error: { readonly codigo: string; readonly mensaje: string } };
}

function errorResponse(status: number, codigo: string, mensaje: string): HttpErrorResponse {
  return { status, body: { error: { codigo, mensaje } } };
}

/**
 * auth-rejected nunca expone status/detalle upstream: el mensaje es genérico
 * a propósito, ver house rule "never log/leak credentials".
 */
function mapUpstreamError(error: UpstreamError): HttpErrorResponse {
  if (error instanceof BusinessError) {
    // Defensivo: en el diseño actual un business-error del segundo call llega
    // como outcome 'error-negocio', no como excepción. Se mapea igual por si acaso.
    return errorResponse(409, error.code, error.text);
  }
  switch (error.kind) {
    case 'timeout':
      return errorResponse(504, 'TIMEOUT', 'SAP no respondió dentro del plazo esperado.');
    case 'auth-rejected':
      return errorResponse(502, 'AUTH_RECHAZADO', 'El servicio upstream rechazó la autenticación.');
    case 'soap-fault':
      return errorResponse(502, 'SOAP_FAULT', 'SAP devolvió un fault SOAP.');
    case 'config-missing':
    case 'config-invalid':
      return errorResponse(500, 'CONFIG_ERROR', 'Error de configuración del servidor.');
    default:
      // network, dns, tls, http-error, malformed-response
      return errorResponse(502, 'TRANSPORTE', 'Fallo de transporte hacia SAP.');
  }
}

/** Mapea un outcome no-ok de cualquiera de los dos flows a status + body HTTP. */
export function mapOutcomeToHttpError(outcome: ConsultaOutcomeError): HttpErrorResponse {
  switch (outcome.kind) {
    case 'no-encontrado':
      return errorResponse(404, 'NO_ENCONTRADO', 'No se encontró un interlocutor comercial para el DNI informado.');
    case 'zzcs-rechazado':
      return errorResponse(502, outcome.ouResultado, 'SAP rechazó la consulta del DNI (OU_RESULTADO no exitoso).');
    case 'error-negocio':
      return errorResponse(409, outcome.codigo, outcome.mensaje);
    case 'error':
      return mapUpstreamError(outcome.error);
  }
}

type DniOk = { readonly ok: true; readonly dni: string };

/** 400 para dni ausente/vacío/no numérico. Validación previa a invocar cualquier flow. */
export function validateDni(raw: string | null): HttpErrorResponse | DniOk {
  const dni = (raw ?? '').trim();
  if (dni === '' || !/^\d+$/.test(dni)) {
    return errorResponse(400, 'DNI_INVALIDO', 'El parámetro dni es obligatorio y debe ser numérico.');
  }
  return { ok: true, dni };
}
