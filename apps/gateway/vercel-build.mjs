// Runs only as the Vercel build command (apps/gateway/vercel.json). Vercel transpiles the function's own .ts
// files, but the workspace package @mir/shared exports "./src/index.ts" and its sources are not transpiled
// (and Node refuses to strip types inside node_modules). So on Vercel only, compile packages/shared/src to
// .js next to the sources and point the package export at it. This edits the copy being built on Vercel,
// never the repository (locally Node runs the .ts sources directly).
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import process from "node:process";
import { URL } from "node:url";
import ts from "typescript";

const root = new URL("../../packages/shared/", import.meta.url);
const srcDir = new URL("src/", root);

let compiled = 0;
for (const name of readdirSync(srcDir)) {
  if (!name.endsWith(".ts") || name.endsWith(".test.ts")) continue;
  const { outputText } = ts.transpileModule(readFileSync(new URL(name, srcDir), "utf8"), {
    compilerOptions: {
      target: ts.ScriptTarget.ES2023,
      module: ts.ModuleKind.ESNext,
      verbatimModuleSyntax: true,
      rewriteRelativeImportExtensions: true,
    },
    fileName: name,
  });
  writeFileSync(new URL(name.replace(/\.ts$/, ".js"), srcDir), outputText);
  compiled += 1;
}

const pkgFile = new URL("package.json", root);
const pkg = JSON.parse(readFileSync(pkgFile, "utf8"));
pkg.exports = { ".": "./src/index.js" };
writeFileSync(pkgFile, `${JSON.stringify(pkg, null, 2)}\n`);
process.stdout.write(`@mir/shared: compiled ${compiled} files, export -> ${pkg.exports["."]}\n`);
