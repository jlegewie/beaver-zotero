import { AppState } from "../ui/types";
import { getCurrentReader, getCurrentItem, getCurrentPage, getSelectedText } from "./readerUtils";

/**
 * Retrieves the app context.
 * 
 * @returns The app context.
 */
export function getAppState(): AppState {
    const reader = getCurrentReader();
    if (reader) {
        const item = getCurrentItem(reader);
        return {
            view: 'reader',
            reader_type: reader.type,
            library_id: item.libraryID,
            item_keys: [item.key],
            selection: getSelectedText(reader),
            page: getCurrentPage(reader),
        } as AppState;
    }
    // Library view
    const items = Zotero.getActiveZoteroPane().getSelectedItems();
    return {
        view: 'library',
        reader_type: null,
        library_id: items.length > 0 ? items[0].libraryID : null,
        item_keys: items.map((item) => item.key).slice(0, 4),
        selection: null,
        page: null,
    } as AppState;
}