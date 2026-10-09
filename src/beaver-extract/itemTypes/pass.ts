/**
 * The item-type model as an item pass: classifies every draft item of the
 * document (`classifyItemTypes`) and relabels it with its class's draft kind
 * (`ItemTypeModel.publicKind`): headings become `section_header`, page-bottom
 * notes `footnote`, page furniture the margin filter let through `margin`
 * (internal, like the margin filter's items), and captions and everything
 * else `text`.
 *
 * It runs first in step 3, before the reference pass, which still decides
 * which items are references. The reference classifier matches the model on
 * references and its line model splits merged entries, so with a reference
 * pass to follow, this pass never emits `reference`: an item the model calls
 * a reference gets the most probable of the other classes except furniture
 * (the model read it as content, which a margin item would drop: a split-off
 * last line of an entry), and the reference pass relabels the entries it
 * claims, overriding the kind given here. The
 * reference pass reads the paragraph detector's heading verdict
 * (`DraftItem.detectorHeading`), not the kinds given here, so it decides
 * exactly as without this pass. Without a reference pass (a preset that lists
 * none), the model's references are emitted as they are.
 */

import type { ItemPass } from "../pipeline/itemPasses";
import { buildTypedDocument } from "./input";
import { argmax, classifyItemTypes, type ItemTypeClass, type ItemTypeModel } from "./model";
import { ITEM_TYPE_MODEL } from "./weights";

export const ITEM_TYPE_PASS = "itemTypes";

/**
 * Class the pass emits for stage-2 probabilities `p`: the most probable, but
 * not `reference` when the reference pass decides references, and then not
 * `furniture` for an item whose most probable class is `reference`.
 */
export function passClass(model: ItemTypeModel, p: readonly number[], referencePass = true): ItemTypeClass {
    const top = model.classes[argmax(p)];
    if (!referencePass || top !== "reference") return top;
    return model.classes[argmax(p.map((v, k) => (model.classes[k] === "reference" || model.classes[k] === "furniture" ? -Infinity : v)))];
}

export interface ItemTypePassOptions {
    model?: ItemTypeModel;
    /** A reference pass follows and decides which items are references. */
    referencePass: boolean;
}

export function itemTypePass({ model = ITEM_TYPE_MODEL, referencePass }: ItemTypePassOptions): ItemPass {
    return {
        name: ITEM_TYPE_PASS,
        run(doc, ctx) {
            const t0 = performance.now();
            const input = buildTypedDocument(doc);
            const inputMs = performance.now() - t0;
            const { probs, timings } = classifyItemTypes(input, model);
            // Copies: `items export` keeps the step-2 items as its units.
            doc.pages.forEach((page, k) => {
                page.items = page.items.map((item, i) => ({
                    ...item,
                    kind: model.publicKind[passClass(model, probs[k][i], referencePass)],
                    detectorHeading: item.kind === "section_header",
                }));
            });
            const passMs = performance.now() - t0;
            // Shared by item count, like the reference pass's time.
            const itemTotal = probs.reduce((n, page) => n + page.length, 0);
            const parts = {
                itemTypeFeaturesMs: inputMs + timings.featuresMs,
                itemTypeStage1Ms: timings.stage1Ms,
                itemTypeContextMs: timings.contextMs,
                itemTypeStage2Ms: timings.stage2Ms,
            };
            doc.pages.forEach((_, k) => {
                const share = itemTotal > 0 ? probs[k].length / itemTotal : 1 / doc.pages.length;
                ctx.addPageMs(k, passMs * share);
                for (const [part, ms] of Object.entries(parts)) ctx.addPagePartMs(k, part, ms * share);
            });
        },
    };
}
