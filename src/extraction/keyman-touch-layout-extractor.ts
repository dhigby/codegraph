import { Node, Edge, ExtractionResult, ExtractionError, UnresolvedReference } from '../types';
import { generateNodeId } from './tree-sitter-helpers';

/**
 * KeymanTouchLayoutExtractor — extracts structure from Keyman touch/mobile
 * layout files (`.keyman-touch-layout`).
 *
 * The format is JSON: one object keyed by platform (`phone` / `tablet` /
 * `desktop`), each holding a `layer` array. A layer is the on-screen keyboard
 * surface the user sees; keys live in `row[].key[]`. A key (or its long-press
 * subkeys `sk[]`, flick gestures `flick`, or multitaps `multitap`) can carry a
 * `nextlayer` that switches the keyboard to another layer — these transitions
 * are the structural flow of a touch keyboard ("how does the shift key reach
 * the symbols layer").
 *
 * What we emit:
 *   - `file` node for the layout.
 *   - `component` node per layer (one per platform — layer ids like `default`
 *     and `shift` repeat across platforms, so each is scoped by platform).
 *   - `contains` edges file → layer.
 *   - `references` edges layer → layer for every `nextlayer` switch, resolved
 *     within the same platform.
 *
 * Keys themselves are NOT emitted as nodes: a layout has dozens of keys per
 * layer across several layers and platforms, which would explode the graph for
 * little structural value. The layer-transition graph is the useful signal.
 */

/** A layer's parsed shape: its platform-scoped node plus the layers it switches to. */
interface LayerInfo {
  node: Node;
  platform: string;
  id: string;
  /** Layer ids reached via `nextlayer` from this layer's keys. */
  nextLayers: Set<string>;
  keyCount: number;
}

export class KeymanTouchLayoutExtractor {
  private filePath: string;
  private source: string;
  private nodes: Node[] = [];
  private edges: Edge[] = [];
  private unresolvedReferences: UnresolvedReference[] = [];
  private errors: ExtractionError[] = [];
  private seenEdges = new Set<string>();

  constructor(filePath: string, source: string) {
    this.filePath = filePath;
    this.source = source;
  }

  extract(): ExtractionResult {
    const startTime = Date.now();

    try {
      const fileNode = this.createFileNode();
      const data = JSON.parse(this.source.replace(/^﻿/, ''));

      if (data && typeof data === 'object') {
        for (const platform of Object.keys(data)) {
          const platformObj = data[platform];
          if (!platformObj || typeof platformObj !== 'object') continue;
          const layers = Array.isArray(platformObj.layer) ? platformObj.layer : [];
          this.extractPlatform(fileNode, platform, layers);
        }
      }
    } catch (error) {
      this.errors.push({
        message: `Keyman touch-layout extraction error: ${error instanceof Error ? error.message : String(error)}`,
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
      updatedAt: Date.now(),
    };
    this.nodes.push(fileNode);
    return fileNode;
  }

  /** Create layer nodes for one platform and wire up their `nextlayer` transitions. */
  private extractPlatform(fileNode: Node, platform: string, layers: unknown[]): void {
    const layerMap = new Map<string, LayerInfo>();
    let lineCursor = 1;

    for (const raw of layers) {
      if (!raw || typeof raw !== 'object') continue;
      const layer = raw as Record<string, unknown>;
      const id = typeof layer.id === 'string' ? layer.id : '';
      if (!id) continue;

      const rows = Array.isArray(layer.row) ? layer.row : [];
      const nextLayers = new Set<string>();
      let keyCount = 0;
      for (const row of rows) {
        const keys = row && typeof row === 'object' && Array.isArray((row as any).key) ? (row as any).key : [];
        for (const key of keys) {
          keyCount++;
          collectNextLayers(key, nextLayers);
        }
      }

      // A platform+layer id pair is unique within the file; node name is the
      // layer id (searchable), scoped by platform in qualifiedName.
      lineCursor++;
      const nodeId = generateNodeId(this.filePath, 'component', `${platform}:${id}`, lineCursor);
      const node: Node = {
        id: nodeId,
        kind: 'component',
        name: id,
        qualifiedName: `${this.filePath}::${platform}:${id}`,
        filePath: this.filePath,
        language: 'keyman',
        signature: `layer ${id} (${platform}, ${keyCount} keys)`,
        startLine: 1,
        endLine: 1,
        startColumn: 0,
        endColumn: 0,
        updatedAt: Date.now(),
      };
      this.nodes.push(node);
      this.addEdge(fileNode.id, nodeId, 'contains');

      if (layerMap.has(`${platform}:${id}`)) continue; // first definition wins
      layerMap.set(`${platform}:${id}`, { node, platform, id, nextLayers, keyCount });
    }

    // Resolve `nextlayer` transitions within this platform.
    for (const info of layerMap.values()) {
      for (const target of info.nextLayers) {
        const targetInfo = layerMap.get(`${platform}:${target}`);
        if (targetInfo && targetInfo.node.id !== info.node.id) {
          this.addEdge(info.node.id, targetInfo.node.id, 'references');
        }
      }
    }
  }

  private addEdge(source: string, target: string, kind: Edge['kind']): void {
    const key = `${source}|${target}|${kind}`;
    if (this.seenEdges.has(key)) return;
    this.seenEdges.add(key);
    this.edges.push({ source, target, kind, provenance: 'tree-sitter' });
  }
}

/**
 * Collect every `nextlayer` target reachable from a key, including its
 * long-press subkeys (`sk`), flick gestures (`flick`), and multitaps
 * (`multitap`). A `nextlayer` value is always a layer id (string).
 */
function collectNextLayers(key: unknown, out: Set<string>): void {
  if (!key || typeof key !== 'object') return;
  const k = key as Record<string, unknown>;

  if (typeof k.nextlayer === 'string' && k.nextlayer) out.add(k.nextlayer);

  if (Array.isArray(k.sk)) for (const sub of k.sk) collectNextLayers(sub, out);
  if (Array.isArray(k.multitap)) for (const sub of k.multitap) collectNextLayers(sub, out);
  if (k.flick && typeof k.flick === 'object') {
    for (const dir of Object.values(k.flick as Record<string, unknown>)) collectNextLayers(dir, out);
  }
}
