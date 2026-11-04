#!/usr/bin/env node
// codemap: point it at a folder of JS/TS code, get one HTML page that maps it.
// Each folder is a node; edges are imports between folders; functions are listed per file.
//
//   node codemap.mjs ~/projects/some-app            # writes code-map.html and opens it
//   node codemap.mjs ~/projects/some-app -o map.html --depth 2 --tests --no-open
//   node codemap.mjs github.com/owner/repo           # or owner/repo, or .../tree/<branch>/<subfolder>
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const HERE = path.dirname(fileURLToPath(import.meta.url));

// ---------- args
const argv = process.argv.slice(2);
const opt = { root: ".", out: null, depth: 0, tests: false, open: true, meta: null, back: null };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "-o" || a === "--out") opt.out = argv[++i];
  else if (a === "--depth") { const v = argv[++i]; opt.depth = v === "auto" ? "auto" : +v; }
  else if (a === "--meta") opt.meta = argv[++i];
  else if (a === "--back") opt.back = argv[++i];
  else if (a === "--tests") opt.tests = true;
  else if (a === "--no-open") opt.open = false;
  else if (a === "-h" || a === "--help") {
    console.log("usage: codemap <folder | github URL | owner/repo> [-o out.html] [--depth N] [--tests] [--no-open]\n" +
      "  --depth N   group folders to their first N path segments (0 = every folder, auto = aim for <= 40 boxes)\n" +
      "  --meta F    also write a JSON summary (source, commit, stats) to F\n" +
      "  --back URL  add a \"← all code maps\" link to the page header\n" +
      "  --tests     include *.test.* / *.spec.* / __tests__ files");
    process.exit(0);
  } else opt.root = a;
}
// ---------- source: a local folder, or a GitHub repo (shallow-cloned into a temp cache)
// accepts https://github.com/o/r, github.com/o/r, git@github.com:o/r.git, o/r, and .../tree/<ref>/<sub/path>
function githubSource(s) {
  if (fs.existsSync(s)) return null;
  const m = s.match(/^(?:https?:\/\/)?(?:www\.)?github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:\/(?:tree|blob)\/([^/]+)(?:\/(.*))?)?\/?$/) ||
    s.match(/^(?:git@github\.com:)([\w.-]+)\/([\w.-]+?)(?:\.git)?$/) ||
    s.match(/^([\w.-]+)\/([\w.-]+)$/);
  return m ? { owner: m[1], repo: m[2], ref: m[3] || "", sub: (m[4] || "").replace(/\/$/, "") } : null;
}
let gh = githubSource(opt.root);
if (gh) {
  const dir = path.join(os.tmpdir(), "codemap", `${gh.owner}__${gh.repo}${gh.ref ? "__" + gh.ref.replace(/[^\w.-]/g, "_") : ""}`);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  const url = `https://github.com/${gh.owner}/${gh.repo}.git`;
  console.log(`cloning ${url}${gh.ref ? " @ " + gh.ref : ""} …`);
  try {
    execFileSync("git", ["clone", "--depth", "1", "--single-branch", ...(gh.ref ? ["--branch", gh.ref] : []), url, dir], { stdio: ["ignore", "ignore", "inherit"] });
  } catch { console.error(`codemap: could not clone ${url} (private repo, typo, or no network?)`); process.exit(1); }
  opt.root = path.join(dir, gh.sub);
  if (!fs.existsSync(opt.root)) { console.error(`codemap: ${gh.sub} not found in ${gh.owner}/${gh.repo}`); process.exit(1); }
}
const ROOT = fs.realpathSync(path.resolve(opt.root));
const OUT = path.resolve(opt.out || (gh ? `code-map-${gh.repo}.html` : "code-map.html"));

const EXT = /\.(m|c)?(t|j)sx?$/;
const SKIP_DIRS = new Set(["node_modules", "dist", "build", "out", "coverage", "vendor", "bower_components", "storybook-static", "public"]);
const isConfig = n => /\.config\.[^.]+$/.test(n) || /^\.?[\w-]+rc\.(c|m)?js$/.test(n);
const isTest = p => /\.(test|spec|stories)\.[^.]+$/.test(p) || /(^|\/)(__tests__|__mocks__|tests?|e2e|cypress)\//.test(p);

// ---------- walk
const files = [];
const workspaces = new Map(); // package name -> {dir, json}: lets "@scope/pkg" imports resolve without node_modules
(function walk(dir) {
  for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, d.name);
    if (d.isDirectory()) {
      if (d.name.startsWith(".") || SKIP_DIRS.has(d.name)) continue;
      walk(p);
    } else if (d.name === "package.json") {
      try { const j = JSON.parse(fs.readFileSync(p, "utf8")); if (j.name) workspaces.set(j.name, { dir, json: j }); } catch {}
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
  // a workspace package of this repo is never "npm", even when the target is a skipped (test) file
  if (!out?.internal && workspaces.has(pkgName(spec))) { const f = workspaceFile(spec); out = f ? { internal: f } : { skipped: true }; }
  if (!out && !spec.startsWith(".") && !spec.startsWith("/")) out = { external: pkgName(spec) };
  resCache.set(key, out);
  return out;
}
// "@scope/pkg/sub" -> a source file inside that workspace package, trying its entry fields and dist/ -> src/
function workspaceFile(spec) {
  const name = pkgName(spec), { dir, json } = workspaces.get(name);
  const sub = spec.slice(name.length).replace(/^\//, "");
  const strings = v => typeof v === "string" ? [v] : v && typeof v === "object" ? Object.values(v).flatMap(strings) : [];
  const entries = sub ? [...strings(json.exports?.["./" + sub]), sub, "src/" + sub] :
    [json.source, ...strings(json.exports?.["."] ?? (typeof json.exports === "string" ? json.exports : null)), json.module, json.main, json.types, "src/index", "index"].filter(Boolean);
  const cands = entries.flatMap(e => { const c = e.replace(/^\.\//, ""); const noExt = c.replace(/\.(d\.[cm]?ts|[cm]?[jt]sx?)$/, ""); return [c, noExt, noExt.replace(/^(dist|lib|build|out|esm|cjs)\//, "src/")]; });
  for (const c of new Set(cands)) {
    const r = ts.resolveModuleName("./" + c, path.join(dir, "__codemap.ts"), baseOpts, ts.sys).resolvedModule;
    if (r) { let f = r.resolvedFileName; try { f = fs.realpathSync(f); } catch {} if (fileSet.has(f)) return f; }
  }
  return null;
}
const pkgName = s => s.startsWith("node:") ? s : s.startsWith("@") ? s.split("/").slice(0, 2).join("/") : s.split("/")[0];

// ---------- grouping
const relDir = f => { const d = path.relative(ROOT, path.dirname(f)).split(path.sep).join("/"); return d || "."; };
if (opt.depth === "auto") {
  const dirs = [...new Set(files.map(relDir))];
  opt.depth = 0;
  if (dirs.length > 60) for (let d = 1; d < 12; d++) {
    if (new Set(dirs.map(x => x === "." ? x : x.split("/").slice(0, d).join("/"))).size > 40) break;
    opt.depth = d;
  }
  if (!opt.depth && dirs.length > 60) opt.depth = 1;
}
const group = f => { const d = relDir(f); return opt.depth > 0 && d !== "." ? d.split("/").slice(0, opt.depth).join("/") : d; };
const rel = f => path.relative(ROOT, f).split(path.sep).join("/") || ".";

// ---------- packages: nearest folder with package.json (npm/yarn/pnpm workspaces) or project.json (Nx)
const pkgCache = new Map();
const packages = new Map(); // dir -> {name, dir, files, imports:Set, ext:Set, cnt}
function packageOf(file) {
  let dir = path.dirname(file);
  const seen = [];
  let found = null;
  while (true) {
    if (pkgCache.has(dir)) { found = pkgCache.get(dir); break; }
    seen.push(dir);
    let name = null;
    for (const m of ["package.json", "project.json"]) {
      const f = path.join(dir, m);
      if (fs.existsSync(f)) { try { name = JSON.parse(fs.readFileSync(f, "utf8")).name || null; } catch {} name ||= path.basename(dir); break; }
    }
    if (name || dir === ROOT || dir === path.dirname(dir)) {
      found = dir;
      if (!packages.has(dir)) packages.set(dir, { name: name || path.basename(ROOT), dir: rel(dir), files: [], imports: new Set(), ext: new Set(), cnt: {} });
      break;
    }
    dir = path.dirname(dir);
  }
  for (const s of seen) pkgCache.set(s, found);
  return packages.get(found);
}

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
  if (!groups.has(g)) groups.set(g, { path: g, imports: new Set(), ext: new Set(), cnt: {} });
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

  const PK = packageOf(file);
  for (const s of specs) {
    const r = resolve(s, file);
    if (r?.internal) {
      const t = group(r.internal); if (t !== g) { G.imports.add(t); G.cnt[t] = (G.cnt[t] || 0) + 1; }
      const tp = packageOf(r.internal); if (tp !== PK) { PK.imports.add(tp.name); PK.cnt[tp.name] = (PK.cnt[tp.name] || 0) + 1; }
    } else if (r?.external) { G.ext.add(r.external); PK.ext.add(r.external); }
  }
  const lines = sf.getLineStarts().length;
  totalLines += lines;
  G.nfiles = (G.nfiles || 0) + 1; G.lines = (G.lines || 0) + lines; G.nfn = (G.nfn || 0) + funcs.length;
  // name = module path inside its package
  const pdir = PK.dir === "." ? ROOT : path.join(ROOT, PK.dir);
  PK.files.push({ name: path.relative(pdir, file).split(path.sep).join("/"), rel: rel(file), g, lines, funcs });
}

// ---------- output
// folders drive the map; packages drive the browser (files live under their package)
const pkgs = [...groups.values()].sort((a, b) => a.path.localeCompare(b.path)).map(g => ({
  path: g.path, imports: [...g.imports].sort(), weights: g.cnt, ext: [...g.ext].sort(), nfiles: g.nfiles, lines: g.lines, nfn: g.nfn,
}));
const modules = [...packages.values()].sort((a, b) => a.name.localeCompare(b.name)).map(p => ({
  name: p.name, dir: p.dir, imports: [...p.imports].sort(), weights: p.cnt, ext: [...p.ext].sort(),
  files: p.files.sort((a, b) => a.name.localeCompare(b.name)),
}));

let name = path.basename(ROOT), rev = "", source = "";
if (gh) name = gh.sub ? `${gh.repo}/${gh.sub}` : gh.repo;
else try { name = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).name || name; } catch {}
const git = (...a) => execFileSync("git", ["-C", ROOT, ...a], { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
try {
  rev = git("rev-parse", "--short", "HEAD");
  const remote = git("remote", "get-url", "origin");
  const m = remote.match(/github\.com[:/]([^/]+)\/(.+?)(\.git)?$/);
  if (m) source = `https://github.com/${m[1]}/${m[2]}/blob/${git("rev-parse", "HEAD")}/${git("rev-parse", "--show-prefix")}`;
} catch {}

const data = { name, root: ROOT, label: gh ? `github.com/${gh.owner}/${gh.repo}${gh.ref ? " @ " + gh.ref : ""}${gh.sub ? " · " + gh.sub : ""}` : ROOT, local: !gh, rev, source, depth: opt.depth, lines: totalLines, pkgs, packages: modules };
const tpl = fs.readFileSync(path.join(HERE, "template.html"), "utf8");
const json = JSON.stringify(data).replace(/</g, "\\u003c");
const esc = s => s.replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const back = opt.back ? `<a class="back" href="${esc(opt.back)}">← all code maps</a>` : "";
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, tpl.replaceAll("{{NAME}}", esc(name)).replace("<!--{{BACK}}-->", back).replace("/*{{DATA}}*/", () => json));
const nfn = pkgs.reduce((a, p) => a + p.nfn, 0);
console.log(`wrote ${OUT}: ${modules.length} packages, ${pkgs.length} folders, ${files.length} files, ${nfn} functions, ${totalLines} lines`);
if (opt.meta) {
  let sha = ""; try { sha = git("rev-parse", "HEAD"); } catch {}
  fs.writeFileSync(opt.meta, JSON.stringify({
    name, label: data.label, ...(gh || {}), sha, depth: opt.depth,
    stats: { packages: modules.length, folders: pkgs.length, files: files.length, functions: nfn, lines: totalLines,
      npm: new Set(pkgs.flatMap(p => p.ext || [])).size },
  }, null, 2));
}
if (pkgs.length > 60 && !opt.depth) console.log(`tip: ${pkgs.length} folders is a lot to draw; try --depth 2, 3 or 4 to group them`);
if (opt.open && process.stdout.isTTY) spawn(process.platform === "darwin" ? "open" : "xdg-open", [OUT], { detached: true, stdio: "ignore" }).unref();
