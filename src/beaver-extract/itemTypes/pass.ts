/**
 * The item-type model as an item pass: classifies every draft item of the
 * document (`classifyItemTypes`) and relabels it with its class's draft kind
 * (`ItemTypeModel.publicKind`): headings become `section_header`, page-bottom
 * notes `footnote`, reference-list entries `reference`, page furniture the
 * margin filter let through `margin` (internal, like the margin filter's
 * items), and captions and everything else `text`.
 *
 * It runs first in step 3. The model decides which items are references;
 * the reference pass that follows (`references/pass.ts`) only splits and
 * joins them into one item per entry.
 */

import { leadMarkerRun, lineSize } from "../features/style";
import type { DraftItem } from "../pipeline/draftItems";
import type { ItemPass } from "../pipeline/itemPasses";
import { isNonEntryLabel } from "../references/entries";
import { buildTypedDocument } from "./input";
import { argmax, classifyItemTypes, type ItemTypeClass, type ItemTypeModel } from "./model";
import { ITEM_TYPE_MODEL } from "./weights";

export const ITEM_TYPE_PASS = "itemTypes";

/**
 * Class the pass emits for an item with the text `text` and probabilities
 * `p`: the most probable, except that a caption, table note or appendix
 * label (`isNonEntryLabel`) is never a reference. Such an item gets the most
 * probable of the other classes except furniture: the model read it as
 * content, which a margin item would drop.
 */
export function passClass(model: ItemTypeModel, p: readonly number[], text: string): ItemTypeClass {
    const top = model.classes[argmax(p)];
    if (top !== "reference" || !isNonEntryLabel(text)) return top;
    return model.classes[argmax(p.map((v, k) => (model.classes[k] === "reference" || model.classes[k] === "furniture" ? -Infinity : v)))];
}

/**
 * A footnote's text with its lead marker set off ("1AI is…" → "1 AI is…"):
 * the first line opens with a short run of marker characters set smaller
 * than the line (a superscript note number, symbol or letter) that runs
 * straight into the text. The marker stays: it is how a reader matches the
 * note to the body. The sentences get the same space at sentence mapping
 * (`ParagraphTextOptions.leadMarker`).
 */
function textWithLeadMarkerApart(item: DraftItem): string {
    const line = item.lines[0];
    if (!line) return item.text;
    const marker = leadMarkerRun(line);
    if (!marker || !(marker.size < SUPERSCRIPT_LEAD_RATIO * lineSize(line))) return item.text;
    const text = item.text.trimStart();
    const lead = Array.from(text).slice(0, marker.chars).join("");
    const rest = text.slice(lead.length);
    if (!/^[0-9*†‡§¶#a-z]+$/u.test(lead) || !rest || /^\s/u.test(rest)) return item.text;
    return `${lead} ${rest}`;
}

/** A lead run set below this share of its line's size is a superscript marker. */
const SUPERSCRIPT_LEAD_RATIO = 0.85;

export interface ItemTypePassOptions {
    model?: ItemTypeModel;
}

export function itemTypePass({ model = ITEM_TYPE_MODEL }: ItemTypePassOptions = {}): ItemPass {
    return {
        name: ITEM_TYPE_PASS,
        run(doc, ctx) {
            const t0 = performance.now();
            const input = buildTypedDocument(doc);
            const inputMs = performance.now() - t0;
            const { probs, timings } = classifyItemTypes(input, model);
            // Copies: `items export` keeps the step-2 items as its units.
            const noteMarkers = ctx.paragraphSettings?.noteMarkers ?? false;
            doc.pages.forEach((page, k) => {
                page.items = page.items.map((item, i) => {
                    const kind = model.publicKind[passClass(model, probs[k][i], item.text)];
                    const text = noteMarkers && kind === "footnote" ? textWithLeadMarkerApart(item) : item.text;
                    return { ...item, kind, text };
                });
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
