// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { atom, createStore, Provider } from "jotai";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const received = vi.hoisted(() => ({ searchDetails: [] as unknown[] }));

vi.mock("@beaver/agent-core/run-state/atoms", () => ({
    toolResultAtom: () => resultAtom,
    getToolCallStatusFromResult: () => "completed",
}));
vi.mock("../../../react/agents/agentActions", () => ({
    pendingApprovalForToolcallAtom: () => atom(null),
    agentActionsForToolcallAtom: () => atom([]),
}));
vi.mock("../../../react/utils/toolCallLabelEnrich", () => ({
    resolveToolCallLabelEnrich: async () => null,
}));
vi.mock("../../../react/components/agentRuns/GenericAgentActionView", () => ({
    GenericAgentActionView: () => null,
}));
vi.mock("../../../react/components/agentRuns/ToolResultView", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../../../react/components/agentRuns/ToolResultView")>()),
    ToolResultView: (props: { searchDetails?: unknown }) => {
        received.searchDetails.push(props.searchDetails);
        return React.createElement("div", null, "Result body");
    },
}));

import { ToolCallPartView } from "../../../react/components/agentRuns/ToolCallPartView";
import { setToolExpandedAtom } from "../../../react/atoms/messageUIState";
import { setHost } from "@beaver/agent-ui/host";
import type { ToolReturnPart } from "@beaver/agent-core/agents/types";

const resultAtom = atom<ToolReturnPart | undefined>(undefined);
const openExternalUrl = vi.fn();
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | undefined;
let container: HTMLDivElement | undefined;

beforeEach(() => {
    received.searchDetails = [];
    openExternalUrl.mockReset();
    setHost({ navigation: { openExternalUrl } } as any);
});

afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
});

const pubmedView = (references: unknown[]) => ({
    view_type: "external_reference_list",
    tool_name: "pubmed_search",
    references,
    tool_info: {
        info_type: "search",
        source: "pubmed",
        source_label: "PubMed",
        query: "semaglutide obesity",
        query_translation: '"semaglutide"[MeSH Terms] AND "obesity"[MeSH Terms]',
        total_count: references.length,
        returned: references.length,
        search_url: "https://pubmed.ncbi.nlm.nih.gov/?term=semaglutide+obesity",
    },
});

const record = { source: "pubmed", source_id: "pmid:1", title: "Paper", library_items: [] };

async function renderCard(view: unknown, toolName = "pubmed_search", expanded?: boolean) {
    const store = createStore();
    store.set(resultAtom, {
        part_kind: "tool-return",
        tool_name: toolName,
        tool_call_id: "call",
        content: { ok: true },
        metadata: { view },
    } as ToolReturnPart);
    if (expanded !== undefined) store.set(setToolExpandedAtom, { key: "run:0:call", expanded });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () =>
        root!.render(
            React.createElement(
                Provider,
                { store },
                React.createElement(ToolCallPartView, {
                    part: { part_kind: "tool-call", tool_name: toolName, tool_call_id: "call", args: { query: "semaglutide obesity" } },
                    runId: "run",
                    responseIndex: 0,
                    runStatus: "completed",
                }),
            ),
        ),
    );
    return container;
}

const detailsButton = (el: HTMLElement) => el.querySelector<HTMLButtonElement>('button[aria-label="Search details"]');
const openButton = (el: HTMLElement) => el.querySelector<HTMLButtonElement>('button[aria-label="Open in PubMed"]');

it("keeps a collapsed search a plain line without actions", async () => {
    const el = await renderCard(pubmedView([record]));
    expect(detailsButton(el)).toBeNull();
    expect(openButton(el)).toBeNull();
});

it("shows the search actions on the expanded card and toggles the details panel", async () => {
    const el = await renderCard(pubmedView([record]), "pubmed_search", true);
    const button = detailsButton(el)!;
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(button.getAttribute("aria-controls")).toBe("search-details-call");
    expect(received.searchDetails.at(-1)).toEqual({ open: false, id: "search-details-call" });

    act(() => button.click());
    expect(button.getAttribute("aria-expanded")).toBe("true");
    expect(received.searchDetails.at(-1)).toEqual({ open: true, id: "search-details-call" });

    act(() => openButton(el)!.click());
    expect(openExternalUrl).toHaveBeenCalledWith("https://pubmed.ncbi.nlm.nih.gov/?term=semaglutide+obesity");
});

it("lets a search that found nothing expand, with its details open", async () => {
    const el = await renderCard(pubmedView([]), "pubmed_search", true);
    expect(el.querySelector("#tool-result-call")).not.toBeNull();
    expect(detailsButton(el)!.getAttribute("aria-expanded")).toBe("true");
    expect(received.searchDetails.at(-1)).toEqual({ open: true, id: "search-details-call" });
});

it("gives other tools no header actions", async () => {
    const el = await renderCard(
        { view_type: "tag_list", tool_name: "list_tags", tags: [], total_count: 1 },
        "list_tags",
        true,
    );
    expect(el.querySelector("#tool-result-call")).not.toBeNull();
    expect(detailsButton(el)).toBeNull();
    expect(el.querySelector('button[aria-label^="Open"]')).toBeNull();
});
