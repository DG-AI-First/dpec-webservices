// Parseo de la respuesta SOAP. parseTagValue: false es la clave: exbel y
// totalAmnt deben quedar string (ceros a la izquierda, decimales); parsear
// automático los corrompería.

import { XMLParser, XMLValidator } from 'fast-xml-parser';
import type { XmlNode } from './types.js';
import { ParseError } from '../errors.js';

// Nombres del cable, PascalCase, tomados de los WSDL en test/fixtures/.
// removeNSPrefix no cambia mayúsculas: una entrada en camelCase no matchea
// nada y la tabla completa se lee vacía sin error visible.
const LIST_ELEMENTS = new Set(['PoDocumentos', 'PoMensaje', 'TFact', 'item']);

export const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  removeNSPrefix: true,
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
  isArray: (name) => LIST_ELEMENTS.has(name),
});

function isEmptySentinel(value: unknown): boolean {
  if (value === undefined || value === null || value === '') return true;
  return (
    typeof value === 'object' && !Array.isArray(value) && Object.keys(value as object).length === 0
  );
}

/** Desenvuelve la variante `{ item: [...] }` de tabla RFC; si no aplica, pasa igual. */
function unwrapItemContainer(value: unknown): unknown {
  if (value !== null && typeof value === 'object' && !Array.isArray(value) && 'item' in (value as Record<string, unknown>)) {
    return (value as Record<string, unknown>).item;
  }
  return value;
}

/**
 * Normaliza cualquier valor de tabla RFC a un array real. fast-xml-parser
 * coerciona un elemento auto-cerrado en el allowlist isArray a `['']` en vez
 * de `[]`, así que hay que aplanar sentinels también dentro de arrays.
 * Detalle: docs/hallazgos-tecnicos.md#la-trampa-de-coercion-de-arrays-array-coercion-trap
 */
export function toArray<T>(value: unknown): T[] {
  if (isEmptySentinel(value)) return [];

  const unwrapped = unwrapItemContainer(value);

  if (Array.isArray(unwrapped)) {
    const rows: T[] = [];
    for (const entry of unwrapped) {
      if (isEmptySentinel(entry)) continue;
      const innerUnwrapped = unwrapItemContainer(entry);
      if (Array.isArray(innerUnwrapped)) {
        for (const inner of innerUnwrapped) {
          if (!isEmptySentinel(inner)) rows.push(inner as T);
        }
      } else if (!isEmptySentinel(innerUnwrapped)) {
        rows.push(innerUnwrapped as T);
      }
    }
    return rows;
  }

  return isEmptySentinel(unwrapped) ? [] : [unwrapped as T];
}

/**
 * Parsea bytes crudos a XmlNode. Lanza ParseError sólo si no es XML bien
 * formado. XML válido pero no-SOAP (página de error HTML, `<error>` propio
 * de SAP) pasa este chequeo; lo detectan findFault/unwrapBody después.
 */
export function parseXml(raw: string): XmlNode {
  const validation = XMLValidator.validate(raw);
  if (validation !== true) {
    throw new ParseError(`Response body is not well-formed XML: ${validation.err.msg}`);
  }

  const result = parser.parse(raw) as unknown;
  if (result === null || typeof result !== 'object') {
    throw new ParseError('Response body parsed to an unexpected (non-object) shape.');
  }

  return result as XmlNode;
}

/**
 * Convierte un valor de campo parseado a string plano. Un campo con
 * atributos (ej. `faultstring xml:lang="es"`) parsea como
 * `{ '#text': ..., '@_...': ... }` en vez de string simple.
 */
export function extractText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value !== null && typeof value === 'object' && '#text' in (value as Record<string, unknown>)) {
    return String((value as Record<string, unknown>)['#text']);
  }
  return value === undefined || value === null ? '' : String(value);
}

export interface SoapFault {
  readonly faultCode: string;
  readonly faultString: string;
}

/** Busca Envelope.Body.Fault (después de sacar el namespace). null si no hay fault. */
export function findFault(node: XmlNode): SoapFault | null {
  const envelope = node.Envelope as XmlNode | undefined;
  const body = envelope && typeof envelope === 'object' ? (envelope.Body as XmlNode | undefined) : undefined;
  const fault = body && typeof body === 'object' ? (body.Fault as XmlNode | undefined) : undefined;
  if (!fault || typeof fault !== 'object') return null;

  return {
    faultCode: extractText(fault.faultcode),
    faultString: extractText(fault.faultstring),
  };
}

export interface UnwrapResult {
  readonly node: XmlNode;
  readonly responseElementMismatch?: string;
}

/**
 * SAP nombra la respuesta `${operationName}Response`. Si no está, cae a la
 * única clave no-Fault bajo Body y registra el mismatch en meta.json en vez
 * de fallar.
 */
export function unwrapBody(node: XmlNode, operationName: string): UnwrapResult {
  const envelope = node.Envelope as XmlNode | undefined;
  const body = envelope && typeof envelope === 'object' ? (envelope.Body as XmlNode | undefined) : undefined;

  if (!body || typeof body !== 'object') {
    throw new ParseError(
      'Response has no usable SOAP Envelope/Body — not a SOAP response ' +
        '(a valid-XML, non-SOAP body such as an HTML error page or a SAP proprietary ' +
        '<error> element will parse successfully but fail here).',
    );
  }

  const expectedKey = `${operationName}Response`;
  if (Object.hasOwn(body, expectedKey)) {
    return { node: body[expectedKey] as XmlNode };
  }

  const keys = Object.keys(body).filter((key) => key !== 'Fault');
  if (keys.length === 1) {
    return { node: body[keys[0]] as XmlNode, responseElementMismatch: keys[0] };
  }

  throw new ParseError(`Could not locate a response element under SOAP Body (expected "${expectedKey}").`);
}
