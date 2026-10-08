/**
 * Reference classification as an item pass: scores the items of every page
 * (`planReferences`), then relabels each page's reference-list entries and
 * splits and merges them (`applyReferencePlan`).
 */

import type { ItemPass } from "../pipeline/itemPasses";
import { applyReferencePlan, planReferences, type ReferencePagePlan } from "./classify";
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
