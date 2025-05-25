declare const _globalThis: {
  [key: string]: any;
  Zotero: _ZoteroTypes.Zotero;
  ztoolkit: ZToolkit;
  addon: typeof addon;
};

declare type ZToolkit = ReturnType<
  typeof import("../src/utils/ztoolkit").createZToolkit
>;

declare const ztoolkit: ZToolkit;

declare const rootURI: string;

declare const addon: import("../src/addon").default;

declare const __env__: "production" | "development";


declare namespace Zotero {
    namespace BetterBibTeX {
        /**
         * Better BibTeX KeyManager API
         */
        const KeyManager: {
            /**
             * Get citation key information for a Zotero item
             * @param itemID - The Zotero item ID (number)
             * @returns Object containing citation key and metadata
             */
            get(itemID: number): {
                citationKey: string;
                pinned?: boolean;
                itemID?: number;
                libraryID?: number;
                itemKey?: string;
                lcCitationKey?: string;
                retry?: boolean;
            };

            /**
             * Find first citation key record matching query
             */
            first(query: any): any;

            /**
             * Find all citation key records matching query
             */
            find(query: any): any[];

            /**
             * Get all citation key records
             */
            all(): any[];

            /**
             * Update/generate citation key for an item
             */
            update(item: Zotero.Item): string;
        };
    }
}