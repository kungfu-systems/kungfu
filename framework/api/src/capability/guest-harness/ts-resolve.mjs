// Dev-only ESM resolver hook: let Node's native TypeScript type-stripping run
// the capability SDK source unchanged. The package's internal imports are
// extensionless (they are bundled by consumers, not run directly by Node), so
// append the TypeScript extension when a bare relative import does not resolve.
import { registerHooks } from 'node:module';

registerHooks({
  resolve(specifier, context, next) {
    try {
      return next(specifier, context);
    } catch (err) {
      if (specifier.startsWith('.') && !/\.[cm]?[jt]sx?$/.test(specifier)) {
        for (const ext of ['.ts', '.tsx', '/index.ts']) {
          try {
            return next(specifier + ext, context);
          } catch {}
        }
      }
      throw err;
    }
  },
});
