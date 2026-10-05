/**
 * Footnote numbering for note-style citation styles.
 *
 * With a note style every citation cluster becomes a footnote, and the
 * citation processor needs each cluster's footnote number to format the
 * sequence (first vs. subsequent notes, "Ibid."). Markdown footnotes
 * (`[^1]`) take numbers from the same sequence, so the numbering is computed
 * by walking the document in the order the writers emit it. A citation inside
 * a markdown footnote does not get a footnote of its own; it is formatted as
 * part of the note it sits in.
 */

import type { MdBlock, MdFootnoteDefinition, MdInline } from '../mdast';
import type { ExportDoc } from '../types';

export interface NotePlacement {
    /** Footnote number the cluster's text appears in. */
    noteIndex: number;
    /** True when the cluster creates its own footnote. */
    ownFootnote: boolean;
}

/** Markdown footnote definitions of a section, by identifier. */
export function footnoteDefinitions(
    blocks: MdBlock[],
    definitions = new Map<string, MdFootnoteDefinition>(),
): Map<string, MdFootnoteDefinition> {
    // GFM allows definitions inside containers (list items, quotes).
    for (const block of blocks) {
        if (block.type === 'footnoteDefinition') {
            if (!definitions.has(block.identifier)) definitions.set(block.identifier, block);
        } else if (block.type === 'blockquote') {
            footnoteDefinitions(block.children, definitions);
        } else if (block.type === 'list') {
            for (const item of block.children) footnoteDefinitions(item.children, definitions);
        }
    }
    return definitions;
}

interface RenderedWalk {
    /** A citation cluster, and whether it sits inside a markdown footnote. */
    citation(clusterIndex: number, insideFootnote: boolean): void;
    /** A markdown footnote opens (its citations follow until `endFootnote`). */
    footnote(): void;
    endFootnote(): void;
}

/**
 * Visit citations and markdown footnotes in the order the writers emit them:
 * body content in order, each markdown footnote's content at its reference.
 * Footnote definitions that are never referenced are never written.
 */
function walkRendered(doc: ExportDoc, walk: RenderedWalk): void {
    // A footnote referenced again is the same note, written once.
    const written = new Set<MdFootnoteDefinition>();
    const visitInlines = (nodes: MdInline[], definitions: Map<string, MdFootnoteDefinition>, insideFootnote: boolean) => {
        for (const node of nodes) {
            switch (node.type) {
                case 'citation':
                    walk.citation(node.clusterIndex, insideFootnote);
                    break;
                case 'footnoteReference': {
                    // Writers do not nest footnotes.
                    if (insideFootnote) break;
                    const definition = definitions.get(node.identifier);
                    if (!definition || written.has(definition)) break;
                    written.add(definition);
                    walk.footnote();
                    visitBlocks(definition.children, definitions, true);
                    walk.endFootnote();
                    break;
                }
                case 'emphasis':
                case 'strong':
                case 'delete':
                case 'link':
                    visitInlines(node.children, definitions, insideFootnote);
                    break;
                default:
                    break;
            }
        }
    };

    const visitBlocks = (blocks: MdBlock[], definitions: Map<string, MdFootnoteDefinition>, insideFootnote: boolean) => {
        for (const block of blocks) {
            switch (block.type) {
                case 'paragraph':
                case 'heading':
                    visitInlines(block.children, definitions, insideFootnote);
                    break;
                case 'blockquote':
                    visitBlocks(block.children, definitions, insideFootnote);
                    break;
                case 'list':
                    for (const item of block.children) visitBlocks(item.children, definitions, insideFootnote);
                    break;
                case 'table':
                    // Writers do not put tables in footnotes.
                    if (insideFootnote) break;
                    for (const row of block.children) {
                        for (const cell of row.children) visitInlines(cell.children, definitions, insideFootnote);
                    }
                    break;
                default:
                    break;
            }
        }
    };

    for (const section of doc.sections) {
        visitBlocks(section.children, footnoteDefinitions(section.children), false);
    }
}

/**
 * Cluster indices in the order they appear in the written document, each
 * once (first appearance). A citation processor must see clusters in this
 * order: a citation inside a markdown footnote comes where the footnote is
 * referenced, not where its definition sits. Clusters that are never written
 * (in unreferenced footnote definitions) are left out.
 */
export function renderedClusterOrder(doc: ExportDoc): number[] {
    const order: number[] = [];
    const seen = new Set<number>();
    walkRendered(doc, {
        citation: index => {
            if (!seen.has(index)) {
                seen.add(index);
                order.push(index);
            }
        },
        footnote: () => {},
        endFootnote: () => {},
    });
    return order;
}

/**
 * Assign footnote numbers. `createsFootnote(clusterIndex)` says whether a
 * cluster outside a footnote becomes one (it has something the processor
 * formatted).
 */
export function assignNotePlacements(
    doc: ExportDoc,
    createsFootnote: (clusterIndex: number) => boolean,
): Map<number, NotePlacement> {
    const placements = new Map<number, NotePlacement>();
    let counter = 0;
    walkRendered(doc, {
        citation: (index, insideFootnote) => {
            if (placements.has(index)) return;
            if (insideFootnote) {
                placements.set(index, { noteIndex: counter, ownFootnote: false });
            } else if (createsFootnote(index)) {
                counter += 1;
                placements.set(index, { noteIndex: counter, ownFootnote: true });
            }
        },
        footnote: () => { counter += 1; },
        endFootnote: () => {},
    });
    return placements;
}
