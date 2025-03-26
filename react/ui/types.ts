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