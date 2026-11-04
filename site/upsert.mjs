#!/usr/bin/env node
// Add or replace one page's record in the site's index: <site>/repos.json
//   node site/upsert.mjs <site dir> <page path, e.g. trpc/trpc/>
import fs from "node:fs";
import path from "node:path";

const [site, page] = process.argv.slice(2);
const meta = JSON.parse(fs.readFileSync(path.join(site, page, "meta.json"), "utf8"));
const file = path.join(site, "repos.json");
let db = { updated: null, items: [] };
try { db = JSON.parse(fs.readFileSync(file, "utf8")); } catch {}
const existed = db.items.some(r => r.id === meta.id);
db.items = [meta, ...db.items.filter(r => r.id !== meta.id)].sort((a, b) => b.savedAt.localeCompare(a.savedAt));
db.updated = meta.savedAt;
fs.writeFileSync(file, JSON.stringify(db, null, 2) + "\n");
console.log(existed ? "updated" : "added");
