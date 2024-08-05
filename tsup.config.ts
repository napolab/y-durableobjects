import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    "helpers/upgrade": "src/middleware/upgrade/index.ts",
  },
  sourcemap: true,
  dts: {
    banner: '/// <reference types="@cloudflare/workers-types" />',
  },
  splitting: true,
  clean: true,
  format: ["cjs", "esm"],
  external: ["hono", /cloudflare:/],
});
