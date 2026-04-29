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
import { store } from "../../react/store";
import {
    libraryViewAtom,
    selectedZoteroItemsAtom,
    selectedTagsAtom,
    LibraryTreeRowType,
} from "../../react/atoms/zoteroContext";
import { currentReaderAttachmentAtom } from "../../react/atoms/messageComposition";
import { isLibraryTabAtom } from "../../react/atoms/ui";

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
        const payload = await this.buildPayload(options);
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
        // 1. UI state (Jotai)
        const view = store.get(libraryViewAtom);
        const selectedItems = store.get(selectedZoteroItemsAtom);
        const readerItem = store.get(currentReaderAttachmentAtom);
        const filterTags = store.get(selectedTagsAtom);
        const isLibraryTab = store.get(isLibraryTabAtom);

        // 2. Resolve target library
        const libraryId = options.libraryId
            ?? view.libraryId
            ?? Zotero.Libraries.userLibraryID;

        // 3. Current collection key (force-include in top_collections)
        let currentCollectionKey: string | null = null;
        if (view.treeRowType === "collection" && view.collectionId !== null) {
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
                ["itemData", "creators", "tags", "collections"],
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

        return {
            active_items: active,
            top_collections: topColls,
            recent_items: recent,
            collections: allColls,
            total_tag_count: shape.total_tag_count,
            unfiled_item_count: shape.unfiled_item_count,
            library_size: shape.library_size,
            reader_item: readerSignal,
            selected_item: selectedSignal,
            ui_view_type: isLibraryTab ? mapTreeRowType(view.treeRowType) : null,
            ui_filter_tags: filterTags,
            purpose: options.purpose ?? null,
        };
    }

    /** Resolve an attachment item (reader view) up to its parent regular item before snippeting. */
    private async toSignalForParent(item: Zotero.Item): Promise<SignalItem | null> {
        const target = item.isAttachment() && item.parentItemID
            ? await Zotero.Items.getAsync(item.parentItemID)
            : item;
        if (!target || !target.isRegularItem()) return null;
        await Zotero.Items.loadDataTypes(
            [target],
            ["itemData", "creators", "tags", "collections"],
        );
        return toSignalItem(target);
    }
}

export const librarySuggestionsService = new LibrarySuggestionsService(API_BASE_URL);
