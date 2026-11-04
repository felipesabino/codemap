#!/usr/bin/env node
// codemap: point it at a folder of JS/TS code, get one HTML page that maps it.
// Each folder is a node; edges are imports between folders; functions are listed per file.
//
//   node codemap.mjs ~/projects/some-app            # writes code-map.html and opens it
//   node codemap.mjs ~/projects/some-app -o map.html --depth 2 --tests --no-open
import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const HERE = path.dirname(fileURLToPath(import.meta.url));

// ---------- args
const argv = process.argv.slice(2);
const opt = { root: ".", out: null, depth: 0, tests: false, open: true };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "-o" || a === "--out") opt.out = argv[++i];
  else if (a === "--depth") opt.depth = +argv[++i];
  else if (a === "--tests") opt.tests = true;
  else if (a === "--no-open") opt.open = false;
  else if (a === "-h" || a === "--help") {
    console.log("usage: codemap <folder> [-o out.html] [--depth N] [--tests] [--no-open]\n" +
      "  --depth N   group folders to their first N path segments (0 = every folder)\n" +
      "  --tests     include *.test.* / *.spec.* / __tests__ files");
    process.exit(0);
  } else opt.root = a;
}
const ROOT = fs.realpathSync(path.resolve(opt.root));
const OUT = path.resolve(opt.out || "code-map.html");

const EXT = /\.(m|c)?(t|j)sx?$/;
const SKIP_DIRS = new Set(["node_modules", "dist", "build", "out", "coverage", "vendor", "bower_components", "storybook-static", "public"]);
const isConfig = n => /\.config\.[^.]+$/.test(n) || /^\.?[\w-]+rc\.(c|m)?js$/.test(n);
const isTest = p => /\.(test|spec|stories)\.[^.]+$/.test(p) || /(^|\/)(__tests__|__mocks__|tests?|e2e|cypress)\//.test(p);

// ---------- walk
const files = [];
(function walk(dir) {
  for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, d.name);
    if (d.isDirectory()) {
      if (d.name.startsWith(".") || SKIP_DIRS.has(d.name)) continue;
      walk(p);
    } else if (d.isFile() && EXT.test(d.name) && !d.name.endsWith(".d.ts") && !/\.min\.js$/.test(d.name) && !isConfig(d.name)) {
      const rel = path.relative(ROOT, p).split(path.sep).join("/");
      if (!opt.tests && isTest(rel)) continue;
      files.push(p);
    }
  }
})(ROOT);
if (!files.length) { console.error("codemap: no JS/TS files under " + ROOT); process.exit(1); }
const fileSet = new Set(files);

// ---------- module resolution: nearest tsconfig/jsconfig, falling back to bundler-style defaults
const cfgCache = new Map();
const baseOpts = { allowJs: true, moduleResolution: ts.ModuleResolutionKind.Bundler, module: ts.ModuleKind.ESNext, resolveJsonModule: false };
function optionsFor(file) {
  let dir = path.dirname(file);
  const seen = [];
  while (true) {
    if (cfgCache.has(dir)) break;
    seen.push(dir);
    const cand = ["tsconfig.json", "jsconfig.json"].map(n => path.join(dir, n)).find(f => fs.existsSync(f));
    if (cand) {
      let o = baseOpts;
      try {
        const raw = ts.readConfigFile(cand, ts.sys.readFile);
        const parsed = ts.parseJsonConfigFileContent(raw.config || {}, ts.sys, path.dirname(cand));
        o = { ...parsed.options, allowJs: true };
        if (!o.moduleResolution || o.moduleResolution === ts.ModuleResolutionKind.Classic) o.moduleResolution = ts.ModuleResolutionKind.Bundler;
      } catch {}
      cfgCache.set(dir, o);
      break;
    }
    if (dir === ROOT || dir === path.dirname(dir)) { cfgCache.set(dir, baseOpts); break; }
    dir = path.dirname(dir);
  }
  const o = cfgCache.get(dir);
  for (const s of seen) cfgCache.set(s, o);
  return o;
}
const resCache = new Map();
function resolve(spec, from) {
  const options = optionsFor(from);
  const key = path.dirname(from) + "\0" + spec;
  if (resCache.has(key)) return resCache.get(key);
  let out = null;
  try {
    const r = ts.resolveModuleName(spec, from, options, ts.sys).resolvedModule;
    if (r) {
      let f = r.resolvedFileName;
      try { f = fs.realpathSync(f); } catch {}
      // a .d.ts next to the real source: try the source
      if (f.endsWith(".d.ts")) for (const e of [".ts", ".tsx", ".js", ".jsx"]) { const s = f.slice(0, -5) + e; if (fileSet.has(s)) { f = s; break; } }
      if (fileSet.has(f)) out = { internal: f };
      else if (!f.startsWith(ROOT + path.sep) || f.includes("/node_modules/")) out = { external: pkgName(spec) };
    }
  } catch {}
  if (!out && !spec.startsWith(".") && !spec.startsWith("/")) out = { external: pkgName(spec) };
  resCache.set(key, out);
  return out;
}
const pkgName = s => s.startsWith("node:") ? s : s.startsWith("@") ? s.split("/").slice(0, 2).join("/") : s.split("/")[0];

// ---------- grouping
const relDir = f => { const d = path.relative(ROOT, path.dirname(f)).split(path.sep).join("/"); return d || "."; };
const group = f => { const d = relDir(f); return opt.depth > 0 && d !== "." ? d.split("/").slice(0, opt.depth).join("/") : d; };

// ---------- parse
const firstSentence = s => {
  s = String(s || "").replace(/\s+/g, " ").trim();
  const i = s.indexOf(". ");
  if (i > 0) s = s.slice(0, i + 1);
  return s.length > 160 ? s.slice(0, 157) + "…" : s;
};
const jsdoc = node => {
  const d = node.jsDoc?.[0];
  return d ? firstSentence(typeof d.comment === "string" ? d.comment : ts.getTextOfJSDocComment(d.comment)) : "";
};
const hasMod = (n, k) => !!n.modifiers?.some(m => m.kind === k);
const isFnInit = n => n && (ts.isArrowFunction(n) || ts.isFunctionExpression(n) ||
  // memo(() => ...), forwardRef(function X() {}), useCallback(...)
  (ts.isCallExpression(n) && n.arguments.some(a => ts.isArrowFunction(a) || ts.isFunctionExpression(a))));

const groups = new Map(); // dir -> {path, files, imports:Set, ext:Set}
let totalLines = 0;
for (const file of files) {
  const text = fs.readFileSync(file, "utf8");
  const kind = /\.tsx$|\.jsx$/.test(file) ? ts.ScriptKind.TSX : /\.(m|c)?ts$/.test(file) ? ts.ScriptKind.TS : ts.ScriptKind.JSX;
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);
  const lineOf = pos => sf.getLineAndCharacterOfPosition(pos).line + 1;
  const g = group(file);
  if (!groups.has(g)) groups.set(g, { path: g, files: [], imports: new Set(), ext: new Set(), cnt: {} });
  const G = groups.get(g);

  const specs = [];
  const exported = new Set();
  const funcs = [];
  const add = (name, node, recv, isExp, docNode) => {
    const l = lineOf(node.getStart(sf));
    funcs.push({ n: name, r: recv || undefined, l, s: lineOf(node.end) - l + 1, e: isExp || undefined, d: jsdoc(docNode || node) || undefined });
  };

  for (const st of sf.statements) {
    const exp = hasMod(st, ts.SyntaxKind.ExportKeyword);
    if (ts.isFunctionDeclaration(st)) add(st.name?.text || "default", st, null, exp);
    else if (ts.isClassDeclaration(st)) {
      const cn = st.name?.text || "default";
      for (const m of st.members) {
        if ((ts.isMethodDeclaration(m) || ts.isGetAccessor(m) || ts.isSetAccessor(m) || ts.isConstructorDeclaration(m)) && m.body) {
          const nm = ts.isConstructorDeclaration(m) ? "constructor" : m.name?.getText(sf) || "?";
          add(nm, m, cn, exp && !hasMod(m, ts.SyntaxKind.PrivateKeyword) && !nm.startsWith("#"));
        } else if (ts.isPropertyDeclaration(m) && isFnInit(m.initializer)) {
          add(m.name.getText(sf), m, cn, exp && !hasMod(m, ts.SyntaxKind.PrivateKeyword));
        }
      }
    } else if (ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) {
        if (ts.isIdentifier(d.name) && isFnInit(d.initializer)) add(d.name.text, d, null, exp, st);
        else if (ts.isIdentifier(d.name) && d.initializer && ts.isObjectLiteralExpression(d.initializer)) {
          // const api = { get() {}, post: () => {} }
          for (const p of d.initializer.properties) {
            if (ts.isMethodDeclaration(p) || (ts.isPropertyAssignment(p) && isFnInit(p.initializer)))
              add(p.name.getText(sf), p, d.name.text, exp);
          }
        }
      }
    } else if (ts.isExportAssignment(st) && isFnInit(st.expression)) add("default", st, null, true);
    else if (ts.isExportDeclaration(st) && st.exportClause && ts.isNamedExports(st.exportClause) && !st.moduleSpecifier)
      for (const e of st.exportClause.elements) exported.add((e.propertyName || e.name).text);
    else if (ts.isExpressionStatement(st) && ts.isBinaryExpression(st.expression)) {
      // module.exports.foo = function () {} / exports.foo = () => {}
      const { left, right } = st.expression;
      if (ts.isPropertyAccessExpression(left) && /^(module\.)?exports$/.test(left.expression.getText(sf)) && isFnInit(right))
        add(left.name.text, st, null, true);
    }
  }
  for (const f of funcs) if (exported.has(f.n) && !f.r) f.e = true;

  (function visit(n) {
    if ((ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) && n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier)) {
      if (!n.importClause?.isTypeOnly && !n.isTypeOnly) specs.push(n.moduleSpecifier.text);
    } else if (ts.isCallExpression(n) && n.arguments.length === 1 && ts.isStringLiteralLike(n.arguments[0]) &&
      (n.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(n.expression) && n.expression.text === "require"))) {
      specs.push(n.arguments[0].text);
    } else if (ts.isImportEqualsDeclaration(n) && ts.isExternalModuleReference(n.moduleReference) && ts.isStringLiteral(n.moduleReference.expression)) {
      specs.push(n.moduleReference.expression.text);
    }
    ts.forEachChild(n, visit);
  })(sf);

  for (const s of specs) {
    const r = resolve(s, file);
    if (r?.internal) { const t = group(r.internal); if (t !== g) { G.imports.add(t); G.cnt[t] = (G.cnt[t] || 0) + 1; } }
    else if (r?.external) G.ext.add(r.external);
  }
  const lines = sf.getLineStarts().length;
  totalLines += lines;
  const name = opt.depth > 0 ? path.relative(path.join(ROOT, g), file).split(path.sep).join("/") : path.basename(file);
  G.files.push({ name, rel: path.relative(ROOT, file).split(path.sep).join("/"), lines, funcs });
}

// ---------- output
const pkgs = [...groups.values()].sort((a, b) => a.path.localeCompare(b.path)).map(g => ({
  path: g.path, imports: [...g.imports].sort(), weights: g.cnt, ext: [...g.ext].sort(),
  files: g.files.sort((a, b) => a.name.localeCompare(b.name)),
}));

let name = path.basename(ROOT), rev = "", source = "";
try { name = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).name || name; } catch {}
const git = (...a) => execFileSync("git", ["-C", ROOT, ...a], { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
try {
  rev = git("rev-parse", "--short", "HEAD");
  const remote = git("remote", "get-url", "origin");
  const m = remote.match(/github\.com[:/]([^/]+)\/(.+?)(\.git)?$/);
  if (m) source = `https://github.com/${m[1]}/${m[2]}/blob/${git("rev-parse", "HEAD")}/${git("rev-parse", "--show-prefix")}`;
} catch {}

const data = { name, root: ROOT, rev, source, depth: opt.depth, lines: totalLines, pkgs };
const tpl = fs.readFileSync(path.join(HERE, "template.html"), "utf8");
const json = JSON.stringify(data).replace(/</g, "\\u003c");
const esc = s => s.replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
fs.writeFileSync(OUT, tpl.replaceAll("{{NAME}}", esc(name)).replace("/*{{DATA}}*/", () => json));
const nfn = pkgs.reduce((a, p) => a + p.files.reduce((b, f) => b + f.funcs.length, 0), 0);
console.log(`wrote ${OUT}: ${pkgs.length} folders, ${files.length} files, ${nfn} functions, ${totalLines} lines`);
if (pkgs.length > 60 && !opt.depth) console.log(`tip: ${pkgs.length} folders is a lot to draw; try --depth 2, 3 or 4 to group them`);
if (opt.open && process.stdout.isTTY) spawn(process.platform === "darwin" ? "open" : "xdg-open", [OUT], { detached: true, stdio: "ignore" }).unref();
