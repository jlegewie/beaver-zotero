export type SidebarLocation = 'library' | 'reader';

export interface DOMElements {
    chatToggleButton: HTMLElement | null;
    libraryPane: HTMLElement | null;
    libraryContent: NodeListOf<Element> | null;
    librarySidebar: HTMLElement | null;
    readerPane: HTMLElement | null;
    readerContent: NodeListOf<Element> | null;
    readerSidebar: HTMLElement | null;
}

export interface CollapseState {
    library: boolean | null;
    reader: boolean | null;
}

export interface UIState {
    isVisible: boolean;
    isLibraryTab: boolean;
    collapseState: CollapseState;
}

export type AppState = {
    view: 'library' | 'reader';
    reader_type: string | null;
    library_id: number | null;
    item_keys: string[];
    selection: string | null;
    page: number | null;
}