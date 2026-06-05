# Keyman extractor roadmap (fork notes)

This fork adds Keyman keyboard-source (`.kmn`) indexing to CodeGraph. This doc
lists the **other Keyman file formats** that are good candidates for future
extractors, ranked by how much they'd add to the knowledge graph.

Current state: three Keyman formats are wired, all under the one `keyman`
language token (dispatched by extension in `src/extraction/tree-sitter.ts`):

- **`.kmn`** (`keyman-extractor.ts`) — `group`s (as functions), user/system
  `store`s, `use()` call edges, and `outs`/`any`/`index` store references
  (intra-file), **plus** cross-file `references` from the `&LAYOUTFILE` /
  `&VISUALKEYBOARD` system stores to the named companion files.
- **`.keyman-touch-layout`** (`keyman-touch-layout-extractor.ts`) — a
  `component` node per layer (scoped by platform), `contains` from the file,
  and `references` layer→layer for every `nextlayer` switch (incl. subkeys /
  flicks / multitaps), resolved within the same platform. Keys are not emitted
  as nodes (would explode the graph for little structural value).
- **`.kps`** (`keyman-kps-extractor.ts`) — the package manifest. File node with
  the package display name as docstring, and cross-file `references` to each
  `<Keyboard><ID>`'s `.kmn` source plus any shipped keyboard-source companion
  (`.kmn` / `.keyman-touch-layout` / `.kvks`); build outputs, fonts, and docs
  are skipped (never indexed, so they'd never resolve).

Together these connect `.kps → .kmn → touch-layout` into one navigable
subgraph (validated end-to-end on `khmer_angkor` and `baybayin`). The
`&VISUALKEYBOARD → .kvks` reference is emitted but only resolves once `.kvks`
is itself indexed (see remaining work below).

## Keyman source formats present in the keyboards repo

Counts from a scan of `keymanapp/keyboards` (`release` + `legacy` + `experimental`):

| Ext | Count | Format | Extractor candidate? | What it would add |
|---|---|---|---|---|
| `.kmn` | 1034 | text DSL | ✅ **done** | groups, stores, call/reference edges, + companion-file cross-links |
| `.kps` | 1055 | XML | ✅ **done** | package manifest — links the package to its keyboard `.kmn` (via `<Keyboard><ID>`) and shipped source companions |
| `.keyman-touch-layout` | 952 | JSON | ✅ **done** | touch/mobile layout — `component` node per layer + `nextlayer` layer-transition edges |
| `.kvks` | 947 | XML | 🔸 medium | on-screen (desktop) visual keyboard — key→output map. Mostly data; completes the picture (would also light up the emitted `&VISUALKEYBOARD → .kvks` reference) |
| `.kpj` | 1034 | XML | 🔸 low | project file — but modern ones are nearly empty (auto-discover files), so little to extract |
| `.keyboard_info` | 555 | JSON | 🔸 low | catalog metadata (languages, author, version). Easy but low graph value |
| `.xml` (LDML) | ~2 | XML | ❌ skip | the new CLDR keyboard standard — a genuine alt source language, but only ~2 in the repo; not worth it |
| `.kmp` / `.kmx` / `.kvk` | 360 / 24 / 10 | binary | ❌ skip | compiled outputs |
| `.png` `.ico` `.ttf` `.pdf` `.htm` `.md` `.php` | many | assets/docs | ❌ skip | not code |

> Lexical models (predictive text) are written in **TypeScript** (`.model.ts`)
> — already indexed by CodeGraph's TypeScript support.

## The biggest win: cross-file links (not a new file type) — ✅ done

CodeGraph's core strength is **cross-file** edges, but every Keyman keyboard
*was* an isolated island. The two additions below (now implemented) connect
them; kept here for context:

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

1. ✅ **`.kmn` cross-file edges** (enhance existing extractor) — biggest value, smallest effort.
2. ✅ **`.keyman-touch-layout`** (JSON) — layer nodes + `nextlayer` transitions.
3. ✅ **`.kps`** (XML manifest) — the connective tissue between a keyboard's files.
4. `.kvks` / `.keyboard_info` — nice-to-have, lower value. **Remaining.**

### Remaining work

- **`.kvks`** (visual keyboard, XML) — index as a file (+ optionally a key→output
  map). Indexing it also lights up the `&VISUALKEYBOARD → .kvks` reference the
  `.kmn` extractor already emits.
- **`.keyboard_info`** (JSON catalog metadata) — low graph value.
- **`.kps` RelatedPackages** — `<RelatedPackage ID="…">` links one package to
  another by id. Not yet linked (the target lives in a different directory, so
  there's no path to resolve against); would need a package-id → `.kps` index.

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
