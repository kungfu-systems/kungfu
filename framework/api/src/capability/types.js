// Runtime shim for Node's native TypeScript transform in source-level fixtures.
// TypeScript resolves `./types.js` to `types.ts`; Node needs a real JS module.
export { bigintSafe, toSerializable } from './types.ts';
