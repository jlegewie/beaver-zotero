import type { ClientHost } from './types';

export type {
    ClientHost,
    NavigationHost,
    ItemDataHost,
    DocumentExportHost,
    ConfigHost,
    ComponentsHost,
    ExternalReferenceActionsProps,
    ExternalReferenceActionMode,
    AgentActionInStreamProps,
    HostButtonVariant,
    ResolvedItemDisplay,
    CitationActivation,
    CitationExportRequest,
    CitationExportRender,
} from './types';

/**
 * Default host: no capabilities. A non-Zotero client can run the render surface
 * with this empty host; renderers degrade gracefully (e.g. page labels fall
 * back to raw numbers, navigation clicks become no-ops). The Zotero plugin
 * registers its implementation at bundle init via {@link setHost}.
 */
let host: ClientHost = {};

/** Replace the active client host (each client registers its own at init). */
export function setHost(next: ClientHost): void {
    host = next;
}

/** The active client host. Slices are optional — check before use. */
export function getHost(): ClientHost {
    return host;
}
