// The shared chat-history render layer. Like the icon and primitive barrels,
// this exists so the whole family has a single root the closure check can start
// from: consumers import a component by its own subpath
// (`@beaver/agent-ui/chat/Citation`), and the members that are only reached by a
// sibling (the marker hook, the view model) would otherwise be reachable by
// accident rather than on purpose.

export { default as Citation } from './Citation';

export { default as CitedSourcesList } from './CitedSourcesList';

export { readCitationProps, useCitationViewModel } from './useCitationViewModel';
export type { CitationDisplayState, CitationViewModel } from './useCitationViewModel';

export { useCitationMarker } from './useCitationMarker';

export { default as ChipWithPopup, ChipPopupCard, ChipWithListPopup } from './ChipPopup';
export type {
    ChipPopupAction,
    ChipPopupContent,
    ChipPopupStatus,
    ChipPopupSubtitle,
    ChipListPopupContent,
    ChipListPopupRow,
} from './ChipPopup';

export { buildActionPopup } from './actionPopup';
export type { ActionPopupSource } from './actionPopup';

export { default as AskUserQuestionCard } from './AskUserQuestionCard';
export type { AskUserQuestionCardProps } from './AskUserQuestionCard';

export { default as BatchApprovalCard } from './BatchApprovalCard';
export type { BatchApprovalCardProps } from './BatchApprovalCard';

export { default as BatchProgressBar } from './BatchProgressBar';
export type { BatchProgressBarProps } from './BatchProgressBar';

export {
    BatchBlockHeading,
    BatchFailureReasonBlock,
    BatchProgressTrack,
    BatchRemovalBlock,
    BatchTallyBlock,
    BatchTallyRow,
} from './BatchOutcomeBlocks';

export { default as CreditConfirmationCard, createCreditDecisionHandlers } from './CreditConfirmationCard';
export type { CreditConfirmationCardProps, CreditDecisionHandlers } from './CreditConfirmationCard';

export { selectComposerTakeover } from './composerTakeover';
export type { ComposerTakeover, ComposerTakeoverInput } from './composerTakeover';
