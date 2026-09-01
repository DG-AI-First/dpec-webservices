// Ruteo del server HTTP. GET /health, GET /api/deuda, GET /api/facturas,
// GET /api/cliente; cualquier otra cosa es 404 JSON. deuda/facturas aceptan
// dni o partner(/anlage) directos -- ver validateParams.ts. Aplica el
// deadline propio del server acá (no en flows/, que es puro y no conoce
// timers) -- ver config.ts DPEC_SERVER_DEADLINE_MS y docs/hallazgos-tecnicos.md.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { TransportError } from '../errors.js';
import {
  consultarCliente,
  consultarDeuda,
  consultarFacturas,
  type ClienteOutcome,
  type ConsultaOutcomeError,
  type DeudaOutcome,
  type FacturasOutcome,
  type OperationCaller,
} from '../flows/consultas.js';
import { mapOutcomeToHttpError, validateDni } from './mapOutcome.js';
import { resolveDeudaInput, resolveFacturasInput, resolveMax } from './validateParams.js';

export interface RouterDeps {
  readonly call: OperationCaller;
  readonly deadlineMs: number;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(payload);
}

type RaceResult<T> = { readonly kind: 'value'; readonly value: T } | { readonly kind: 'timeout' };

/**
 * Carrera contra el deadline propio del server. Si gana el timer, la promesa
 * original sigue viva en segundo plano y se ignora al resolver (no cuelga el
 * proceso: el .then de abajo maneja tanto éxito como rechazo tardío).
 */
function raceWithDeadline<T>(promise: Promise<T>, deadlineMs: number): Promise<RaceResult<T>> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve({ kind: 'timeout' });
    }, deadlineMs);

    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ kind: 'value', value });
      },
      (err: unknown) => {
        if (settled) return; // el timer ya ganó: no reventar el proceso con un rechazo tardío
        settled = true;
        clearTimeout(timer);
        reject(err as Error);
      },
    );
  });
}

function timeoutError(): ConsultaOutcomeError {
  return { kind: 'error', error: new TransportError('Server deadline exceeded before SAP responded.', 'timeout') };
}

async function resolveOutcome<T extends DeudaOutcome | FacturasOutcome | ClienteOutcome>(
  run: Promise<T>,
  deadlineMs: number,
): Promise<T | ConsultaOutcomeError> {
  const race = await raceWithDeadline(run, deadlineMs);
  return race.kind === 'timeout' ? timeoutError() : race.value;
}

async function handleDeuda(res: ServerResponse, deps: RouterDeps, url: URL): Promise<void> {
  const inputCheck = resolveDeudaInput(url.searchParams);
  if ('status' in inputCheck) return sendJson(res, inputCheck.status, inputCheck.body);
  const maxCheck = resolveMax(url.searchParams.get('max'), '10');
  if ('status' in maxCheck) return sendJson(res, maxCheck.status, maxCheck.body);

  const outcome = await resolveOutcome(
    consultarDeuda(deps.call, inputCheck.value, maxCheck.value),
    deps.deadlineMs,
  );
  if (outcome.kind === 'ok') {
    return sendJson(res, 200, { partner: outcome.partner, mensajes: outcome.mensajes, documentos: outcome.documentos });
  }
  const mapped = mapOutcomeToHttpError(outcome);
  return sendJson(res, mapped.status, mapped.body);
}

async function handleFacturas(res: ServerResponse, deps: RouterDeps, url: URL): Promise<void> {
  const inputCheck = resolveFacturasInput(url.searchParams);
  if ('status' in inputCheck) return sendJson(res, inputCheck.status, inputCheck.body);
  const maxCheck = resolveMax(url.searchParams.get('max'), '10');
  if ('status' in maxCheck) return sendJson(res, maxCheck.status, maxCheck.body);

  const outcome = await resolveOutcome(
    consultarFacturas(deps.call, inputCheck.value, maxCheck.value),
    deps.deadlineMs,
  );
  if (outcome.kind === 'ok') {
    return sendJson(res, 200, { partner: outcome.partner, mensajes: outcome.mensajes, facturas: outcome.facturas });
  }
  const mapped = mapOutcomeToHttpError(outcome);
  return sendJson(res, mapped.status, mapped.body);
}

async function handleCliente(res: ServerResponse, deps: RouterDeps, url: URL): Promise<void> {
  const dniCheck = validateDni(url.searchParams.get('dni'));
  if ('status' in dniCheck) return sendJson(res, dniCheck.status, dniCheck.body);

  const outcome = await resolveOutcome(consultarCliente(deps.call, dniCheck.dni), deps.deadlineMs);
  if (outcome.kind === 'ok') return sendJson(res, 200, outcome.cliente);
  const mapped = mapOutcomeToHttpError(outcome);
  return sendJson(res, mapped.status, mapped.body);
}

/** Crea el listener de node:http. Sin estado propio: toda dependencia entra por `deps`. */
export function createRequestListener(deps: RouterDeps) {
  return async function requestListener(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');

      if (req.method === 'GET' && url.pathname === '/health') {
        return sendJson(res, 200, { status: 'ok' });
      }
      if (req.method === 'GET' && url.pathname === '/api/deuda') {
        return await handleDeuda(res, deps, url);
      }
      if (req.method === 'GET' && url.pathname === '/api/facturas') {
        return await handleFacturas(res, deps, url);
      }
      if (req.method === 'GET' && url.pathname === '/api/cliente') {
        return await handleCliente(res, deps, url);
      }

      return sendJson(res, 404, { error: { codigo: 'RUTA_NO_ENCONTRADA', mensaje: 'Recurso no encontrado.' } });
    } catch {
      // Cualquier falla no clasificada (ej. invariante de config violado en
      // callOperationLive) -> 500 genérico. Nunca se filtra el detalle interno.
      return sendJson(res, 500, { error: { codigo: 'ERROR_INESPERADO', mensaje: 'Error interno del servidor.' } });
    }
  };
}
