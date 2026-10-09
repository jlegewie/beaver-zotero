import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { FEATURES, FEATURE_SET, FEATURE_VERSION, itemTypeFeatures } from "../../../src/beaver-extract/itemTypes/features";
import type { TypedDocument } from "../../../src/beaver-extract/itemTypes/input";
import {
    assertItemTypeModel,
    classifyItemTypes,
    contextFeatureNames,
    contextFeatures,
    type ContextUnit,
    type ItemTypeModel,
} from "../../../src/beaver-extract/itemTypes/model";
import { modelProbabilities } from "../../../src/beaver-extract/models/runtime";
import { passClass } from "../../../src/beaver-extract/itemTypes/pass";
import { ITEM_TYPE_MODEL } from "../../../src/beaver-extract/itemTypes/weights";
import { expectModelParity, type ModelParityFixture } from "../../helpers/modelParity";

const fixtures = join(__dirname, "fixtures");

/** Context parity fixture of the training repo (`bxm item-type export`). */
interface ContextParityFixture {
    classes: string[];
    names: string[];
    documents: Array<{
        units: Array<ContextUnit & { unit: number; proba: number[] }>;
        /** Context features per unit; null for NaN. */
        expected: (number | null)[][];
    }>;
}

const modelParity = JSON.parse(readFileSync(join(fixtures, "itemTypeModelParity.json"), "utf8")) as {
    stage1: ModelParityFixture;
    stage2: ModelParityFixture;
};
const contextParity = JSON.parse(readFileSync(join(fixtures, "itemTypeContextParity.json"), "utf8")) as ContextParityFixture;

describe("item-type model parity with the training pipeline", () => {
    it("ships weights for the current feature set", () => {
        expect(ITEM_TYPE_MODEL.featureSet).toBe(FEATURE_SET);
        expect(ITEM_TYPE_MODEL.featureVersion).toBe(FEATURE_VERSION);
        expect(ITEM_TYPE_MODEL.stage1.features).toEqual([...FEATURES]);
        expect(ITEM_TYPE_MODEL.stage2.features).toEqual([...FEATURES, ...contextFeatureNames(ITEM_TYPE_MODEL.classes)]);
        expect(() => assertItemTypeModel(ITEM_TYPE_MODEL)).not.toThrow();
    });

    it("emits captions as text, furniture as margin and headings as section headers", () => {
        expect(ITEM_TYPE_MODEL.publicKind).toEqual({
            caption: "text",
            footnote: "footnote",
            furniture: "margin",
            heading: "section_header",
            reference: "reference",
            text: "text",
        });
    });

    it("rejects weights trained on another feature version", () => {
        const stale: ItemTypeModel = { ...ITEM_TYPE_MODEL, stage1: { ...ITEM_TYPE_MODEL.stage1, featureVersion: FEATURE_VERSION - 1 } };
        expect(() => assertItemTypeModel(stale)).toThrow(/feature version/);
    });

    it("reproduces stage-1 probabilities", () => {
        expectModelParity(ITEM_TYPE_MODEL.stage1, modelParity.stage1);
    });

    it("reproduces stage-2 probabilities", () => {
        expectModelParity(ITEM_TYPE_MODEL.stage2, modelParity.stage2);
    });

    it("reproduces the context features", () => {
        expect(contextParity.classes).toEqual([...ITEM_TYPE_MODEL.classes]);
        expect(contextParity.names).toEqual(contextFeatureNames(ITEM_TYPE_MODEL.classes));
        expect(contextParity.documents.length).toBeGreaterThan(0);
        for (const doc of contextParity.documents) {
            const rows = contextFeatures(doc.units, doc.units.map((unit) => unit.proba));
            expect(rows).toHaveLength(doc.expected.length);
            rows.forEach((row, i) => {
                expect(row).toHaveLength(contextParity.names.length);
                row.forEach((v, j) => {
                    const want = doc.expected[i][j];
                    if (want === null) expect(v, `unit ${i} ${contextParity.names[j]}`).toBeNaN();
                    // Inputs and expected values are rounded to 9 decimals.
                    else expect(v, `unit ${i} ${contextParity.names[j]}`).toBeCloseTo(want, 8);
                });
            });
        }
    });
});

describe("item-type stage-2 skip", () => {
    // The feature parity fixture's input: a real document's step-2 items.
    const doc = (JSON.parse(readFileSync(join(fixtures, "itemTypeFeatureParity.json"), "utf8")) as { input: TypedDocument }).input;
    const stage1 = itemTypeFeatures(doc)
        .flat()
        .map((row) => modelProbabilities(ITEM_TYPE_MODEL.stage1, row.map((v) => (Number.isFinite(v) ? v : NaN))));
    const withSkip = (skipAbove: number | undefined): ItemTypeModel => ({
        ...ITEM_TYPE_MODEL,
        stage2: { ...ITEM_TYPE_MODEL.stage2, skipAbove },
    });

    it("keeps stage 1's probabilities and class for confident items and runs stage 2 for the rest", () => {
        const confidence = stage1.map((p) => Math.max(...p)).sort((a, b) => a - b);
        // Between two items' confidences, so both paths are taken.
        const skipAbove = (confidence[0] + confidence[confidence.length - 1]) / 2;
        expect(confidence[0]).toBeLessThan(skipAbove);
        const full = classifyItemTypes(doc, withSkip(undefined));
        const skipped = classifyItemTypes(doc, withSkip(skipAbove));
        const fullProbs = full.probs.flat();
        const skippedClasses = skipped.classes.flat();
        let skips = 0;
        skipped.probs.flat().forEach((p, i) => {
            if (Math.max(...stage1[i]) >= skipAbove) {
                skips++;
                expect(p).toEqual(stage1[i]);
                expect(skippedClasses[i]).toBe(ITEM_TYPE_MODEL.classes[stage1[i].indexOf(Math.max(...stage1[i]))]);
            } else {
                expect(p).toEqual(fullProbs[i]);
            }
        });
        expect(skips).toBeGreaterThan(0);
        expect(skips).toBeLessThan(stage1.length);
    });

    it("rejects a threshold outside (0, 1]", () => {
        expect(() => assertItemTypeModel(withSkip(0))).toThrow(/skipAbove/);
        expect(() => assertItemTypeModel(withSkip(1.5))).toThrow(/skipAbove/);
        expect(() => assertItemTypeModel(withSkip(Number.NaN))).toThrow(/skipAbove/);
    });
});

describe("item-type context features", () => {
    const line = (font: string, size: number, chars: number) => ({ font, size, chars });

    it("groups styles by font and size rounded to 0.5, halves to even as in Python", () => {
        // 10.25 rounds to 10.0, 10.75 to 11.0, 9.9 to 10.0.
        const units: ContextUnit[] = [
            { page: 0, lines: [line("A", 10.25, 5)] },
            { page: 0, lines: [line("A", 9.9, 5)] },
            { page: 1, lines: [line("A", 10.75, 5)] },
            { page: 1, lines: [line("A", 11, 2), line("B", 10, 9)] },
            { page: 1, lines: [] },
        ];
        const proba = [[1, 0], [0, 1], [1, 0], [0, 1], [0.5, 0.5]];
        const rows = contextFeatures(units, proba);
        const names = contextFeatureNames(["a", "b"]);
        const col = (name: string) => names.indexOf(name);
        expect(rows.map((r) => r[col("style_log_n")])).toEqual([2, 2, 1, 1, 1].map(Math.log1p));
        expect(rows[0][col("style_a")]).toBe(0.5);
        // The unit's style is the one covering most characters (B, not A at 11).
        expect(rows[3][col("style_b")]).toBe(1);
        expect(rows[0][col("page_a")]).toBe(0.5);
        expect(rows[2][col("page_a")]).toBe(0.5);
        expect(rows[2][col("page_b")]).toBe(0.5);
        expect(rows[0][col("n-1_a")]).toBeNaN();
        expect(rows[1][col("n-2_a")]).toBeNaN();
        expect(rows[1][col("n-1_a")]).toBe(1);
        expect(rows[2][col("n+2_b")]).toBe(0.5);
        expect(rows[4][col("n+1_a")]).toBeNaN();
    });
});

describe("item-type pass classes", () => {
    const p = (values: Record<string, number>) => ITEM_TYPE_MODEL.classes.map((c) => values[c] ?? 0);
    const entry = "Smith, J. (2004). A study of things. Journal of Studies, 12(3), 45–67.";

    it("emits the most probable class, references included", () => {
        expect(passClass(ITEM_TYPE_MODEL, p({ reference: 0.6, text: 0.3, footnote: 0.1 }), entry)).toBe("reference");
        expect(passClass(ITEM_TYPE_MODEL, p({ heading: 0.7, reference: 0.2, text: 0.1 }), "Results")).toBe("heading");
    });

    it("never emits a caption, table note or appendix label as a reference", () => {
        expect(passClass(ITEM_TYPE_MODEL, p({ reference: 0.6, text: 0.3, footnote: 0.1 }), "Table 2. Descriptive statistics")).toBe("text");
        expect(passClass(ITEM_TYPE_MODEL, p({ reference: 0.5, footnote: 0.4, text: 0.1 }), "Note: Standard errors in parentheses.")).toBe("footnote");
        expect(passClass(ITEM_TYPE_MODEL, p({ reference: 0.6, text: 0.4 }), "Appendix A: Journal Coverage")).toBe("text");
    });

    it("never drops a label the model reads as a reference: its fallback is not furniture", () => {
        expect(passClass(ITEM_TYPE_MODEL, p({ reference: 0.64, furniture: 0.31, footnote: 0.03, text: 0.02 }), "Figure 3. Trends")).toBe("footnote");
        expect(passClass(ITEM_TYPE_MODEL, p({ furniture: 0.6, reference: 0.3, text: 0.1 }), "Figure 3. Trends")).toBe("furniture");
    });
});
