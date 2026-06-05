import { Node, Edge, ExtractionResult, ExtractionError } from '../types';
import { generateNodeId } from './tree-sitter-helpers';
import { buildLanguageNode } from './keyman-shared';

/**
 * KeymanKeyboardInfoExtractor — extracts catalog metadata from Keyman
 * `.keyboard_info` files (JSON).
 *
 * For release / experimental keyboards this file is a *build artifact* (kmc
 * generates it into the gitignored `build/` dir from the `.kps`), so it's never
 * committed. It IS committed for **legacy** keyboards — pre-compiled binary
 * distributions that ship only a `.kmp` and have no `.kps` source, making the
 * `.keyboard_info` their sole metadata record. Indexing it gives those legacy
 * keyboards the same language coverage the `.kps` extractor provides for the
 * rest of the repo.
 *
 * Shape (the fields we use):
 *   { "id": "...", "name": "Display Name",
 *     "languages": { "bla": { "displayName": "Siksika", "languageName": "..." }, … } }
 *
 * What we emit:
 *   - `file` node (docstring = the keyboard's display `name`).
 *   - `constant` node per supported language + `contains` file → language,
 *     identical in shape to the `.kps` extractor's language nodes (see
 *     keyman-shared.ts), so language-coverage queries span legacy + release.
 *
 * No cross-file references: a legacy keyboard's only sibling is a binary `.kmp`,
 * which isn't indexed.
 */

export class KeymanKeyboardInfoExtractor {
  private filePath: string;
  private source: string;
  private nodes: Node[] = [];
  private edges: Edge[] = [];
  private errors: ExtractionError[] = [];
  private seenLangs = new Set<string>();

  constructor(filePath: string, source: string) {
    this.filePath = filePath;
    this.source = source;
  }

  extract(): ExtractionResult {
    const startTime = Date.now();

    // Parse defensively: always emit a file node (so the watcher tracks the
    // file even if it's malformed), then add languages if the JSON parsed.
    let data: any;
    try {
      data = JSON.parse(this.source.replace(/^﻿/, ''));
    } catch (error) {
      this.errors.push({
        message: `Keyman keyboard-info extraction error: ${error instanceof Error ? error.message : String(error)}`,
        filePath: this.filePath,
        severity: 'error',
        code: 'parse_error',
      });
    }

    const fileNode = this.createFileNode(typeof data?.name === 'string' ? data.name : undefined);

    const languages = data?.languages;
    if (languages && typeof languages === 'object' && !Array.isArray(languages)) {
      // The canonical shape: { "<bcp47>": { displayName, languageName } }.
      for (const [tag, info] of Object.entries(languages)) {
        this.addLanguage(fileNode, tag, displayNameOf(info));
      }
    } else if (Array.isArray(languages)) {
      // Older shape some legacy files use: a bare list of BCP-47 tags.
      for (const tag of languages) {
        if (typeof tag === 'string') this.addLanguage(fileNode, tag, undefined);
      }
    }

    return {
      nodes: this.nodes,
      edges: this.edges,
      unresolvedReferences: [],
      errors: this.errors,
      durationMs: Date.now() - startTime,
    };
  }

  private createFileNode(displayName: string | undefined): Node {
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
      docstring: displayName || undefined,
      updatedAt: Date.now(),
    };
    this.nodes.push(fileNode);
    return fileNode;
  }

  private addLanguage(fileNode: Node, tag: string, displayName: string | undefined): void {
    const t = tag.trim();
    if (!t || this.seenLangs.has(t)) return;
    this.seenLangs.add(t);
    const node = buildLanguageNode(this.filePath, t, displayName, this.seenLangs.size);
    this.nodes.push(node);
    this.edges.push({ source: fileNode.id, target: node.id, kind: 'contains', provenance: 'tree-sitter' });
  }
}

/** Pull a human display name from a `languages` map value (object or string). */
function displayNameOf(info: unknown): string | undefined {
  if (typeof info === 'string') return info;
  if (info && typeof info === 'object') {
    const o = info as Record<string, unknown>;
    if (typeof o.displayName === 'string') return o.displayName;
    if (typeof o.languageName === 'string') return o.languageName;
  }
  return undefined;
}
