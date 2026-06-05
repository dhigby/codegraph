# Keyman extractor roadmap (fork notes)

This fork adds Keyman keyboard-source (`.kmn`) indexing to CodeGraph. This doc
lists the **other Keyman file formats** that are good candidates for future
extractors, ranked by how much they'd add to the knowledge graph.

Current state: `.kmn` is fully wired (see `src/extraction/keyman-extractor.ts`)
— it extracts `group`s (as functions), user/system `store`s, `use()` call
edges, and `outs`/`any`/`index` store references, all resolved intra-file.

## Keyman source formats present in the keyboards repo

Counts from a scan of `keymanapp/keyboards` (`release` + `legacy` + `experimental`):

| Ext | Count | Format | Extractor candidate? | What it would add |
|---|---|---|---|---|
| `.kmn` | 1034 | text DSL | ✅ **done** | groups, stores, call/reference edges |
| `.kps` | 1055 | XML | ⭐ **high** | package manifest — lists the files a keyboard ships (`<File><Name>…</Name>`). Emit `references` edges to the `.kmn` / `.kvks` / fonts → connects each keyboard's parts |
| `.keyman-touch-layout` | 952 | JSON | ⭐ **high** | touch/mobile layout — layers + keys, with `nextlayer` switches and key→output. Real symbols + intra-file edges |
| `.kvks` | 947 | XML | 🔸 medium | on-screen (desktop) visual keyboard — key→output map. Mostly data; completes the picture |
| `.kpj` | 1034 | XML | 🔸 low | project file — but modern ones are nearly empty (auto-discover files), so little to extract |
| `.keyboard_info` | 555 | JSON | 🔸 low | catalog metadata (languages, author, version). Easy but low graph value |
| `.xml` (LDML) | ~2 | XML | ❌ skip | the new CLDR keyboard standard — a genuine alt source language, but only ~2 in the repo; not worth it |
| `.kmp` / `.kmx` / `.kvk` | 360 / 24 / 10 | binary | ❌ skip | compiled outputs |
| `.png` `.ico` `.ttf` `.pdf` `.htm` `.md` `.php` | many | assets/docs | ❌ skip | not code |

> Lexical models (predictive text) are written in **TypeScript** (`.model.ts`)
> — already indexed by CodeGraph's TypeScript support.

## The biggest win: cross-file links (not a new file type)

CodeGraph's core strength is **cross-file** edges, but right now every Keyman
keyboard is an isolated island. Two cheap additions would connect them:

1. **Enhance the existing `.kmn` extractor.** It already captures
   `store(&VISUALKEYBOARD) 'x.kvks'`, `&LAYOUTFILE 'x.keyman-touch-layout'`, and
   `&BITMAP 'x.ico'` as nodes, but doesn't *link* them. Emitting `references`
   edges (as `unresolvedReferences`, so the resolver matches them to real files)
   from those system stores to the named companion files would connect
   `.kmn → .kvks / .keyman-touch-layout`. No new file type — a few lines in
   `src/extraction/keyman-extractor.ts`.
2. **Add a `.kps` extractor.** Parse its `<File><Name>` manifest and link the
   package to every file it ships.

Together these turn a keyboard into a connected subgraph
(`.kps` → `.kmn` → touch-layout / visual-keyboard), so an agent can answer
*"what files make up this keyboard and how do they relate?"* without opening
each one.

## Recommended order

1. **`.kmn` cross-file edges** (enhance existing extractor) — biggest value, smallest effort.
2. **`.keyman-touch-layout`** (JSON) — rich symbols (layers/keys), trivial to parse with `JSON.parse`.
3. **`.kps`** (XML manifest) — the connective tissue between a keyboard's files.
4. `.kvks` / `.keyboard_info` — nice-to-have, lower value.

## How to add one (pattern)

All of these are non-tree-sitter formats, so they follow the **standalone
extractor** pattern already used by `keyman-extractor.ts` (and `liquid`,
`vue`, `svelte`, `dfm`):

1. New `src/extraction/<fmt>-extractor.ts` exporting a class with
   `extract(): ExtractionResult` (nodes, edges, unresolvedReferences, errors).
   - XML (`.kps`, `.kvks`): parse with a lightweight XML approach.
   - JSON (`.keyman-touch-layout`, `.keyboard_info`): `JSON.parse`.
2. Wire it:
   - `src/types.ts` — add the language token to `LANGUAGES` (or reuse `keyman`).
   - `src/extraction/grammars.ts` — add the extension to `EXTENSION_MAP`, plus
     the `isLanguageSupported` / `isGrammarLoaded` / `getSupportedLanguages`
     special-cases (no WASM grammar), `GrammarLanguage` exclusion, and a display
     name.
   - `src/extraction/tree-sitter.ts` — route the language in `extractFromSource`.
3. Tests in `__tests__/extraction.test.ts` (detection + extraction block).
4. `npm run build`, then index a sample and check `codegraph status --json`.

For cross-file edges, emit `unresolvedReferences` (with `referenceName` =
the target file path) rather than resolved `edges`, so the reference resolver
links them across files during the resolution pass.

---

*Decision on file: this fork stays a personal fork (Keyman support only); not
intended for upstream. See the fork notice at the top of `README.md`.*
