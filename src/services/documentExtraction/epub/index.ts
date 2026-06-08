export {
    buildEpubCitationIndex,
    resolveEpubCitationId,
} from "./citationIndex";
export {
    extractEpubDocument,
} from "./EpubExtractor";
export {
    createEpubExtractionCounters,
    parseEpubSection,
    splitEpubSentences,
} from "./EpubSectionParser";
export {
    collectEpubDomItems,
    findNearestAnchorId,
    isEpubFootnoteElement,
    mapEpubElement,
    normalizeEpubText,
} from "./domWalk";
export type {
    EpubCitationIndex,
    EpubCitationIndexEntry,
    EpubContentKind,
    EpubDocument,
    EpubItem,
    EpubItemKind,
    EpubSection,
    EpubSentence,
} from "./schema";
export {
    EPUB_CONTENT_KIND,
    EPUB_SCHEMA_VERSION,
} from "./schema";
