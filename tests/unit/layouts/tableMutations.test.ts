/**
 * The mutation vocabulary, checked against the shared fixture corpus.
 *
 * The corpus is the point: a second implementation of these semantics (the
 * backend, in Python) has to agree with this one, and the only thing that can
 * hold two implementations to the same rules is a language-neutral set of
 * before / mutations / after triples. So this file is mostly a runner over
 * `tests/fixtures/artifacts/table-*` — a new `.json` there is picked up with no
 * change here — plus the few checks a fixture cannot express, above all that
 * the input spec comes back untouched.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import type { TableSpec } from "@beaver/agent-core/layouts/table";
import {
    applyMutations,
    summarize,
    type ApplyErrorCode,
    type TableMutation,
    type TableSummary,
} from "@beaver/agent-core/layouts/tableMutations";

interface MutationFixture {
    name: string;
    before: TableSpec;
    mutations: TableMutation[];
    after?: TableSpec;
    error?: { code: ApplyErrorCode };
}

interface SummaryFixture {
    name: string;
    spec: TableSpec;
    summary: TableSummary;
}

const fixturesDir = fileURLToPath(
    new URL("../../fixtures/artifacts/", import.meta.url),
);

function loadFixtures<T>(directory: string): { file: string; fixture: T }[] {
    const dir = path.join(fixturesDir, directory);
    return readdirSync(dir)
        .filter((file) => file.endsWith(".json"))
        .sort()
        .map((file) => ({
            file,
            fixture: JSON.parse(
                readFileSync(path.join(dir, file), "utf8"),
            ) as T,
        }));
}

/** Freezes an object graph, so any write into it throws under ES module strict mode. */
function deepFreeze<T>(value: T): T {
    if (value === null || typeof value !== "object") return value;
    Object.freeze(value);
    for (const nested of Object.values(value)) deepFreeze(nested);
    return value;
}

const mutationFixtures = loadFixtures<MutationFixture>("table-mutations");
const summaryFixtures = loadFixtures<SummaryFixture>("table-summaries");

describe("the table-mutation fixture corpus", () => {
    // A glob that matched nothing would otherwise make this whole file pass by
    // running no cases at all.
    it("is not empty", () => {
        expect(mutationFixtures.length).toBeGreaterThan(0);
    });

    for (const { file, fixture } of mutationFixtures) {
        it(`${file}: ${fixture.name}`, () => {
            expect(
                fixture.after !== undefined || fixture.error !== undefined,
                `${file} declares neither an "after" spec nor an expected "error"`,
            ).toBe(true);

            const before = structuredClone(fixture.before);
            const result = applyMutations(fixture.before, fixture.mutations);

            if (fixture.error) {
                if (result.ok) {
                    throw new Error(
                        `${file} expected error ${fixture.error.code}, but the mutations applied`,
                    );
                }
                expect(result.error.code).toBe(fixture.error.code);
                // The message is what a caller shows, so it has to name what
                // was wrong rather than be empty.
                expect(result.error.message.length).toBeGreaterThan(0);
            } else {
                if (!result.ok) {
                    throw new Error(`${file} failed: ${result.error.message}`);
                }
                expect(result.spec).toEqual(fixture.after);
            }

            // Every case doubles as a purity check: a rejected list must leave
            // the table exactly as it was, and an applied one must not have
            // edited the caller's spec on the way to producing a new one.
            expect(fixture.before).toEqual(before);
        });
    }
});

describe("the table-summary fixture corpus", () => {
    it("is not empty", () => {
        expect(summaryFixtures.length).toBeGreaterThan(0);
    });

    for (const { file, fixture } of summaryFixtures) {
        it(`${file}: ${fixture.name}`, () => {
            expect(summarize(fixture.spec)).toEqual(fixture.summary);
        });
    }
});

describe("applyMutations", () => {
    const spec: TableSpec = {
        id: "t",
        anchor_column_id: "paper",
        columns: [
            { id: "paper", header: "Paper", type: "reference" },
            {
                id: "method",
                header: "Method",
                type: "text",
                description: "What method does the paper use?",
            },
        ],
        rows: [
            {
                id: "r1",
                cells: {
                    paper: {
                        value: { kind: "reference", display_name: "Alpha" },
                        provenance: "imported",
                    },
                },
            },
            {
                id: "r2",
                cells: {
                    paper: {
                        value: { kind: "reference", display_name: "Beta" },
                        provenance: "imported",
                    },
                },
            },
        ],
    };

    it("does not write into the spec it was given", () => {
        const frozen = deepFreeze(structuredClone(spec));

        const result = applyMutations(frozen, [
            {
                op: "add_columns",
                columns: [{ id: "notes", header: "Notes", type: "text" }],
            },
            {
                op: "set_cells",
                cells: [
                    {
                        row: "r1",
                        column: "notes",
                        cell: {
                            value: { kind: "text", text: "Worth reading" },
                            provenance: "user",
                        },
                    },
                ],
            },
            { op: "update_column", column: "method", description: "Restated" },
            { op: "set_meta", title: "Frozen" },
        ]);

        expect(result.ok).toBe(true);
        expect(frozen).toEqual(spec);
    });

    it("shares the rows and columns it did not touch with the input spec", () => {
        const result = applyMutations(spec, [
            {
                op: "set_cells",
                cells: [
                    {
                        row: "r1",
                        column: "method",
                        cell: {
                            value: { kind: "text", text: "Survey" },
                            provenance: "extracted",
                        },
                    },
                ],
            },
        ]);

        if (!result.ok) throw new Error(result.error.message);
        // Copy on write: the untouched row is the same object, so applying a
        // mutation to a megabyte of spec costs the rows it actually changes.
        expect(result.spec.rows[1]).toBe(spec.rows[1]);
        expect(result.spec.columns).toBe(spec.columns);
        expect(result.spec.rows[0]).not.toBe(spec.rows[0]);
    });

    it("names the offending cell when it rejects a mutation", () => {
        const result = applyMutations(spec, [
            {
                op: "set_cells",
                cells: [
                    {
                        row: "ghost",
                        column: "method",
                        cell: {
                            value: { kind: "text", text: "Survey" },
                            provenance: "extracted",
                        },
                    },
                ],
            },
        ]);

        if (result.ok)
            throw new Error("expected the unknown row to be refused");
        expect(result.error.code).toBe("unknown_row");
        expect(result.error.message).toContain("ghost");
    });

    it("applies an empty mutation list as a no-op", () => {
        const result = applyMutations(spec, []);

        if (!result.ok) throw new Error(result.error.message);
        expect(result.spec).toEqual(spec);
    });
});
