export {
    buildDomCitationIndex,
    resolveDomCitationId,
} from "./citationIndex";
export {
    collectDomItems,
    findNearestAnchorId,
    isFootnoteElement,
    mapElement,
    normalizeText,
} from "./domWalk";
export type {
    DomElementMapping,
    DomItemCandidate,
} from "./domWalk";
export {
    createDomCounters,
    parseDomSection,
    splitSentences,
} from "./sectionParser";
export type {
    DomExtractionCounters,
    ParseDomSectionInput,
} from "./sectionParser";
export type {
    DomCitationIndex,
    DomCitationIndexEntry,
    DomDocument,
    DomItem,
    DomItemKind,
    DomSection,
    DomSentence,
} from "./schema";
