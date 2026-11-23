export {};

declare global {
    namespace _ZoteroTypes {
        interface Searches {
            /** A library's saved searches, trashed ones included, sorted by name. */
            getAll(libraryID: number): Promise<Zotero.Search[]>;
        }
    }

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
