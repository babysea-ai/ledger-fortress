import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'src/stripe.ts'],
  format: ['cjs', 'esm'],
  dts: true,
  clean: true,
  splitting: true,
});
