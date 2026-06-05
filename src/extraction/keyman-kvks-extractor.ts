import { Node, Edge, ExtractionResult, ExtractionError } from '../types';
import { generateNodeId } from './tree-sitter-helpers';

/**
 * KeymanKvksExtractor — extracts structure from Keyman on-screen (desktop)
 * visual keyboard files (`.kvks`, XML).
 *
 * The format describes the layout shown on the on-screen keyboard:
 *
 *   <visualkeyboard>
 *     <header><kbdname>khmer_angkor</kbdname>…</header>
 *     <encoding name="unicode" fontname="…">
 *       <layer shift="RA"><key vkey="K_B">ឞ</key>…</layer>
 *       <layer shift=""><key …/>…</layer>
 *     </encoding>
 *   </visualkeyboard>
 *
 * A `<layer>` is one modifier state (the `shift` attribute is a combination of
 * modifier tokens — `S`=shift, `C`=ctrl, `A`=alt, with `L`/`R` for left/right;
 * `RA` is right-alt / AltGr). Unlike touch layouts, desktop layers don't switch
 * between each other (the modifier state is driven by physical keys), so there
 * are no inter-layer edges to emit.
 *
 * What we emit:
 *   - `file` node (docstring = the `<kbdname>`).
 *   - `component` node per layer, scoped by encoding + decoded modifier state.
 *   - `contains` edges file → layer.
 *
 * Keys are NOT emitted as nodes (a layout has ~hundreds of keys across its
 * layers, which would explode the graph for pure key→glyph data). Indexing the
 * file is itself valuable: it lets the `&VISUALKEYBOARD` reference from the
 * `.kmn` and the package's `.kps` file list resolve to it.
 */

export class KeymanKvksExtractor {
  private filePath: string;
  private source: string;
  private nodes: Node[] = [];
  private edges: Edge[] = [];
  private errors: ExtractionError[] = [];
  private seen = new Set<string>();

  constructor(filePath: string, source: string) {
    this.filePath = filePath;
    this.source = source;
  }

  extract(): ExtractionResult {
    const startTime = Date.now();

    try {
      const fileNode = this.createFileNode();

      for (const enc of findBlocks(this.source, 'encoding')) {
        const encName = (enc.open.match(/name\s*=\s*"([^"]*)"/i)?.[1] || 'unicode').trim() || 'unicode';
        for (const layer of findBlocks(enc.content, 'layer')) {
          const shift = layer.open.match(/shift\s*=\s*"([^"]*)"/i)?.[1] ?? '';
          const keyCount = (layer.content.match(/<key\b/gi) || []).length;
          this.emitLayer(fileNode, encName, shift, keyCount);
        }
      }
    } catch (error) {
      this.errors.push({
        message: `Keyman visual-keyboard extraction error: ${error instanceof Error ? error.message : String(error)}`,
        filePath: this.filePath,
        severity: 'error',
        code: 'parse_error',
      });
    }

    return {
      nodes: this.nodes,
      edges: this.edges,
      unresolvedReferences: [],
      errors: this.errors,
      durationMs: Date.now() - startTime,
    };
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
      docstring: this.source.match(/<kbdname>\s*([^<]*?)\s*<\/kbdname>/i)?.[1] || undefined,
      updatedAt: Date.now(),
    };
    this.nodes.push(fileNode);
    return fileNode;
  }

  private emitLayer(fileNode: Node, encoding: string, shift: string, keyCount: number): void {
    const label = decodeShift(shift);
    const qualifiedName = `${this.filePath}::${encoding}:${label}`;
    if (this.seen.has(qualifiedName)) return; // first definition wins
    this.seen.add(qualifiedName);

    const id = generateNodeId(this.filePath, 'component', `${encoding}:${label}`, this.seen.size);
    this.nodes.push({
      id,
      kind: 'component',
      name: label,
      qualifiedName,
      filePath: this.filePath,
      language: 'keyman',
      signature: `layer ${label} (${encoding}, ${keyCount} keys)`,
      startLine: 1,
      endLine: 1,
      startColumn: 0,
      endColumn: 0,
      updatedAt: Date.now(),
    });
    this.edges.push({ source: fileNode.id, target: id, kind: 'contains', provenance: 'tree-sitter' });
  }
}

/**
 * Find every `<Tag …>…</Tag>` block (non-nested; these KVKS tags don't nest
 * within themselves), returning each one's opening tag and inner content.
 */
function findBlocks(source: string, tag: string): { open: string; content: string }[] {
  const re = new RegExp(`<${tag}\\b([^>]*)>([\\s\\S]*?)<\\/${tag}>`, 'gi');
  const out: { open: string; content: string }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    out.push({ open: m[1] || '', content: m[2] || '' });
  }
  return out;
}

/**
 * Decode a KVKS `shift` modifier-state string into a readable label.
 * Tokens: `S`=shift, `C`=ctrl, `A`=alt, `K`=caps, with `L`/`R` prefixing a
 * `C`/`A` for the left/right variant (e.g. `RA` → right-alt, `SRA` →
 * shift+rightalt). Empty = the default (no-modifier) layer.
 */
function decodeShift(shift: string): string {
  if (!shift) return 'default';
  const parts: string[] = [];
  for (let i = 0; i < shift.length; ) {
    const c = shift[i];
    if (c === 'S') { parts.push('shift'); i++; }
    else if (c === 'C') { parts.push('ctrl'); i++; }
    else if (c === 'A') { parts.push('alt'); i++; }
    else if (c === 'K') { parts.push('caps'); i++; }
    else if (c === 'L' || c === 'R') {
      const side = c === 'L' ? 'left' : 'right';
      const next = shift[i + 1];
      if (next === 'C') { parts.push(`${side}ctrl`); i += 2; }
      else if (next === 'A') { parts.push(`${side}alt`); i += 2; }
      else { parts.push(side); i++; }
    } else { parts.push(c!); i++; } // unknown token — pass through
  }
  return parts.join('+');
}
