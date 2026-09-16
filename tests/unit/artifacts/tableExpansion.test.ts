// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { atom, createStore, Provider } from "jotai";
import { afterEach, expect, it, vi } from "vitest";

vi.mock("@beaver/agent-core/run-state/atoms", () => ({
    toolResultAtom: () => resultAtom,
    getToolCallStatusFromResult: () => "completed",
}));
vi.mock("../../../react/agents/agentActions", () => ({
    getPendingApprovalForToolcallAtom: atom(() => () => null),
    getAgentActionsByToolcallAtom: atom(() => () => []),
}));
vi.mock("../../../react/utils/toolCallLabelEnrich", () => ({
    resolveToolCallLabelEnrich: async () => null,
}));
vi.mock("../../../react/components/agentRuns/GenericAgentActionView", () => ({
    GenericAgentActionView: () => null,
}));
vi.mock("../../../react/components/agentRuns/ToolResultView", () => ({
    ToolResultView: () => React.createElement("div", null, "Result body"),
}));

import { ToolCallPartView } from "../../../react/components/agentRuns/ToolCallPartView";
import { toolExpandedAtom } from "../../../react/atoms/messageUIState";
import type { ToolReturnPart } from "@beaver/agent-core/agents/types";

const resultAtom = atom<ToolReturnPart | undefined>(undefined);
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | undefined;
let container: HTMLDivElement | undefined;
afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
});

it.each([
    { kind: "table card", tool: "create_table", expanded: true },
    { kind: "table status", tool: "fill_table", expanded: true },
    { kind: "ordinary result", tool: "get_metadata", expanded: false },
])(
    "toggles $kind from its displayed default on the first click",
    async ({ kind, tool, expanded }) => {
        const store = createStore();
        store.set(resultAtom, {
            part_kind: "tool-return",
            tool_name: tool,
            tool_call_id: "call",
            content:
                kind === "table status"
                    ? { ok: false, error_code: "schema_changed" }
                    : { ok: true },
            ...(kind === "table card"
                ? {
                      metadata: {
                          view: {
                              view_type: "table",
                              record: {
                                  reference: {
                                      kind: "table",
                                      key: "u-ABCDEFGH",
                                      title: "Table",
                                  },
                                  change: "Created table",
                                  summary: { rows: 1, columns: 1 },
                              },
                          },
                      },
                  }
                : {}),
        });
        container = document.createElement("div");
        document.body.append(container);
        root = createRoot(container);
        await act(async () =>
            root!.render(
                React.createElement(
                    Provider,
                    { store },
                    React.createElement(ToolCallPartView, {
                        part: {
                            part_kind: "tool-call",
                            tool_name: tool,
                            tool_call_id: "call",
                            args: {},
                        },
                        runId: "run",
                        responseIndex: 0,
                        runStatus: "completed",
                    }),
                ),
            ),
        );
        const button = container.querySelector<HTMLButtonElement>(
            "button[aria-expanded]",
        )!;
        expect(store.get(toolExpandedAtom)["run:0:call"]).toBeUndefined();
        expect(button.getAttribute("aria-expanded")).toBe(String(expanded));

        act(() => button.click());
        expect(button.getAttribute("aria-expanded")).toBe(String(!expanded));
        expect(store.get(toolExpandedAtom)["run:0:call"]).toBe(!expanded);
        expect(!!container.querySelector("#tool-result-call")).toBe(!expanded);

        act(() => button.click());
        expect(button.getAttribute("aria-expanded")).toBe(String(expanded));
        expect(!!container.querySelector("#tool-result-call")).toBe(expanded);
    },
);
