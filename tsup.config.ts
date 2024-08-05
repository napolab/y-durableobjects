import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  sourcemap: true,
  dts: {
    banner: '/// <reference types="@cloudflare/workers-types" />',
  },
  splitting: true,
  clean: true,
  format: ["cjs", "esm"],
  external: ["hono", /cloudflare:/],
});
