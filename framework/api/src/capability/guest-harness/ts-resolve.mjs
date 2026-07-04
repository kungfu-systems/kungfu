// Dev-only ESM resolver hook: let Node's native TypeScript type-stripping run
// the capability SDK source unchanged. The SDK's internal imports carry explicit
// `.js` extensions (the ESM-TypeScript convention) or are extensionless; either
// way the file on disk is `.ts`, so remap a failed relative import accordingly.
import { registerHooks } from 'node:module';

registerHooks({
  resolve(specifier, context, next) {
    try {
      return next(specifier, context);
    } catch (err) {
      if (specifier.startsWith('.')) {
        // explicit `.js`/`.mjs` specifier whose source is a sibling `.ts`
        const remapped = specifier.replace(/\.m?js$/, '.ts');
        if (remapped !== specifier) {
          try {
            return next(remapped, context);
          } catch {}
        }
        // extensionless import
        if (!/\.[cm]?[jt]sx?$/.test(specifier)) {
          for (const ext of ['.ts', '.tsx', '/index.ts']) {
            try {
              return next(specifier + ext, context);
            } catch {}
          }
        }
      }
      throw err;
    }
  },
});
