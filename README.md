# js-codemap

Point it at a JS/TS folder or GitHub repo; get one self-contained HTML page with a layered package (or folder) dependency map (import cycles in red) and a searchable files → functions browser.

```bash
npm i && node codemap.mjs ~/projects/some-app
node codemap.mjs trpc/trpc        # or any github.com URL, incl. /tree/<branch>/<subfolder>
```

Options: `-o out.html`, `--depth N|auto` (group folders to N path segments), `--tests`, `--meta out.json`, `--back URL`, `--no-open`.

## Site: http://felipe.sabino.me/codemap/

A catalog of maps, one page per repo (`/<owner>/<repo>/`), searchable from the home page.

- **Add a repo:** the home page's "Request map" box (or a search with no match) opens a "Map a repository" issue, labelled `new source`.
- **Bot:** `.github/workflows/new-source.yml` comments that it started, finds the repo URL with a local Ollama model (`qwen2.5:1.5b` in a service container, checked against the text, regex fallback), runs `site/generate.mjs`, commits the page, its `meta.json` and the `repos.json` record to `gh-pages`, waits for Pages, then comments the link and closes the issue.
- **Home page:** `site/index.html` (copied to `gh-pages` by `.github/workflows/site.yml`). Unknown `/<owner>/<repo>` URLs land on the home page searching for that repo (`site/404.html`).

Write-up: `~/projects/vault/vault/Projects/random/notes/2026-11-04-js-codemap.md`
