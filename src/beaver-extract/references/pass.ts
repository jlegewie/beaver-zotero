/**
 * Reference-list entries as an item pass. It follows the item-type pass,
 * which decides which items are references, and only splits and joins those
 * items into one item per entry (`planEntries`, `applyReferencePlan`), on
 * the pages that have any.
 */

import type { ItemPass } from "../pipeline/itemPasses";
import { applyReferencePlan, planEntries } from "./entries";
import { buildInputPage } from "../features/itemInput";

export const REFERENCE_PASS = "references";

export function referencePass(): ItemPass {
    return {
        name: REFERENCE_PASS,
        run(doc, ctx) {
            const removeHyphenation = ctx.paragraphSettings?.removeHyphenation ?? true;
            doc.pages.forEach((page, k) => {
                const reference = page.items.map((item) => item.kind === "reference");
                if (!reference.some(Boolean)) return;
                const t0 = performance.now();
                const [plan] = planEntries([buildInputPage(page, doc.styleProfile)], [reference]);
                page.items = applyReferencePlan(page.items, plan, removeHyphenation);
                ctx.addPageMs(k, performance.now() - t0);
            });
        },
    };
}
