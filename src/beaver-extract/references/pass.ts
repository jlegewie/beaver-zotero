/**
 * Reference-list entries as item passes.
 *
 * - `referencePass` classifies: it scores the items of every page
 *   (`planReferences`), then relabels each page's reference-list entries and
 *   splits and merges them (`applyReferencePlan`).
 * - `referenceEntriesPass` follows a pass that already labeled the
 *   reference items (the item-type pass): it only splits and merges them
 *   into entries (`planEntries`), on the pages that have any.
 */

import type { ItemPass } from "../pipeline/itemPasses";
import { applyReferencePlan, planEntries, planReferences, type ReferencePagePlan } from "./classify";
import { buildInputPage, type InputPage } from "../features/itemInput";

export interface ReferencePassOptions {
    /** Emit classified reference-list entries as `reference` items. */
    classify: boolean;
    /**
     * Receives every page's classifier input, in page order, and the plans
     * when `classify` is set (export and debugging).
     */
    collect?: (inputs: InputPage[], plans: ReferencePagePlan[] | undefined) => void;
}

export const REFERENCE_PASS = "references";

export function referencePass(options: ReferencePassOptions): ItemPass {
    return {
        name: REFERENCE_PASS,
        run(doc, ctx) {
            const tReferences = performance.now();
            const inputs = doc.pages.map((page) => buildInputPage(page, doc.styleProfile));
            const plans = options.classify ? planReferences(inputs, doc.pageCount) : undefined;
            options.collect?.(inputs, plans);
            const referencesMs = performance.now() - tReferences;
            if (!plans) return;
            const removeHyphenation = ctx.paragraphSettings?.removeHyphenation ?? true;
            const itemTotal = inputs.reduce((n, page) => n + page.items.length, 0);
            doc.pages.forEach((page, k) => {
                const tApply = performance.now();
                page.items = applyReferencePlan(page.items, plans[k], removeHyphenation);
                // Classification time is shared by item count; applying the
                // plan is the page's own.
                const share = itemTotal > 0
                    ? (referencesMs * plans[k].probs.length) / itemTotal
                    : referencesMs / doc.pages.length;
                ctx.addPageMs(k, share + (performance.now() - tApply));
            });
        },
    };
}

export const REFERENCE_ENTRIES_PASS = "referenceEntries";

export function referenceEntriesPass(): ItemPass {
    return {
        name: REFERENCE_ENTRIES_PASS,
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
