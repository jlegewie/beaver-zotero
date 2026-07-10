import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  checkLibraryExcluded: vi.fn(),
  resolveItemReference: vi.fn(),
  resolveLibraryRef: vi.fn(),
}));

vi.mock("../../../src/utils/libraryIdentity", () => ({
  libraryRefForLibraryID: vi.fn(() => null),
  modelObjectIdFromReference: vi.fn(
    ({ library_ref, library_id, zotero_key }) =>
      `${library_ref ?? library_id}-${zotero_key}`,
  ),
  resolveItemReference: mocks.resolveItemReference,
  resolveLibraryRef: mocks.resolveLibraryRef,
}));

vi.mock("../../../src/services/agentDataProvider/utils", () => ({
  checkLibraryExcluded: mocks.checkLibraryExcluded,
  excludedLibraryMessage: vi.fn(
    (libraryID: number) => `Library ${libraryID} is excluded`,
  ),
  getAttachmentFileStatus: vi.fn(),
  getDeferredToolPreference: vi.fn(() => "always_ask"),
  validateLibraryAccess: vi.fn(),
}));

vi.mock("../../../src/services/annotations/createAnnotation", () => {
  class AnnotationError extends Error {
    code = "annotation_error";
    reason = "annotation_error";
  }
  return {
    EpubAnnotationError: AnnotationError,
    MissingPageGeometryError: AnnotationError,
    SnapshotAnnotationError: AnnotationError,
    createEpubHighlightAnnotation: vi.fn(),
    createHighlightAnnotation: vi.fn(),
    createSnapshotHighlightAnnotation: vi.fn(),
    createEpubNoteAnnotation: vi.fn(),
    createNoteAnnotation: vi.fn(),
    createSnapshotNoteAnnotation: vi.fn(),
    prepareSnapshotAnnotationDocument: vi.fn(),
  };
});

vi.mock(
  "../../../src/services/documentExtraction/attachmentResolution",
  () => ({
    getReadableContentKind: vi.fn(() => "pdf"),
  }),
);

vi.mock("../../../src/utils/zoteroUtils", () => ({
  canSetField: vi.fn(),
  resolveFieldForItemType: vi.fn(),
  sanitizeCreators: vi.fn((creators: any[]) => creators),
  SETTABLE_PRIMARY_FIELDS: [],
  shortItemTitle: vi.fn(),
}));

vi.mock("../../../src/utils/logger", () => ({
  logger: vi.fn(),
}));

vi.mock("../../../react/store", () => ({
  store: { get: vi.fn(() => [7]) },
}));

vi.mock("../../../react/atoms/profile", () => ({
  searchableLibraryIdsAtom: Symbol("searchableLibraryIdsAtom"),
}));

vi.mock("../../../react/utils/sourceUtils", () => ({
  clearNoteEditorSelection: vi.fn(),
}));

vi.mock("../../../src/services/supabaseClient", () => ({
  supabase: {
    auth: { getSession: vi.fn() },
  },
}));

import {
  executeCreateHighlightAnnotationsAction,
  validateCreateHighlightAnnotationsAction,
} from "../../../src/services/agentDataProvider/actions/createHighlightAnnotations";
import {
  executeCreateNoteAnnotationsAction,
  validateCreateNoteAnnotationsAction,
} from "../../../src/services/agentDataProvider/actions/createNoteAnnotations";
import {
  executeEditMetadataAction,
  validateEditMetadataAction,
} from "../../../src/services/agentDataProvider/actions/editMetadata";
import {
  executeEditNoteAction,
  validateEditNoteAction,
} from "../../../src/services/agentDataProvider/actions/editNote";

const reference = {
  library_id: 1,
  library_ref: "g42",
  zotero_key: "ITEM1234",
};

const annotationData = {
  requested_ref: reference,
  resolved_ref: reference,
  items: [{ index: 0, client_item_id: "client-1" }],
};

const editNoteData = {
  ...reference,
  old_string: "before",
  new_string: "after",
};

const validationCases = [
  [
    "create_highlight_annotations",
    validateCreateHighlightAnnotationsAction,
    annotationData,
  ],
  [
    "create_note_annotations",
    validateCreateNoteAnnotationsAction,
    annotationData,
  ],
  [
    "edit_metadata",
    validateEditMetadataAction,
    { ...reference, edits: [{ field: "title", value: "New" }] },
  ],
  ["edit_note", validateEditNoteAction, editNoteData],
] as const;

const executionCases = [
  [
    "create_highlight_annotations",
    executeCreateHighlightAnnotationsAction,
    annotationData,
  ],
  [
    "create_note_annotations",
    executeCreateNoteAnnotationsAction,
    annotationData,
  ],
  [
    "edit_metadata",
    executeEditMetadataAction,
    { ...reference, edits: [{ field: "title", value: "New" }] },
  ],
  ["edit_note", executeEditNoteAction, editNoteData],
] as const;

describe("agent action library-exclusion ordering", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveLibraryRef.mockReturnValue(7);
    mocks.checkLibraryExcluded.mockReturnValue({
      message: "The library is excluded from Beaver",
    });
  });

  it.each(validationCases)(
    "gates %s validation before item resolution",
    async (actionType, validate, actionData) => {
      const response = await validate({
        event: "agent_action_validate",
        request_id: `validate-${actionType}`,
        action_type: actionType,
        action_data: actionData,
      } as any);

      expect(response).toMatchObject({
        valid: false,
        error_code: "library_not_searchable",
      });
      expect(mocks.resolveLibraryRef).toHaveBeenCalled();
      expect(mocks.checkLibraryExcluded).toHaveBeenCalledWith(7);
      expect(mocks.resolveItemReference).not.toHaveBeenCalled();
    },
  );

  it.each(executionCases)(
    "gates %s execution before item resolution",
    async (actionType, execute, actionData) => {
      const response = await execute(
        {
          event: "agent_action_execute",
          request_id: `execute-${actionType}`,
          action_type: actionType,
          action_data: actionData,
        } as any,
        {} as any,
      );

      expect(response).toMatchObject({
        success: false,
        error_code: "library_not_searchable",
      });
      expect(mocks.resolveLibraryRef).toHaveBeenCalled();
      expect(mocks.checkLibraryExcluded).toHaveBeenCalledWith(7);
      expect(mocks.resolveItemReference).not.toHaveBeenCalled();
    },
  );
});
