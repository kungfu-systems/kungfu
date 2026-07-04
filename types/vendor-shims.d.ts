// Ambient shims for third-party build/tooling deps that ship no type
// declarations, so `pnpm run check:types` resolves them (as untyped `any`)
// instead of failing on TS7016. Keep this list minimal — prefer real @types.

declare module 'sywac';
