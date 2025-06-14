export {};

declare global {
    interface ZoteroItemPane {
        collapsed: boolean;
    }

    interface ZoteroContextPane {
        collapsed: boolean;
        togglePane(): void;
    }

    interface ZoteroPane {
        itemPane: ZoteroItemPane;
    }

    interface CustomZoteroWindow extends Window {
        ZoteroPane: ZoteroPane;
        ZoteroContextPane: ZoteroContextPane;
    }
}
