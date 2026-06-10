import { ZoteroItemReference } from '../types/zotero';
import { revealSource } from './sourceUtils';

/**
 * Host-side navigation actions a rendered citation can trigger.
 */
export interface CitationActions {
    /** Reveal/select the referenced item in the library view. */
    revealInLibrary(ref: ZoteroItemReference): void;
    /** Open a local file (e.g. a PDF/text attachment) in the host's default handler. */
    launchFile(filePath: string): void;
    /** Open an external URL. */
    openExternalUrl(url: string): void;
}

/** Zotero plugin implementation of {@link CitationActions}. */
const zoteroCitationActions: CitationActions = {
    revealInLibrary(ref: ZoteroItemReference): void {
        revealSource(ref);
    },
    launchFile(filePath: string): void {
        Zotero.launchFile(filePath);
    },
    openExternalUrl(url: string): void {
        Zotero.getMainWindow().location.href = url;
    },
};

let citationActions: CitationActions = zoteroCitationActions;

/** Replace the citation navigation actions (e.g. a Word add-in injects its own). */
export function setCitationActions(actions: CitationActions): void {
    citationActions = actions;
}

/** The active citation navigation actions. */
export function getCitationActions(): CitationActions {
    return citationActions;
}
