#!/usr/bin/env node
// Make one repo's page for the site: <out>/<owner>/<repo>[/tree/<ref>/<sub>]/index.html + meta.json.
//   node site/generate.mjs <github url> <out dir> [--issue N] [--by login]
// Prints the page's path inside the site (e.g. "trpc/trpc/") on the last line.
// env: GH_TOKEN (optional, raises the GitHub API rate limit), MAX_REPO_MB (default 1500)
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const [url, outDir, ...rest] = process.argv.slice(2);
const flag = k => { const i = rest.indexOf(k); return i >= 0 ? rest[i + 1] : ""; };
if (!url || !outDir) { console.error("usage: generate.mjs <github url> <out dir> [--issue N] [--by login]"); process.exit(2); }

const m = url.match(/^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)(?:\/tree\/([\w.-]+)(?:\/([\w.\-/]+))?)?$/);
if (!m) { console.error(`not a GitHub repo URL: ${url}`); process.exit(1); }
let [, owner, repo, ref = "", sub = ""] = m;
sub = sub.replace(/\/$/, "");
if (`${ref}/${sub}`.split("/").includes("..")) { console.error("bad path"); process.exit(1); }

// repo facts for search and the listing (and a size check before cloning)
const headers = { accept: "application/vnd.github+json", "user-agent": "codemap-site" };
if (process.env.GH_TOKEN) headers.authorization = `Bearer ${process.env.GH_TOKEN}`;
const res = await fetch(`https://api.github.com/repos/${owner}/${repo}`, { headers });
if (res.status === 404) { console.error(`github.com/${owner}/${repo} not found (or private)`); process.exit(1); }
if (!res.ok) { console.error(`GitHub API ${res.status}`); process.exit(1); }
const info = await res.json();
if (info.private) { console.error("private repos are not supported"); process.exit(1); }
const maxKB = (+process.env.MAX_REPO_MB || 1500) * 1024;
if (info.size > maxKB) { console.error(`repo is ${Math.round(info.size / 1024)} MB; the limit is ${maxKB / 1024} MB`); process.exit(1); }
[owner, repo] = info.full_name.split("/"); // canonical case

const page = `${owner}/${repo}/` + (ref ? `tree/${ref}/` : "") + (sub ? `${sub}/` : "");
const dir = path.join(outDir, page);
const back = "../".repeat(page.split("/").filter(Boolean).length);
const src = `https://github.com/${owner}/${repo}` + (ref ? `/tree/${ref}` + (sub ? `/${sub}` : "") : "");
fs.mkdirSync(dir, { recursive: true });
const metaFile = path.join(dir, "meta.json");
execFileSync(process.execPath, [path.join(HERE, "..", "codemap.mjs"), src, "-o", path.join(dir, "index.html"),
  "--meta", metaFile, "--back", back, "--depth", "auto", "--no-open"], { stdio: ["ignore", "inherit", "inherit"] });

const run = JSON.parse(fs.readFileSync(metaFile, "utf8"));
const meta = {
  id: page.replace(/\/$/, ""), path: page, source: src,
  owner, repo, ref: ref || info.default_branch, sub, sha: run.sha,
  description: info.description || "", language: info.language || "", topics: info.topics || [],
  stars: info.stargazers_count, homepage: info.homepage || "",
  savedAt: new Date().toISOString(),
  issue: +flag("--issue") || null, requestedBy: flag("--by") || null,
  depth: run.depth, stats: run.stats,
};
fs.writeFileSync(metaFile, JSON.stringify(meta, null, 2) + "\n");
console.log(page);
