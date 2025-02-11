import { getString } from "../../../utils/locale";

export class BeaverMenuFactory {
    static registerMenuItems() {
        // Add to Beaver menu item
        ztoolkit.Menu.register("item", {
            tag: "menuitem",
            id: "zotero-itemmenu-beaver-upsert",
            label: getString("beaver-menu-upsert"),
            commandListener: (ev) => {
                ztoolkit.getGlobal("alert")("Upserting item to Beaver...");
                // Future: Call processing service here
            },
        });
    }
} 