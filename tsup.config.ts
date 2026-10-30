import { defineConfig } from "tsup";

export default defineConfig({
  clean: true,
  dts: true,
  entry: ["src/index.ts", "src/node.ts"],
  format: ["esm", "cjs"],
  outExtension: ({ format }) => ({ js: format === "esm" ? ".mjs" : ".cjs" }),
  platform: "node",
  removeNodeProtocol: false,
  shims: false,
  sourcemap: true,
  splitting: false,
  target: "node22.13",
  treeshake: true,
});
