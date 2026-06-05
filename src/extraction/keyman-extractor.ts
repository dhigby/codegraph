import { Node, Edge, ExtractionResult, ExtractionError, UnresolvedReference } from '../types';
import { generateNodeId } from './tree-sitter-helpers';

/**
 * KeymanExtractor — extracts symbols and relationships from Keyman keyboard
 * source files (`.kmn`).
 *
 * Keyman (developed by SIL) is a rule-based DSL for input methods. It has no
 * tree-sitter grammar, so — like Liquid / Vue / Svelte / DFM — it gets a
 * standalone line-oriented extractor. The `.kmn` language is built from a small
 * set of statements:
 *
 *   - `store(Name) <data>`     — named data table. `&Name` system stores hold
 *                                keyboard metadata (&NAME, &VERSION, &TARGETS…);
 *                                user stores hold key/output tables.
 *   - `group(Name) using keys` — the structural/callable unit (function-like).
 *                                Groups hold the rewrite rules.
 *   - `begin Unicode > use(g)` — entry point into the first group.
 *   - rules inside a group:    `<context> + <key> > <output>`, where output and
 *                                context reference other symbols via `use(g)`
 *                                (call another group), `outs(s)` / `any(s)` /
 *                                `notany(s)` / `index(s,n)` / `call(s)` (consume
 *                                a store), etc.
 *
 * What we emit:
 *   - `function` node per `group(...)`, spanning to the next group.
 *   - `variable` node per user `store(...)`, `constant` per `&system` store.
 *   - `contains` edges file → group / store.
 *   - `calls` edges group → group for `use(...)` (and file → group for `begin`).
 *   - `references` edges group → store (and store → store) for `outs/any/...`.
 *
 * Groups and stores are file-local in a keyboard, so references are resolved
 * directly into edges in a second pass (no cross-file unresolved references).
 */

/** A logical line: physical lines joined across `\` continuations, comments stripped. */
interface LogicalLine {
  /** Comment-stripped, continuation-joined text (whitespace-normalized). */
  text: string;
  /** 1-indexed physical line where the statement begins. */
  startLine: number;
  /** 1-indexed physical line where the statement ends. */
  endLine: number;
}

interface SymbolDef {
  id: string;
  name: string;
  startLine: number;
}

export class KeymanExtractor {
  private filePath: string;
  private source: string;
  private nodes: Node[] = [];
  private edges: Edge[] = [];
  private unresolvedReferences: UnresolvedReference[] = [];
  private errors: ExtractionError[] = [];

  /** Resolved-edge dedup: `${source}|${target}|${kind}`. */
  private seenEdges = new Set<string>();

  constructor(filePath: string, source: string) {
    this.filePath = filePath;
    this.source = source;
  }

  extract(): ExtractionResult {
    const startTime = Date.now();

    try {
      const fileNode = this.createFileNode();
      const logical = this.buildLogicalLines();

      // Pass 1 — collect definitions (groups + stores) so forward references
      // (e.g. `begin Unicode > use(main)` before `group(main)`) resolve.
      const groupMap = new Map<string, SymbolDef>();
      const storeMap = new Map<string, SymbolDef>();
      this.collectDefinitions(logical, fileNode, groupMap, storeMap);

      // Pass 2 — resolve calls (use) and store references (outs/any/index/…).
      this.resolveReferences(logical, fileNode, groupMap, storeMap);
    } catch (error) {
      this.errors.push({
        message: `Keyman extraction error: ${error instanceof Error ? error.message : String(error)}`,
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
      docstring: this.extractKeyboardName(),
      updatedAt: Date.now(),
    };

    this.nodes.push(fileNode);
    return fileNode;
  }

  /** The keyboard's display name from `store(&NAME) '...'`, used as the file docstring. */
  private extractKeyboardName(): string | undefined {
    const m = this.source.match(/store\s*\(\s*&NAME\s*\)\s*['"]([^'"]+)['"]/i);
    return m ? m[1] : undefined;
  }

  /**
   * Split the source into logical lines: strip `c ...` comments (quote-aware),
   * then join lines continued with a trailing backslash.
   */
  private buildLogicalLines(): LogicalLine[] {
    const physical = this.source.split(/\r?\n/);
    const out: LogicalLine[] = [];
    let buf = '';
    let startLine = 0;

    for (let i = 0; i < physical.length; i++) {
      const stripped = stripKeymanComment(physical[i] ?? '');
      const rtrimmed = stripped.replace(/\s+$/, '');
      const continued = rtrimmed.endsWith('\\');
      const piece = continued ? rtrimmed.slice(0, -1) : stripped;

      if (buf === '') startLine = i + 1;
      buf += (buf ? ' ' : '') + piece.trim();

      if (!continued) {
        const text = buf.trim();
        if (text) out.push({ text, startLine, endLine: i + 1 });
        buf = '';
      }
    }
    if (buf.trim()) out.push({ text: buf.trim(), startLine, endLine: physical.length });

    return out;
  }

  /** Pass 1: create group/store nodes and their `contains` edges. */
  private collectDefinitions(
    logical: LogicalLine[],
    fileNode: Node,
    groupMap: Map<string, SymbolDef>,
    storeMap: Map<string, SymbolDef>
  ): void {
    // Group spans run until the next group definition (or EOF).
    const groupStarts: { name: string; line: number }[] = [];
    for (const ll of logical) {
      const g = ll.text.match(/^group\s*\(\s*([^)]+?)\s*\)/i);
      if (g) groupStarts.push({ name: g[1]!, line: ll.startLine });
    }

    const lastPhysical = this.source.split('\n').length;

    for (const ll of logical) {
      const storeM = ll.text.match(/^store\s*\(\s*([^)]+?)\s*\)/i);
      if (storeM) {
        const name = storeM[1]!.trim();
        if (storeMap.has(name)) continue; // first definition wins
        const isSystem = name.startsWith('&');
        const kind = isSystem ? 'constant' : 'variable';
        const id = generateNodeId(this.filePath, kind, name, ll.startLine);
        this.nodes.push({
          id,
          kind,
          name,
          qualifiedName: `${this.filePath}::${name}`,
          filePath: this.filePath,
          language: 'keyman',
          signature: truncate(ll.text, 120),
          startLine: ll.startLine,
          endLine: ll.endLine,
          startColumn: 0,
          endColumn: 0,
          updatedAt: Date.now(),
        });
        this.addEdge(fileNode.id, id, 'contains');
        storeMap.set(name, { id, name, startLine: ll.startLine });
        continue;
      }

      const groupM = ll.text.match(/^group\s*\(\s*([^)]+?)\s*\)\s*(.*)$/i);
      if (groupM) {
        const name = groupM[1]!.trim();
        if (groupMap.has(name)) continue;
        const idx = groupStarts.findIndex((g) => g.name === name && g.line === ll.startLine);
        const next = groupStarts[idx + 1];
        const endLine = next ? Math.max(next.line - 1, ll.startLine) : lastPhysical;
        const modifier = (groupM[2] || '').trim();
        const id = generateNodeId(this.filePath, 'function', name, ll.startLine);
        this.nodes.push({
          id,
          kind: 'function',
          name,
          qualifiedName: `${this.filePath}::${name}`,
          filePath: this.filePath,
          language: 'keyman',
          signature: modifier ? `group(${name}) ${modifier}` : `group(${name})`,
          startLine: ll.startLine,
          endLine,
          startColumn: 0,
          endColumn: 0,
          updatedAt: Date.now(),
        });
        this.addEdge(fileNode.id, id, 'contains');
        groupMap.set(name, { id, name, startLine: ll.startLine });
      }
    }
  }

  /** Pass 2: emit `calls` (use) and `references` (outs/any/index/…) edges. */
  private resolveReferences(
    logical: LogicalLine[],
    fileNode: Node,
    groupMap: Map<string, SymbolDef>,
    storeMap: Map<string, SymbolDef>
  ): void {
    let currentGroup: SymbolDef | null = null;
    let currentStore: SymbolDef | null = null;

    for (const ll of logical) {
      const text = ll.text;

      const groupM = text.match(/^group\s*\(\s*([^)]+?)\s*\)/i);
      if (groupM) {
        currentGroup = groupMap.get(groupM[1]!.trim()) || null;
        currentStore = null;
        continue;
      }

      const storeM = text.match(/^store\s*\(\s*([^)]+?)\s*\)/i);
      if (storeM) {
        // A store body can reference other stores via outs(...): store→store.
        currentStore = storeMap.get(storeM[1]!.trim()) || null;
        this.emitStoreRefs(text, currentStore, storeMap, ll.startLine);
        continue;
      }

      const beginM = text.match(/^begin\b/i);
      if (beginM) {
        // `begin Unicode > use(main)` — entry point from the file into a group.
        this.emitGroupCalls(text, fileNode, groupMap, ll.startLine);
        continue;
      }

      // Otherwise it's a rule line belonging to the current group.
      if (currentGroup) {
        this.emitGroupCalls(text, currentGroup, groupMap, ll.startLine);
        this.emitStoreRefs(text, currentGroup, storeMap, ll.startLine);
      }
    }
  }

  /** Emit `calls` edges for every `use(group)` in a line. */
  private emitGroupCalls(
    text: string,
    caller: { id: string },
    groupMap: Map<string, SymbolDef>,
    line: number
  ): void {
    const re = /\buse\s*\(\s*([^)]+?)\s*\)/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const target = groupMap.get(m[1]!.trim());
      if (target) this.addEdge(caller.id, target.id, 'calls', line);
    }
  }

  /**
   * Emit `references` edges for store-consuming functions: outs / any / notany /
   * index / call / set / if / save / reset. The first argument is the store
   * name; unresolved targets (built-in system stores like `&layer`) are skipped.
   */
  private emitStoreRefs(
    text: string,
    referrer: { id: string } | null,
    storeMap: Map<string, SymbolDef>,
    line: number
  ): void {
    if (!referrer) return;
    const re = /\b(?:outs|any|notany|index|call|set|if|save|reset)\s*\(\s*([^),=\s]+)/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const target = storeMap.get(m[1]!.trim());
      if (target && target.id !== referrer.id) {
        this.addEdge(referrer.id, target.id, 'references', line);
      }
    }
  }

  private addEdge(source: string, target: string, kind: Edge['kind'], line?: number): void {
    const key = `${source}|${target}|${kind}`;
    if (this.seenEdges.has(key)) return;
    this.seenEdges.add(key);
    const edge: Edge = { source, target, kind, provenance: 'tree-sitter' };
    if (line !== undefined) edge.line = line;
    this.edges.push(edge);
  }
}

/**
 * Strip a Keyman comment from a single physical line. A comment is introduced
 * by a standalone `c` token — preceded by whitespace (or line start) and
 * followed by whitespace (or line end) — outside of quotes and `[key]` brackets.
 */
function stripKeymanComment(line: string): string {
  let inSingle = false;
  let inDouble = false;
  let inBracket = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inSingle) {
      if (ch === "'") inSingle = false;
      continue;
    }
    if (inDouble) {
      if (ch === '"') inDouble = false;
      continue;
    }
    if (ch === "'") { inSingle = true; continue; }
    if (ch === '"') { inDouble = true; continue; }
    if (ch === '[') { inBracket = true; continue; }
    if (ch === ']') { inBracket = false; continue; }
    if (ch === 'c' && !inBracket) {
      const prev = i === 0 ? ' ' : line[i - 1]!;
      const next = i + 1 >= line.length ? ' ' : line[i + 1]!;
      if (/\s/.test(prev) && /\s/.test(next)) {
        return line.slice(0, i);
      }
    }
  }
  return line;
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}
