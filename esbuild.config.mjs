import esbuild from "esbuild";

const worker = await esbuild.build({
  entryPoints: ["src/token-worker.js"],
  bundle: true,
  write: false,
  platform: "browser",
  format: "iife",
  minify: true,
});

await esbuild.build({
  entryPoints: ["src/main.js"],
  bundle: true,
  external: ["obsidian", "@codemirror/view", "@codemirror/state", "electron"],
  format: "cjs",
  outfile: "main.js",
  platform: "node",
  minify: false,
  define: { ATPATH_TOKEN_WORKER_SOURCE: JSON.stringify(worker.outputFiles[0].text) },
});
