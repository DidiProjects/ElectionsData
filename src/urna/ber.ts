/** Minimal ASN.1 BER/DER reader: enough to walk the TSE ballot box report (BU). */

export type TagClass = 'universal' | 'application' | 'context' | 'private';

export interface BerNode {
  tagClass: TagClass;
  tag: number;
  constructed: boolean;
  /** Content octets (for constructed nodes, the encoded children). */
  value: Buffer;
  children: BerNode[];
}

export class BerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BerError';
  }
}

const CLASSES: TagClass[] = ['universal', 'application', 'context', 'private'];

export const UNIVERSAL = {
  integer: 2,
  octetString: 4,
  enumerated: 10,
  sequence: 16,
  generalString: 27,
} as const;

export function parseBer(buffer: Buffer, start = 0, end = buffer.length): BerNode[] {
  const nodes: BerNode[] = [];
  let offset = start;
  while (offset < end) {
    if (offset + 2 > end) throw new BerError(`truncated header at ${offset}`);
    const first = buffer[offset] as number;
    let tag = first & 0x1f;
    let p = offset + 1;
    if (tag === 0x1f) {
      tag = 0;
      let byte: number;
      do {
        if (p >= end) throw new BerError(`truncated tag at ${offset}`);
        byte = buffer[p++] as number;
        tag = (tag << 7) | (byte & 0x7f);
      } while (byte & 0x80);
    }
    if (p >= end) throw new BerError(`truncated length at ${offset}`);
    let length = buffer[p++] as number;
    if (length & 0x80) {
      const count = length & 0x7f;
      // Indefinite lengths (0x80) never appear in DER, which is what the TSE emits.
      if (count === 0 || count > 4) throw new BerError(`unsupported length encoding at ${offset}`);
      length = 0;
      for (let i = 0; i < count; i++) {
        if (p >= end) throw new BerError(`truncated length at ${offset}`);
        length = length * 256 + (buffer[p++] as number);
      }
    }
    const valueEnd = p + length;
    if (valueEnd > end) throw new BerError(`value overruns its container at ${offset}`);

    const constructed = (first & 0x20) !== 0;
    const value = buffer.subarray(p, valueEnd);
    nodes.push({
      tagClass: CLASSES[first >> 6] as TagClass,
      tag,
      constructed,
      value,
      children: constructed ? parseBer(buffer, p, valueEnd) : [],
    });
    offset = valueEnd;
  }
  return nodes;
}

export function readInteger(node: BerNode): number {
  if (node.value.length === 0 || node.value.length > 6) throw new BerError(`integer of ${node.value.length} bytes`);
  let value = 0;
  for (const byte of node.value) value = value * 256 + byte;
  // Two's complement: counts are never negative, but decode correctly anyway.
  if ((node.value[0] as number) & 0x80) value -= 2 ** (8 * node.value.length);
  return value;
}

export function readString(node: BerNode): string {
  return node.value.toString('latin1');
}

export const isUniversal = (node: BerNode | undefined, tag: number): node is BerNode =>
  node?.tagClass === 'universal' && node.tag === tag;

export const isContext = (node: BerNode | undefined, tag: number): node is BerNode =>
  node?.tagClass === 'context' && node.tag === tag;
