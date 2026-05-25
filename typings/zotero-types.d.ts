export {};

declare global {
    type ZoteroAnnotationItem = Omit<Zotero.Item, "annotationSortIndex"> & {
        annotationSortIndex: string;
    };

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
