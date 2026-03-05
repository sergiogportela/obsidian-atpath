import esbuild from "esbuild";

await esbuild.build({
  entryPoints: ["src/main.js"],
  bundle: true,
  external: ["obsidian", "@codemirror/view", "@codemirror/state", "electron"],
  format: "cjs",
  outfile: "main.js",
  platform: "node",
  minify: false,
});
