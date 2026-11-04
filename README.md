# js-codemap

Point it at a JS/TS folder; get one self-contained HTML page with a layered package (or folder) dependency map (import cycles in red) and a searchable files → functions browser.

```bash
npm i && node codemap.mjs ~/projects/some-app
node codemap.mjs trpc/trpc        # or any github.com URL, incl. /tree/<branch>/<subfolder>
```

Options: `-o out.html`, `--depth N` (group folders to N path segments), `--tests`, `--no-open`.

Write-up: `~/projects/vault/vault/Projects/random/notes/2026-11-04-js-codemap.md`
