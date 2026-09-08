import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    cli: 'src/cli/main.ts',
  },
  format: ['esm'],
  target: 'node20',
  sourcemap: true,
  clean: true,
  dts: true, // emit dist/index.d.ts + dist/cli.d.ts — DEC-9 (library types are a shipped contract)
  banner: { js: '#!/usr/bin/env node' },
});
