import { beforeEach, describe, expect, it, vi } from "vitest";
import { searchItemsByMetadata } from "../../../react/utils/searchTools";

type Condition = [condition: string, operator: string, value?: string];

describe("searchItemsByMetadata", () => {
    const executedSearches: Array<{ conditions: Condition[] }> = [];
    const resultsByTag: Record<string, number[]> = {
        policing: [7, 3],
        education: [9, 3, 1],
    };
    const itemsByID = new Map([1, 3, 7, 9].map((id) => [id, { id }] as const));

    beforeEach(() => {
        executedSearches.length = 0;

        class MockSearch {
            conditions: Condition[] = [];

            addCondition(condition: string, operator: string, value?: string) {
                this.conditions.push([condition, operator, value]);
            }

            clone(): MockSearch {
                const cloned = new MockSearch();
                cloned.conditions = this.conditions.slice();
                return cloned;
            }

            async search(): Promise<number[]> {
                executedSearches.push(this);
                const tag = this.conditions.find(
                    ([condition]) => condition === "tag",
                )?.[2];
                return tag ? (resultsByTag[tag] ?? []) : [];
            }
        }

        (globalThis as any).Zotero.Search = MockSearch;
        (globalThis as any).Zotero.Items = {
            getAsync: vi.fn(async (ids: number[]) =>
                ids.map((id) => itemsByID.get(id)),
            ),
            loadDataTypes: vi.fn(async () => undefined),
        };
    });

    it("ORs tags using separate library-scoped AND searches before sorting and limiting", async () => {
        const items = await searchItemsByMetadata(4, {
            title_query: "schools",
            tags: ["policing", "education"],
            limit: 3,
        });

        expect(executedSearches).toHaveLength(2);
        expect(executedSearches.map((search) => search.conditions)).toEqual([
            [
                ["libraryID", "is", "4"],
                ["title", "contains", "schools"],
                ["tag", "is", "policing"],
            ],
            [
                ["libraryID", "is", "4"],
                ["title", "contains", "schools"],
                ["tag", "is", "education"],
            ],
        ]);
        expect(
            executedSearches.flatMap((search) => search.conditions),
        ).not.toContainEqual(["joinMode", "any", undefined]);
        expect((globalThis as any).Zotero.Items.getAsync).toHaveBeenCalledWith([
            1, 3, 7,
        ]);
        expect(items).toEqual([{ id: 1 }, { id: 3 }, { id: 7 }]);
    });

    it("does not repeat a search for duplicate tag values", async () => {
        await searchItemsByMetadata(4, {
            tags: ["policing", "policing"],
        });

        expect(executedSearches).toHaveLength(1);
    });
});
