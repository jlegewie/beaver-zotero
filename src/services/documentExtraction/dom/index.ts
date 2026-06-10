export {
    buildDomCitationIndex,
    resolveDomCitationId,
} from "./citationIndex";
export {
    collectDomItems,
    findNearestAnchorId,
    isFootnoteElement,
    isNonContentElement,
    mapElement,
    NON_CONTENT_SELECTOR,
    normalizeText,
    visibleTextContent,
} from "./domWalk";
export type {
    DomElementMapping,
    DomItemCandidate,
} from "./domWalk";
export {
    createDomCounters,
    parseDomSection,
} from "./sectionParser";
export {
    ensureSentencexLoaded,
    regexSplitSentences,
    setSentenceLanguage,
    splitSentences,
} from "./sentenceSplitter";
export {
    buildDomDiagnostics,
    measureSectionSourceText,
    sumExtractedTextChars,
} from "./diagnostics";
export type {
    DomExtractionCounters,
    ParseDomSectionInput,
} from "./sectionParser";
export type {
    DomCitationIndex,
    DomCitationIndexEntry,
    DomDocument,
    DomExtractionDiagnostics,
    DomItem,
    DomItemKind,
    DomSection,
    DomSentence,
} from "./schema";
