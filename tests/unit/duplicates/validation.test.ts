import { expect, it, vi } from "vitest";
vi.mock("@beaver/agent-core/platform/logger", () => ({ logger: vi.fn() }));
vi.mock("../../../src/services/duplicates/merge", () => ({ validateMergeItemsAction: vi.fn() }));
vi.mock("../../../src/services/agentDataProvider/utils", () => ({}));
vi.mock("../../../src/services/agentDataProvider/actions/createCollection", () => ({ validateCreateCollectionAction: vi.fn() }));
vi.mock("../../../src/services/agentDataProvider/actions/createHighlightAnnotations", () => ({ validateCreateHighlightAnnotationsAction: vi.fn() }));
vi.mock("../../../src/services/agentDataProvider/actions/createItems", () => ({ validateCreateItemAction: vi.fn() }));
vi.mock("../../../src/services/agentDataProvider/actions/createNote", () => ({ validateCreateNoteAction: vi.fn() }));
vi.mock("../../../src/services/agentDataProvider/actions/createNoteAnnotations", () => ({ validateCreateNoteAnnotationsAction: vi.fn() }));
vi.mock("../../../src/services/agentDataProvider/actions/editAnnotations", () => ({ validateEditAnnotationsAction: vi.fn() }));
vi.mock("../../../src/services/agentDataProvider/actions/editMetadata", () => ({ validateEditMetadataAction: vi.fn() }));
vi.mock("../../../src/services/agentDataProvider/actions/editNote", () => ({ validateEditNoteAction: vi.fn() }));
vi.mock("../../../src/services/agentDataProvider/actions/editNoteBatch", () => ({ validateEditNoteBatchAction: vi.fn() }));
vi.mock("../../../src/services/agentDataProvider/actions/manageCollections", () => ({ validateManageCollectionsAction: vi.fn() }));
vi.mock("../../../src/services/agentDataProvider/actions/manageTags", () => ({ validateManageTagsAction: vi.fn() }));
vi.mock("../../../src/services/agentDataProvider/actions/organizeItems", () => ({ validateOrganizeItemsAction: vi.fn() }));
vi.mock("../../../src/services/agentDataProvider/actions/importItems", () => ({ validateImportItemsAction: vi.fn(async () => ({ valid: true })) }));
const deferredCommits = vi.hoisted(() => ({ wait: vi.fn(async () => true) }));
vi.mock("../../../src/services/committedTransaction", () => ({ waitForDeferredCommits: deferredCommits.wait }));
import { duplicateError } from "../../../src/services/duplicates/discovery";
import { validateMergeItemsAction } from "../../../src/services/duplicates/merge";
import { validateImportItemsAction } from "../../../src/services/agentDataProvider/actions/importItems";
import { handleAgentActionValidateRequest } from "../../../src/services/agentDataProvider/handleAgentActionValidateRequest";
it.each([
    [duplicateError("Read-only library", "library_not_editable"), "library_not_editable"],
    [duplicateError("Library excluded", "library_excluded"), "library_excluded"],
    [new Error("Unexpected failure"), "validation_failed"],
])("preserves duplicate validation codes and keeps unexpected failures generic", async (error, code) => {
    vi.mocked(validateMergeItemsAction).mockRejectedValueOnce(error);
    const response = await handleAgentActionValidateRequest({
        request_id: "validate-merge", action_type: "merge_items", action_data: {},
    } as any);
    expect(response.valid).toBe(false);
    expect(response.error_code).toBe(code);
    expect(response.error).toBe(error.message);
});
it("snapshots items for validation only after earlier deferred writes have settled", async () => {
    vi.mocked(validateMergeItemsAction).mockClear();
    let release!: (settled: boolean) => void;
    deferredCommits.wait.mockReturnValueOnce(new Promise<boolean>((resolve) => { release = resolve; }));
    vi.mocked(validateMergeItemsAction).mockResolvedValueOnce({ valid: true } as any);
    const pending = handleAgentActionValidateRequest({
        request_id: "validate-merge", action_type: "merge_items", action_data: {},
    } as any);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(validateMergeItemsAction).not.toHaveBeenCalled();
    release(true);
    await pending;
    expect(validateMergeItemsAction).toHaveBeenCalledOnce();
});
it("validates imports without waiting for deferred writes", async () => {
    deferredCommits.wait.mockClear();
    await handleAgentActionValidateRequest({
        request_id: "validate-import", action_type: "import_item", action_data: {},
    } as any);
    expect(validateImportItemsAction).toHaveBeenCalledOnce();
    expect(deferredCommits.wait).not.toHaveBeenCalled();
});
