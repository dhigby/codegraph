import { Node, Edge, ExtractionResult, ExtractionError, UnresolvedReference } from '../types';
import { generateNodeId } from './tree-sitter-helpers';
import { buildLanguageNode } from './keyman-shared';

/**
 * KeymanKpsExtractor — extracts the package manifest from Keyman package-source
 * files (`.kps`, XML).
 *
 * A `.kps` is the connective tissue of a keyboard: it names the keyboard(s) the
 * package ships (`<Keyboards><Keyboard><ID>…`) and lists every distributed file
 * (`<Files><File><Name>…`, with Windows-style `..\` paths relative to the
 * package's directory). Linking the package to its keyboard source turns an
 * otherwise-isolated keyboard into a connected subgraph
 * (`.kps` → `.kmn` → touch-layout / visual-keyboard).
 *
 * What we emit:
 *   - `file` node for the package (docstring = the package's display name).
 *   - `constant` node per supported language (from `<Keyboard><Languages>
 *     <Language ID="…">`), plus `contains` file → language. This is the
 *     release/experimental equivalent of a legacy keyboard's `.keyboard_info`
 *     `languages` map — so "which keyboards support language X" is queryable
 *     uniformly across the whole repo (see keyman-shared.ts).
 *   - `references` (unresolved, cross-file) from the package to each keyboard's
 *     `<id>.kmn` source, resolved against the `.kps`'s own directory.
 *   - `references` (unresolved) to any shipped keyboard-source companion file
 *     (`.kmn` / `.keyman-touch-layout` / `.kvks`). Build outputs, fonts, and
 *     docs are skipped — they aren't indexed, so a reference would never
 *     resolve.
 *   - `references` (unresolved) to each related package (`<RelatedPackages>
 *     <RelatedPackage ID="…">`) — by basename, since the target is in another
 *     directory; resolves to the related keyboard's `.kps` or legacy
 *     `.keyboard_info` by exact-name.
 */

/** Companion source extensions worth linking from a package's <Files> list. */
const LINKABLE_EXT = /\.(?:kmn|keyman-touch-layout|kvks)$/i;

export class KeymanKpsExtractor {
  private filePath: string;
  private source: string;
  private nodes: Node[] = [];
  private edges: Edge[] = [];
  private unresolvedReferences: UnresolvedReference[] = [];
  private errors: ExtractionError[] = [];
  private seenRefs = new Set<string>();
  private seenLangs = new Set<string>();

  constructor(filePath: string, source: string) {
    this.filePath = filePath;
    this.source = source;
  }

  extract(): ExtractionResult {
    const startTime = Date.now();

    try {
      const fileNode = this.createFileNode();

      // Keyboard ids → their `.kmn` source (the primary package → keyboard link),
      // and the languages each keyboard supports.
      const keyboardsBlock = findBlock(this.source, 'Keyboards');
      if (keyboardsBlock) {
        const re = /<ID>\s*([^<]+?)\s*<\/ID>/gi;
        let m: RegExpExecArray | null;
        while ((m = re.exec(keyboardsBlock.content)) !== null) {
          const id = m[1]!.trim();
          if (!id) continue;
          const abs = keyboardsBlock.offset + m.index;
          this.addRef(fileNode.id, resolvePackagePath(this.filePath, `${id}.kmn`), abs);
        }

        const langRe = /<Language\b[^>]*\bID\s*=\s*"([^"]+)"[^>]*>\s*([\s\S]*?)\s*<\/Language>/gi;
        while ((m = langRe.exec(keyboardsBlock.content)) !== null) {
          const tag = m[1]!.trim();
          const displayName = decodeEntities(m[2]!.replace(/<[^>]*>/g, '').trim());
          this.addLanguage(fileNode, tag, displayName);
        }
      }

      // Shipped files → link the keyboard-source companions among them.
      const filesBlock = findBlock(this.source, 'Files');
      if (filesBlock) {
        const re = /<Name>\s*([^<]+?)\s*<\/Name>/gi;
        let m: RegExpExecArray | null;
        while ((m = re.exec(filesBlock.content)) !== null) {
          const name = m[1]!.trim();
          if (!name || !LINKABLE_EXT.test(name)) continue;
          const abs = filesBlock.offset + m.index;
          this.addRef(fileNode.id, resolvePackagePath(this.filePath, name), abs);
        }
      }

      // Related packages → the package they reference by id. The target lives in
      // another directory, so we can't build a path — but a package id equals
      // its file's basename stem, so we reference `<id>.kps` (release/
      // experimental) AND `<id>.keyboard_info` (legacy, which has no `.kps`).
      // Whichever exists resolves by exact-name; the other and fully-external
      // ids drop harmlessly. (Most related packages are the legacy keyboard a
      // newer one deprecates, so the `.keyboard_info` arm matters most.)
      const relatedBlock = findBlock(this.source, 'RelatedPackages');
      if (relatedBlock) {
        // This package's own id is its filename stem; skip a self-referential
        // related id (would otherwise link the package to itself).
        const selfStem = (this.filePath.split(/[\\/]/).pop() || '').replace(/\.[^.]*$/, '').toLowerCase();
        const re = /<RelatedPackage\b[^>]*\bID\s*=\s*"([^"]+)"/gi;
        let m: RegExpExecArray | null;
        while ((m = re.exec(relatedBlock.content)) !== null) {
          const id = m[1]!.trim();
          if (!id || id.toLowerCase() === selfStem) continue;
          const abs = relatedBlock.offset + m.index;
          this.addRef(fileNode.id, `${id}.kps`, abs);
          this.addRef(fileNode.id, `${id}.keyboard_info`, abs);
        }
      }
    } catch (error) {
      this.errors.push({
        message: `Keyman package extraction error: ${error instanceof Error ? error.message : String(error)}`,
        filePath: this.filePath,
        severity: 'error',
        code: 'parse_error',
      });
    }

    return {
      nodes: this.nodes,
      edges: this.edges,
      unresolvedReferences: this.unresolvedReferences,
      errors: this.errors,
      durationMs: Date.now() - startTime,
    };
  }

  private addLanguage(fileNode: Node, tag: string, displayName: string): void {
    if (!tag || this.seenLangs.has(tag)) return; // first definition wins
    this.seenLangs.add(tag);
    const node = buildLanguageNode(this.filePath, tag, displayName || undefined, this.seenLangs.size);
    this.nodes.push(node);
    this.edges.push({ source: fileNode.id, target: node.id, kind: 'contains', provenance: 'tree-sitter' });
  }

  private createFileNode(): Node {
    const lines = this.source.split('\n');
    const id = generateNodeId(this.filePath, 'file', this.filePath, 1);
    const fileNode: Node = {
      id,
      kind: 'file',
      name: this.filePath.split(/[\\/]/).pop() || this.filePath,
      qualifiedName: this.filePath,
      filePath: this.filePath,
      language: 'keyman',
      startLine: 1,
      endLine: lines.length,
      startColumn: 0,
      endColumn: lines[lines.length - 1]?.length || 0,
      docstring: this.extractPackageName(),
      updatedAt: Date.now(),
    };
    this.nodes.push(fileNode);
    return fileNode;
  }

  /** The package's display name from `<Info><Name>…</Name>`, used as docstring. */
  private extractPackageName(): string | undefined {
    const info = findBlock(this.source, 'Info');
    if (!info) return undefined;
    const m = info.content.match(/<Name\b[^>]*>\s*([\s\S]*?)\s*<\/Name>/i);
    if (!m) return undefined;
    const name = decodeEntities(m[1]!.replace(/<[^>]*>/g, '').trim());
    return name || undefined;
  }

  private addRef(fromNodeId: string, referenceName: string, index: number): void {
    if (this.seenRefs.has(referenceName)) return;
    this.seenRefs.add(referenceName);
    this.unresolvedReferences.push({
      fromNodeId,
      referenceName,
      referenceKind: 'references',
      line: lineOfIndex(this.source, index),
      column: 0,
      filePath: this.filePath,
      language: 'keyman',
    });
  }
}

/**
 * Find the first `<Tag>…</Tag>` block, returning its inner content and the
 * absolute offset of that content within `source` (for line computation).
 */
function findBlock(source: string, tag: string): { content: string; offset: number } | null {
  const open = new RegExp(`<${tag}\\b[^>]*>`, 'i');
  const openMatch = open.exec(source);
  if (!openMatch) return null;
  const contentStart = openMatch.index + openMatch[0].length;
  const close = new RegExp(`</${tag}>`, 'i');
  close.lastIndex = contentStart;
  const closeMatch = close.exec(source.slice(contentStart));
  if (!closeMatch) return null;
  return {
    content: source.slice(contentStart, contentStart + closeMatch.index),
    offset: contentStart,
  };
}

/** 1-indexed physical line containing byte offset `index` in `source`. */
function lineOfIndex(source: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < source.length; i++) {
    if (source[i] === '\n') line++;
  }
  return line;
}

/**
 * Resolve a package-relative file path (forward- or back-slashed, with optional
 * `..`/`.` segments) against the `.kps`'s own directory. The result is
 * forward-slashed and includes a `/`, so the resolver's path matcher engages.
 */
function resolvePackagePath(kpsPath: string, value: string): string {
  const normPath = kpsPath.replace(/\\/g, '/');
  const v = value.replace(/\\/g, '/');
  const slash = normPath.lastIndexOf('/');
  const dir = slash >= 0 ? normPath.slice(0, slash) : '';
  if (!dir) return v;

  const segments = dir.split('/');
  for (const seg of v.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') segments.pop();
    else segments.push(seg);
  }
  return segments.join('/');
}

/** Minimal XML entity decode for the handful that appear in package names. */
function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)));
}
