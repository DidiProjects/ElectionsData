import { describe, expect, it } from 'vitest';
import { BerError, isContext, isUniversal, parseBer, readInteger, readString, UNIVERSAL } from '../../src/urna/ber.js';
import { der, tlv } from '../helpers.js';

describe('parseBer', () => {
  it('parses nested sequences, integers and strings', () => {
    const [root] = parseBer(der.seq(der.int(5), der.seq(der.str('abc')), der.ctxInt(2, 99)));
    expect(root?.constructed).toBe(true);
    expect(isUniversal(root, UNIVERSAL.sequence)).toBe(true);
    const [num, inner, ctx] = root?.children ?? [];
    expect(readInteger(num!)).toBe(5);
    expect(readString(inner!.children[0]!)).toBe('abc');
    expect(isContext(ctx, 2)).toBe(true);
    expect(readInteger(ctx!)).toBe(99);
  });

  it('reads long-form lengths', () => {
    const big = Buffer.alloc(300, 0x41);
    const [node] = parseBer(der.octets(big));
    expect(node?.value.length).toBe(300);
  });

  it('reads high tag numbers', () => {
    const [node] = parseBer(Buffer.from([0x9f, 0x81, 0x01, 0x01, 0x07]));
    expect(node).toMatchObject({ tagClass: 'context', tag: 129 });
    expect(readInteger(node!)).toBe(7);
  });

  it('parses consecutive top-level nodes', () => {
    expect(parseBer(Buffer.concat([der.int(1), der.int(2)])).map(readInteger)).toEqual([1, 2]);
  });

  it.each([
    ['a truncated header', Buffer.from([0x02])],
    ['a truncated long tag', Buffer.from([0x1f, 0x81])],
    ['a missing length', Buffer.from([0x1f, 0x01])],
    ['an indefinite length', Buffer.from([0x30, 0x80, 0x00, 0x00])],
    ['a truncated long length', Buffer.from([0x04, 0x82, 0x01])],
    ['a value past its container', Buffer.from([0x04, 0x05, 0x00])],
  ])('rejects %s', (_label, buffer) => {
    expect(() => parseBer(buffer)).toThrow(BerError);
  });
});

describe('readInteger', () => {
  it('decodes multi-byte and negative values', () => {
    expect(readInteger(parseBer(der.int(70000))[0]!)).toBe(70000);
    expect(readInteger(parseBer(tlv(0x02, Buffer.from([0xff])))[0]!)).toBe(-1);
  });

  it('rejects empty or oversized integers', () => {
    expect(() => readInteger(parseBer(tlv(0x02, Buffer.alloc(0)))[0]!)).toThrow(BerError);
    expect(() => readInteger(parseBer(tlv(0x02, Buffer.alloc(7, 1)))[0]!)).toThrow(BerError);
  });
});
