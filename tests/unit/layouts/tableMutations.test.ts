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
import type {
    CellValue,
    Column,
    TableSpec,
} from "@beaver/agent-core/layouts/table";
import {
    applyMutations,
    summarize,
    type ApplyErrorCode,
    type SkippedCell,
    type TableMutation,
    type TableSummary,
} from "@beaver/agent-core/layouts/tableMutations";
import {
    isStale,
    questionHash,
    staleReason,
} from "@beaver/agent-core/layouts/table";

interface MutationFixture {
    name: string;
    before: TableSpec;
    mutations: TableMutation[];
    after?: TableSpec;
    skipped?: SkippedCell[];
    error?: { code: ApplyErrorCode };
    /** `edit` applies as the provider's `edit`; absent, a guarded `write`. */
    operation?: "write" | "edit";
}

interface SummaryFixture {
    name: string;
    spec: TableSpec;
    summary: TableSummary;
}

/** `stale` lists every `[row, column]` cell {@link isStale} reports, in table order. */
interface StalenessFixture {
    name: string;
    spec: TableSpec;
    stale: [string, string][];
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

/**
 * Cells whose select label is not one of their column's options — the state
 * add-only options (D27) exist to make unreachable. Named so a failure says
 * which cell and which label broke it.
 */
function unknownSelectLabels(spec: TableSpec): string[] {
    const columns = new Map(spec.columns.map((column) => [column.id, column]));
    const unknown: string[] = [];
    for (const row of spec.rows) {
        for (const [columnId, cell] of Object.entries(row.cells)) {
            const value = cell.value;
            if (value?.kind !== "select") continue;
            const options = columns.get(columnId)?.options ?? [];
            if (!options.some((option) => option.label === value.label))
                unknown.push(`${row.id}/${columnId}: "${value.label}"`);
        }
    }
    return unknown;
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
const stalenessFixtures = loadFixtures<StalenessFixture>("table-staleness");

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

            // A corpus that started from a broken spec could not prove the
            // invariant below survives a mutation.
            expect(
                unknownSelectLabels(fixture.before),
                `${file} starts from cells whose select label is not among their column's options`,
            ).toEqual([]);

            const before = structuredClone(fixture.before);
            const result = applyMutations(fixture.before, fixture.mutations, {
                skipMissing: fixture.operation === "edit",
            });

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
                expect(result.skipped).toEqual(fixture.skipped ?? []);
                // The invariant add-only options buy: no mutation can leave a
                // cell holding a label its column does not offer, so a renderer
                // never has to decide what a colourless, unfilterable category
                // looks like.
                expect(unknownSelectLabels(result.spec)).toEqual([]);
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

describe("the table-staleness fixture corpus", () => {
    it("is not empty", () => {
        expect(stalenessFixtures.length).toBeGreaterThan(0);
    });

    for (const { file, fixture } of stalenessFixtures) {
        it(`${file}: ${fixture.name}`, () => {
            const stale: [string, string][] = [];
            for (const row of fixture.spec.rows)
                for (const column of fixture.spec.columns)
                    if (isStale(row, row.cells[column.id]))
                        stale.push([row.id, column.id]);
            expect(stale).toEqual(fixture.stale);
        });
    }

    it("says whether the question or the row's document changed", () => {
        const read = {
            outcome: "answered",
            provenance: "model",
            value: { kind: "text", text: "Survey" },
            documents: ["u-A"],
        } as const;
        expect(staleReason({ documents: ["u-A"] }, read)).toBeUndefined();
        expect(staleReason({ documents: ["u-B"] }, read)).toBe("document");
        expect(staleReason({ documents: ["u-A"] }, { ...read, stale: true })).toBe(
            "question",
        );
        expect(
            staleReason(
                { documents: ["u-B"] },
                { outcome: "answered", provenance: "user", value: read.value },
            ),
        ).toBeUndefined();
    });
});

describe("questionHash", () => {
    // Pinned: the backend computes the same digests.
    it("matches the backend's digests", () => {
        expect(
            questionHash({
                type: "text",
                description: "What method does the paper use?",
            }),
        ).toBe("5765cec3bb59ae1b");
        expect(questionHash({ type: "text" })).toBe("6baca648789c851c");
        expect(
            questionHash({ type: "date", description: "Größe — n?" }),
        ).toBe("436d71d9618fdb43");
    });

    it("follows the type and the description", () => {
        const column = { type: "text" as const, description: "Q?" };
        expect(questionHash({ ...column, description: "Q2?" })).not.toBe(
            questionHash(column),
        );
        expect(questionHash({ ...column, type: "date" })).not.toBe(
            questionHash(column),
        );
    });

    const design = {
        type: "select" as const,
        description: "What is the study design?",
        options: [
            {
                label: "RCT",
                color: "blue" as const,
                description: "Units are randomly assigned to arms.",
            },
            { label: "Observational" },
            {
                label: "Quasi-experimental",
                description: "Assignment follows an external rule.",
            },
        ],
    };

    it("matches the backend's digests for option definitions", () => {
        expect(questionHash(design)).toBe("7dc398c2ee79acd0");
        expect(
            questionHash({
                type: "select",
                description: "Studiendesign?",
                options: [
                    {
                        label: "Größe",
                        description: 'Zeile eins\nZeile — zwei "zitiert"',
                    },
                    { label: "Ära 𝔸", description: "日本語の定義" },
                ],
            }),
        ).toBe("e752f6b8da55d15c");
    });

    it("hashes a column without definitions exactly as before options counted", () => {
        const plain = {
            type: "select" as const,
            description: "What method does the paper use?",
        };
        expect(
            questionHash({
                ...plain,
                options: [{ label: "Survey", color: "blue" }],
            }),
        ).toBe(questionHash(plain));
    });

    it("ignores option order, colour, spelling and undefined labels", () => {
        const hash = questionHash(design);
        expect(
            questionHash({ ...design, options: [...design.options].reverse() }),
        ).toBe(hash);
        expect(
            questionHash({
                ...design,
                options: [
                    { ...design.options[0], label: "rct.", color: "red" },
                    ...design.options.slice(1),
                    { label: "Case study" },
                ],
            }),
        ).toBe(hash);
        expect(
            questionHash({
                ...design,
                options: [
                    { ...design.options[0], description: "Lottery." },
                    ...design.options.slice(1),
                ],
            }),
        ).not.toBe(hash);
    });
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
                        outcome: "answered",
                        value: { kind: "reference", display_name: "Alpha" },
                        provenance: "system",
                    },
                },
            },
            {
                id: "r2",
                cells: {
                    paper: {
                        outcome: "answered",
                        value: { kind: "reference", display_name: "Beta" },
                        provenance: "system",
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
                            outcome: "answered",
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
                            outcome: "answered",
                            value: { kind: "text", text: "Survey" },
                            provenance: "model",
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
                            outcome: "answered",
                            value: { kind: "text", text: "Survey" },
                            provenance: "model",
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

    it("re-spells a label written earlier in the same mutation list", () => {
        const result = applyMutations(spec, [
            {
                op: "add_columns",
                columns: [{ id: "design", header: "Design", type: "select" }],
            },
            {
                op: "set_cells",
                cells: [
                    {
                        row: "r1",
                        column: "design",
                        cell: {
                            outcome: "answered",
                            value: { kind: "select", label: "RCT" },
                            provenance: "model",
                        },
                    },
                ],
            },
            {
                op: "update_column",
                column: "design",
                options: [{ label: "rct" }],
            },
        ]);

        if (!result.ok) throw new Error(result.error.message);
        // The options update sees the cell the earlier write appended an option
        // for, so the two rules compose instead of leaving an orphan.
        expect(result.spec.rows[0].cells.design.value).toEqual({
            kind: "select",
            label: "rct",
        });
        expect(result.spec.columns[2].options).toEqual([
            { label: "rct", color: "blue" },
        ]);
    });

    it("applies an empty mutation list as a no-op", () => {
        const result = applyMutations(spec, []);

        if (!result.ok) throw new Error(result.error.message);
        expect(result.spec).toEqual(spec);
        expect(result.skipped).toEqual([]);
    });

    it("refuses to grow a table past the row cap but lets it shrink", () => {
        const rows = Array.from({ length: 1001 }, (_, i) => ({
            id: `r${i}`,
            cells: {},
        }));
        const grown = applyMutations(
            { ...spec, rows: rows.slice(0, 1000) },
            [{ op: "add_rows", rows: [rows[1000]] }],
        );
        expect(grown.ok ? null : grown.error.code).toBe("too_large");
        const shrunk = applyMutations({ ...spec, rows }, [
            { op: "remove_rows", rows: ["r0"] },
        ]);
        expect(shrunk.ok).toBe(true);
    });
});
