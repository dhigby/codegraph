import { Node } from '../types';
import { generateNodeId } from './tree-sitter-helpers';

/**
 * Shared helpers for the Keyman extractor family.
 *
 * Language coverage is the one piece of metadata captured for *every* keyboard,
 * but it lives in different files depending on the keyboard's lineage: in the
 * `.kps` package source (`<Languages><Language ID="…">`) for release /
 * experimental keyboards, and in the committed `.keyboard_info` JSON
 * (`languages` map) for legacy binary-only keyboards (which have no `.kps`).
 * Both extractors emit identical-shaped language nodes via `buildLanguageNode`
 * so a query like "which keyboards support language X" resolves uniformly
 * across the whole repo.
 */

/**
 * Build a `constant` node for a BCP-47 language tag a keyboard supports. The
 * node name is the tag (e.g. `km`, `fub-Latn`) and the human display name goes
 * in the signature — both are full-text indexed, so the language is findable by
 * tag or by name. `ordinal` only disambiguates the generated id within a file.
 */
export function buildLanguageNode(
  filePath: string,
  tag: string,
  displayName: string | undefined,
  ordinal: number
): Node {
  const id = generateNodeId(filePath, 'constant', `lang:${tag}`, ordinal);
  return {
    id,
    kind: 'constant',
    name: tag,
    qualifiedName: `${filePath}::lang:${tag}`,
    filePath,
    language: 'keyman',
    signature: displayName ? `language ${tag} — ${displayName}` : `language ${tag}`,
    startLine: 1,
    endLine: 1,
    startColumn: 0,
    endColumn: 0,
    updatedAt: Date.now(),
  };
}
