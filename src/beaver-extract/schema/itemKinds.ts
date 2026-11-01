import type { DocItem } from "@beaver/agent-core/extract/types";
import { ID_PREFIXES, type DocumentItemKind } from "@beaver/agent-core/extract/schema";

/** What the pipeline does with the items of one kind. */
export interface ItemKindPolicy {
    /** Split into sentences, each with its own id and boxes. */
    sentences: boolean;
    /**
     * Part of the public document, cited by its id. Other kinds stay internal
     * (debug output only).
     */
    citable: boolean;
    /** Public items of the kind always carry `text` (a picture's is optional). */
    hasText: boolean;
    /** Id prefix; `ID_PREFIXES` is the source, since citation grammar reads it too. */
    idPrefix: string;
}

/** The policy of every item kind. */
export const ITEM_KINDS = {
    text: { sentences: true, citable: true, hasText: true, idPrefix: ID_PREFIXES.text },
    section_header: { sentences: false, citable: true, hasText: true, idPrefix: ID_PREFIXES.section_header },
    list_item: { sentences: true, citable: true, hasText: true, idPrefix: ID_PREFIXES.list_item },
    caption: { sentences: true, citable: true, hasText: true, idPrefix: ID_PREFIXES.caption },
    footnote: { sentences: true, citable: true, hasText: true, idPrefix: ID_PREFIXES.footnote },
    formula: { sentences: false, citable: true, hasText: true, idPrefix: ID_PREFIXES.formula },
    table: { sentences: true, citable: true, hasText: true, idPrefix: ID_PREFIXES.table },
    picture: { sentences: false, citable: true, hasText: false, idPrefix: ID_PREFIXES.picture },
    reference: { sentences: false, citable: true, hasText: true, idPrefix: ID_PREFIXES.reference },
    margin: { sentences: false, citable: false, hasText: true, idPrefix: ID_PREFIXES.margin },
} as const satisfies Record<DocumentItemKind, ItemKindPolicy>;

/** Kinds that are split into sentences. */
export type SentenceBearingKind = {
    [K in DocumentItemKind]: (typeof ITEM_KINDS)[K]["sentences"] extends true ? K : never;
}[DocumentItemKind];

/** An internal item of a sentence-bearing kind. */
export type SentenceBearingItem = Extract<DocItem, { kind: SentenceBearingKind }>;

/** Whether items of `kind` are split into sentences. */
export function kindCarriesSentences(kind: DocumentItemKind): kind is SentenceBearingKind {
    return ITEM_KINDS[kind].sentences;
}

/** Whether an internal item is of a sentence-bearing kind. */
export function carriesSentences(item: DocItem): item is SentenceBearingItem {
    return ITEM_KINDS[item.kind].sentences;
}
