// Reflection decoder for open-layer schemas. A kfx author compiles a `.fbs`
// into a `.bfbs` at runtime (`kungfu schema compile`) and registers it into a
// run; on this side there is no generated accessor for that schema, so events
// are decoded by walking the `.bfbs` reflection schema over the raw payload —
// the TS analogue of the core's Python BundleDecoder. Same fact, third surface:
// C++ and Python decode a registered kfx event by reflection, and so does the
// Electron inspector, with no per-schema codegen.
import * as flatbuffers from 'flatbuffers';
import {
  BaseType,
  Field,
  Object_,
  Schema,
} from './generated/reflection/reflection.js';

// (ByteBuffer reader, element width in bytes) per reflection scalar base type.
type Reader = (bb: flatbuffers.ByteBuffer, pos: number) => unknown;
const SCALARS: Partial<Record<BaseType, [Reader, number]>> = {
  [BaseType.Bool]: [(b, p) => b.readUint8(p) !== 0, 1],
  [BaseType.Byte]: [(b, p) => b.readInt8(p), 1],
  [BaseType.UByte]: [(b, p) => b.readUint8(p), 1],
  [BaseType.Short]: [(b, p) => b.readInt16(p), 2],
  [BaseType.UShort]: [(b, p) => b.readUint16(p), 2],
  [BaseType.Int]: [(b, p) => b.readInt32(p), 4],
  [BaseType.UInt]: [(b, p) => b.readUint32(p), 4],
  [BaseType.Long]: [(b, p) => b.readInt64(p), 8],
  [BaseType.ULong]: [(b, p) => b.readUint64(p), 8],
  [BaseType.Float]: [(b, p) => b.readFloat32(p), 4],
  [BaseType.Double]: [(b, p) => b.readFloat64(p), 8],
};

export class ReflectionDecoder {
  private readonly schema: Schema;

  constructor(bfbs: Uint8Array) {
    this.schema = Schema.getRootAsSchema(new flatbuffers.ByteBuffer(bfbs));
  }

  private object(name: string): Object_ {
    if (name === '') {
      const root = this.schema.rootTable();
      if (root) return root;
    }
    for (let i = 0; i < this.schema.objectsLength(); i++) {
      const o = this.schema.objects(i);
      const q = o?.name();
      if (o && q && (q === name || q.endsWith(`.${name}`))) return o;
    }
    throw new Error(`object '${name}' not found in schema`);
  }

  // Decode one payload against a bound table (default: the schema root_type).
  decode(payload: Uint8Array, objectName = ''): Record<string, unknown> {
    const obj = this.object(objectName);
    const bb = new flatbuffers.ByteBuffer(payload);
    const pos = bb.__indirect(bb.position());
    const out: Record<string, unknown> = {};
    for (let i = 0; i < obj.fieldsLength(); i++) {
      const f = obj.fields(i);
      if (f) out[f.name() ?? `f${i}`] = ReflectionDecoder.readField(bb, pos, f);
    }
    return out;
  }

  private static readField(
    bb: flatbuffers.ByteBuffer,
    pos: number,
    f: Field,
  ): unknown {
    const o = bb.__offset(pos, f.offset());
    const base = f.type()?.baseType();

    if (base === BaseType.String) return o ? bb.__string(pos + o) : null;

    if (base !== undefined && base in SCALARS) {
      const [read, _w] = SCALARS[base]!;
      return o ? read(bb, pos + o) : null;
    }

    if (base === BaseType.Vector) {
      if (!o) return [];
      const slot = pos + o;
      const elem = f.type()?.element();
      const start = bb.__vector(slot);
      const len = bb.__vector_len(slot);
      if (elem === BaseType.String) {
        return Array.from({ length: len }, (_, i) =>
          bb.__string(start + i * 4),
        );
      }
      if (elem !== undefined && elem in SCALARS) {
        const [read, w] = SCALARS[elem]!;
        return Array.from({ length: len }, (_, i) => read(bb, start + i * w));
      }
      return `<vector-elem:${elem}>`;
    }
    return `<base:${base}>`;
  }
}
