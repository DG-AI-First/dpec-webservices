// Response parsing. See design §3 for the reasoning behind every parser flag.
//
// The single highest-value line here is `parseTagValue: false` — SAP document
// numbers (`exbel`) carry leading zeros and money fields (`totalAmnt`) are
// decimal strings; auto-parsing either would silently corrupt the evidence.

import { XMLParser, XMLValidator } from 'fast-xml-parser';
import type { XmlNode } from './types.js';
import { ParseError } from '../errors.js';

const LIST_ELEMENTS = new Set(['poDocumentos', 'poMensaje', 'tFact', 'item']);

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

/** Unwraps the `{ item: [...] }` RFC-table-serialization variant, otherwise passthrough. */
function unwrapItemContainer(value: unknown): unknown {
  if (value !== null && typeof value === 'object' && !Array.isArray(value) && 'item' in (value as Record<string, unknown>)) {
    return (value as Record<string, unknown>).item;
  }
  return value;
}

/**
 * Normalizes any SAP RFC table value into a real array, regardless of shape.
 *
 * This is defense #2 against the array-coercion trap (design §3(C)) — and it
 * has to do more than the design's original one-liner suggested, because of
 * an empirically-discovered gotcha: when an element name is in the parser's
 * `isArray` allowlist, fast-xml-parser coerces even a SELF-CLOSED element
 * into a ONE-ELEMENT array containing an empty-string sentinel (`['']`), not
 * an empty array. So this function must flatten sentinels *inside* arrays
 * too, not just handle a bare scalar sentinel — see test/parse.test.ts for
 * the full case table (undefined/''/{}/[''] all -> [], item-wrapped -> rows).
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
 * Parses raw response bytes into an XmlNode. Throws ParseError for anything
 * that isn't well-formed XML at all (empty body, plain text, mismatched
 * tags). Note: well-formed XML that isn't a valid SOAP envelope (an HTML
 * error page with matched tags, or SAP's proprietary <error> shape) passes
 * THIS check — that's caught one layer up, by findFault/unwrapBody failing
 * to locate an Envelope/Body structure.
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

function extractText(value: unknown): string {
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

/**
 * Looks for Envelope.Body.Fault (post-namespace-strip). Returns null — not
 * an error — when there is no fault; the caller decides what that means.
 */
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
 * SAP convention is `${operationName}Response`. If absent, falls back to the
 * single non-Fault key under Body and records the mismatch for meta.json —
 * an unverified naming convention should degrade into a recorded
 * observation, not a crash (design §3).
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
