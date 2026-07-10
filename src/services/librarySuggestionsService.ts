import { ApiService } from "./apiService";
import API_BASE_URL from "../utils/getAPIBaseURL";
import { logger } from "../utils/logger";
import {
    LibrarySuggestionsRequest,
    LibrarySuggestionsResponse,
    SignalItem,
    UiViewType,
} from "../../react/types/librarySuggestions";
import {
    toSignalItem,
    getActiveItems,
    getTopCollections,
    getAllCollections,
    getRecentItems,
    getLibraryShape,
} from "../utils/librarySignals";
import { isAgentSupportedItem } from "../utils/agentItemSupport";
import { store } from "../../react/store";
import {
    libraryViewAtom,
    selectedZoteroItemsAtom,
    selectedTagsAtom,
    LibraryTreeRowType,
} from "../../react/atoms/zoteroContext";
import { currentReaderAttachmentAtom } from "../../react/atoms/messageComposition";
import { isLibraryTabAtom } from "../../react/atoms/ui";
import { searchableLibraryIdsAtom } from "../../react/atoms/profile";

export interface GetSuggestionsOptions {
    /** Library to draw signals from. Defaults to the currently-viewed library. */
    libraryId?: number;
    /** Telemetry slice tag (e.g. "first_run", "home_refresh"). */
    purpose?: string;
}

const SUPPORTED_UI_VIEW_TYPES: ReadonlyArray<UiViewType> = [
    "library", "collection", "search",
    "unfiled", "duplicates", "trash",
    "publications", "retracted", "feed",
];

function mapTreeRowType(t: LibraryTreeRowType): UiViewType | null {
    if (!t) return null;
    if (t === "feeds") return "feed";
    return SUPPORTED_UI_VIEW_TYPES.includes(t as UiViewType)
        ? (t as UiViewType) : null;
}

/**
 * Frontend client for `POST /api/v1/account/library-suggestions`.
 */
export class LibrarySuggestionsService extends ApiService {
    constructor(baseUrl: string) {
        super(baseUrl);
    }

    async getSuggestions(
        options: GetSuggestionsOptions = {},
    ): Promise<LibrarySuggestionsResponse> {
        const { payload, libraryId } = await this.buildPayloadForLibrary(options);
        // Exclusions can change while the asynchronous signal queries run.
        // Re-check immediately before the network boundary so a payload already
        // in flight locally is never posted after its library is excluded.
        if (!store.get(searchableLibraryIdsAtom).includes(libraryId)) {
            throw new Error("The suggestions library was excluded from Beaver.");
        }
        logger(
            `librarySuggestionsService.getSuggestions: library=${payload.library_size} items, `
            + `${payload.active_items.length} active, ${payload.top_collections.length} top collections, `
            + `${payload.recent_items.length} recent, purpose=${payload.purpose ?? "none"}`,
        );
        return this.post<LibrarySuggestionsResponse>(
            "/api/v1/account/library-suggestions",
            payload,
        );
    }

    /**
     * Public for testing/debugging — lets callers inspect the assembled
     * payload without hitting the network.
     */
    async buildPayload(
        options: GetSuggestionsOptions = {},
    ): Promise<LibrarySuggestionsRequest> {
        return (await this.buildPayloadForLibrary(options)).payload;
    }

    private async buildPayloadForLibrary(
        options: GetSuggestionsOptions,
    ): Promise<{ payload: LibrarySuggestionsRequest; libraryId: number }> {
        // 1. UI state (Jotai)
        const view = store.get(libraryViewAtom);
        const selectedItems = store.get(selectedZoteroItemsAtom);
        const readerItem = store.get(currentReaderAttachmentAtom);
        const filterTags = store.get(selectedTagsAtom);
        const isLibraryTab = store.get(isLibraryTabAtom);
        const searchableLibraryIds = store.get(searchableLibraryIdsAtom);

        // 2. Resolve target library
        const preferredLibraryId = options.libraryId
            ?? view.libraryId
            ?? Zotero.Libraries.userLibraryID;
        const preferredIsSearchable = searchableLibraryIds.includes(preferredLibraryId);

        // An explicitly requested library must never silently resolve to a
        // different library. More importantly, fail before any Zotero item or
        // collection lookup when that requested library is excluded.
        if (options.libraryId !== undefined && !preferredIsSearchable) {
            throw new Error("The requested library is excluded from Beaver.");
        }

        // The currently viewed/default library may be excluded. In that case,
        // draw suggestions from another searchable library rather than reading
        // the excluded one. The atom is the privacy boundary's source of truth.
        const libraryId = preferredIsSearchable
            ? preferredLibraryId
            : searchableLibraryIds[0];
        if (libraryId === undefined) {
            throw new Error("No searchable Zotero libraries are available.");
        }

        // View-derived collection and tag signals are only safe and meaningful
        // when the view belongs to the resolved target library.
        const useLibraryViewContext = view.libraryId === libraryId;

        // 3. Current collection key (force-include in top_collections)
        let currentCollectionKey: string | null = null;
        if (
            useLibraryViewContext
            && view.treeRowType === "collection"
            && view.collectionId !== null
        ) {
            const coll = Zotero.Collections.get(view.collectionId);
            currentCollectionKey = coll && (coll as any).key ? (coll as any).key : null;
        }

        // 4. UI-state items resolved to regular-item snippets
        const readerSignal = (readerItem && readerItem.libraryID === libraryId)
            ? await this.toSignalForParent(readerItem)
            : null;

        const firstSelected = selectedItems.find(
            (i: Zotero.Item) => i.libraryID === libraryId && i.isRegularItem(),
        );
        let selectedSignal: SignalItem | null = null;
        if (firstSelected) {
            await Zotero.Items.loadDataTypes(
                [firstSelected],
                ["itemData", "creators", "tags", "collections", "childItems"],
            );
            selectedSignal = await toSignalItem(firstSelected);
        }

        // 5. Parallel data fetch
        const [active, topColls, allColls, recent, shape] = await Promise.all([
            getActiveItems(libraryId),
            getTopCollections(libraryId, currentCollectionKey),
            getAllCollections(libraryId),
            getRecentItems(libraryId),
            getLibraryShape(libraryId),
        ]);

        const payload: LibrarySuggestionsRequest = {
            active_items: active,
            top_collections: topColls,
            recent_items: recent,
            collections: allColls,
            total_tag_count: shape.total_tag_count,
            unfiled_item_count: shape.unfiled_item_count,
            library_size: shape.library_size,
            reader_item: readerSignal,
            selected_item: selectedSignal,
            ui_view_type: isLibraryTab && useLibraryViewContext
                ? mapTreeRowType(view.treeRowType)
                : null,
            ui_filter_tags: useLibraryViewContext ? filterTags : [],
            purpose: options.purpose ?? null,
            // Lets the backend gate version-dependent cards (e.g. the Skim card,
            // which needs frontend annotation-creation handlers). Mirrors the
            // X-Beaver-Version header but is explicit in the body for the
            // suggestions endpoint.
            client_version: Zotero.Beaver?.pluginVersion ?? null,
        };
        return { payload, libraryId };
    }

    /**
     * Resolve an attachment item (reader view) up to its parent regular item
     * before snippeting. Returns null when the open attachment isn't a type
     * Beaver can process.
     */
    private async toSignalForParent(item: Zotero.Item): Promise<SignalItem | null> {
        if (item.isAttachment() && !isAgentSupportedItem(item)) return null;
        const target = item.isAttachment() && item.parentItemID
            ? await Zotero.Items.getAsync(item.parentItemID)
            : item;
        if (!target || !target.isRegularItem()) return null;
        await Zotero.Items.loadDataTypes(
            [target],
            ["itemData", "creators", "tags", "collections", "childItems"],
        );
        return toSignalItem(target);
    }
}

export const librarySuggestionsService = new LibrarySuggestionsService(API_BASE_URL);
