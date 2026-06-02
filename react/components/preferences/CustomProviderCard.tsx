import React, { useState, useCallback, useMemo } from "react";
import Button from "../ui/Button";
import MenuButton from "../ui/MenuButton";
import Spinner from "../icons/Spinner";
import { MenuItem } from "../ui/menu/ContextMenu";
import {
    Icon,
    ArrowDownIcon,
    TickIcon,
    AlertIcon,
    DeleteIcon,
    CopyIcon,
    RockIcon,
    TissuePaperIcon,
    ScissorIcon,
} from "../icons/icons";
import { CustomChatModel, validateCustomProviderApiBase } from "../../types/settings";
import { DocLink } from "./components/SettingsElements";
import {
    chatService,
    RockPaperScissorsMove,
    RockPaperScissorsTestResult,
} from "../../../src/services/chatService";

interface CustomProviderCardProps {
    model: CustomChatModel;
    onChange: (updated: CustomChatModel) => void;
    onRemove: () => void;
    onDuplicate: () => void;
    isExpanded: boolean;
    onToggleExpand: () => void;
    hasBorder?: boolean;
}

type TestStatus = 'idle' | 'loading' | 'success' | 'error';

const MOVES: RockPaperScissorsMove[] = ['rock', 'paper', 'scissors'];

const MOVE_ICONS: Record<RockPaperScissorsMove, React.ComponentType<React.SVGProps<SVGSVGElement>>> = {
    rock: RockIcon,
    paper: TissuePaperIcon,
    scissors: ScissorIcon,
};

const MOVE_LABELS: Record<RockPaperScissorsMove, string> = {
    rock: 'Rock',
    paper: 'Paper',
    scissors: 'Scissors',
};

const outcomeText = (result: RockPaperScissorsTestResult): string => {
    switch (result.result) {
        case 'user': return 'You win!';
        case 'agent': return 'The model wins.';
        case 'tie': return "It's a tie.";
        default: return '';
    }
};

const CustomProviderCard: React.FC<CustomProviderCardProps> = ({
    model,
    onChange,
    onRemove,
    onDuplicate,
    isExpanded,
    onToggleExpand,
    hasBorder = false,
}) => {
    const [testStatus, setTestStatus] = useState<TestStatus>('idle');
    const [testResult, setTestResult] = useState<RockPaperScissorsTestResult | null>(null);
    const [testError, setTestError] = useState<string | null>(null);
    const [contextWindowText, setContextWindowText] = useState<string>(
        model.context_window != null ? String(model.context_window) : ''
    );

    // --- Field updates (controlled by parent) ---
    const update = useCallback((patch: Partial<CustomChatModel>) => {
        onChange({ ...model, ...patch });
    }, [model, onChange]);

    // Context window is free text so it can be cleared/typed; only digits are valid.
    const contextWindowError = contextWindowText.trim() !== '' && !/^\d+$/.test(contextWindowText.trim());
    const handleContextWindowChange = useCallback((raw: string) => {
        setContextWindowText(raw);
        const trimmed = raw.trim();
        if (trimmed === '') {
            update({ context_window: undefined });
        } else if (/^\d+$/.test(trimmed)) {
            update({ context_window: parseInt(trimmed, 10) });
        } else {
            // Invalid input: keep the text visible for correction, but don't persist a bad value.
            update({ context_window: undefined });
        }
    }, [update]);

    // --- Validation (mirrors the backend security checks) ---
    const apiBaseValidation = useMemo(() => validateCustomProviderApiBase(model.api_base), [model.api_base]);
    const hasName = !!model.name?.trim();
    const hasSnapshot = !!model.snapshot?.trim();
    const hasApiKey = !!model.api_key?.trim();
    const isComplete = hasName && hasSnapshot && hasApiKey && apiBaseValidation.valid;

    // --- Test endpoint ---
    const runTest = useCallback(async (userMove: RockPaperScissorsMove) => {
        setTestStatus('loading');
        setTestResult(null);
        setTestError(null);
        try {
            const result = await chatService.testCustomProviderRockPaperScissors(
                {
                    api_base: model.api_base?.trim() || undefined,
                    format: model.format === 'anthropic' ? 'anthropic' : 'openai',
                    api_key: model.api_key?.trim() ?? '',
                    name: model.name?.trim() ?? '',
                    snapshot: model.snapshot?.trim() ?? '',
                    context_window: model.context_window,
                    supports_vision: model.supports_vision,
                },
                userMove,
            );
            setTestResult(result);
            if (result.provider_works) {
                setTestStatus('success');
            } else {
                setTestStatus('error');
                setTestError(result.error_message || 'The provider test failed.');
            }
        } catch (error) {
            setTestStatus('error');
            setTestError(error instanceof Error ? error.message : 'The provider test failed.');
        }
    }, [model]);

    // The dropdown picks the user's move, which is sent to the model.
    const testMenuItems: MenuItem[] = useMemo(() => MOVES.map((move) => ({
        label: MOVE_LABELS[move],
        icon: MOVE_ICONS[move],
        onClick: () => runTest(move),
        disabled: !isComplete || testStatus === 'loading',
    })), [runTest, isComplete, testStatus]);

    const testButtonCustomContent = (
        <span className="display-flex flex-row items-center gap-2">
            {testStatus === 'loading' ? <Spinner /> : testStatus === 'success' ? (
                <Icon icon={TickIcon} className="font-color-green" />
            ) : null}
            <span>Test Endpoint</span>
            <Icon icon={ArrowDownIcon} />
        </span>
    );

    const formatLabel = model.format === 'anthropic' ? 'Anthropic' : 'OpenAI';
    const formatMenuItems: MenuItem[] = [
        { label: 'OpenAI', onClick: () => update({ format: 'openai' }) },
        { label: 'Anthropic', onClick: () => update({ format: 'anthropic' }) },
    ];

    // --- Collapsed view ---
    if (!isExpanded) {
        return (
            <div
                className={`action-card display-flex flex-row items-center gap-3 ${hasBorder ? 'border-top-quinary' : ''}`}
                onClick={onToggleExpand}
            >
                <div className="display-flex flex-col flex-1 min-w-0" style={{ gap: '3px' }}>
                    <div className="display-flex flex-row items-center gap-3">
                        <div className="font-color-primary text-base font-medium">
                            {model.name?.trim() || <span className="font-color-tertiary">Untitled provider</span>}
                        </div>
                        {!isComplete && (
                            <span
                                className="scale-90 px-15 py-05 text-sm rounded-md"
                                style={{ color: 'var(--tag-orange-secondary)', border: '1px solid var(--tag-orange-tertiary)', background: 'var(--tag-orange-quinary)' }}
                            >
                                Incomplete
                            </span>
                        )}
                    </div>
                    {model.snapshot?.trim() && (
                        <div className="font-color-secondary text-base action-card-preview">
                            {model.snapshot}
                        </div>
                    )}
                </div>
                <Icon icon={ArrowDownIcon} className="font-color-tertiary flex-shrink-0" />
            </div>
        );
    }

    // --- Expanded view ---
    return (
        <div className={`action-card action-card-editing ${hasBorder ? 'border-top-quinary' : ''}`}>
            <div className="display-flex flex-col" style={{ gap: '14px' }}>
                {/* Name */}
                <label className="display-flex flex-col">
                    <span className="text-sm font-color-secondary">Name</span>
                    <input
                        type="text"
                        value={model.name}
                        onChange={(e) => update({ name: e.target.value })}
                        placeholder="My Custom Model"
                        aria-label="Provider name"
                        className="chat-input text-base font-color-primary"
                    />
                </label>

                {/* Snapshot */}
                <label className="display-flex flex-col">
                    <span className="text-sm font-color-secondary">Model (snapshot)</span>
                    <input
                        type="text"
                        value={model.snapshot}
                        onChange={(e) => update({ snapshot: e.target.value })}
                        placeholder="openai/gpt-4o or claude-3-5-sonnet-20241022"
                        aria-label="Model snapshot"
                        className="chat-input text-base font-color-primary"
                    />
                </label>

                {/* API base */}
                <label className="display-flex flex-col">
                    <span className="text-sm font-color-secondary">Endpoint URL (api_base)</span>
                    <input
                        type="text"
                        value={model.api_base ?? ''}
                        onChange={(e) => update({ api_base: e.target.value })}
                        placeholder="https://openrouter.ai/api/v1"
                        aria-label="Endpoint URL"
                        className="chat-input text-base font-color-primary"
                    />
                    {model.api_base?.trim() && !apiBaseValidation.valid && (
                        <span className="display-flex flex-row items-start text-sm font-color-error">
                            <Icon icon={AlertIcon} className="flex-shrink-0 mt-020" />
                            <span>
                                {apiBaseValidation.error}{' '}
                                <DocLink path="custom-models">Network requirements</DocLink>
                            </span>
                        </span>
                    )}
                </label>

                {/* Format + Context window row */}
                <div className="display-flex flex-row gap-4">
                    <label className="display-flex flex-col items-start">
                        <span className="text-sm font-color-secondary">Format</span>
                        <MenuButton
                            menuItems={formatMenuItems}
                            buttonLabel={formatLabel}
                            variant="outline"
                            rightIcon={ArrowDownIcon}
                            width="160px"
                            className="text-base"
                            ariaLabel="API format"
                        />
                    </label>
                    <label className="display-flex flex-col flex-1">
                        <span className="text-sm font-color-secondary">Context window</span>
                        <input
                            type="text"
                            inputMode="numeric"
                            value={contextWindowText}
                            onChange={(e) => handleContextWindowChange(e.target.value)}
                            placeholder="128000"
                            aria-label="Context window"
                            className="chat-input text-base font-color-primary"
                        />
                        {contextWindowError && (
                            <span className="text-sm" style={{ color: 'var(--tag-red-secondary)' }}>
                                Enter a number (e.g. 128000).
                            </span>
                        )}
                    </label>
                </div>

                {/* API key */}
                <label className="display-flex flex-col">
                    <span className="text-sm font-color-secondary">API key</span>
                    <input
                        type="password"
                        value={model.api_key}
                        onChange={(e) => update({ api_key: e.target.value })}
                        placeholder="sk-..."
                        aria-label="API key"
                        className="chat-input text-base font-color-primary"
                    />
                </label>

                {/* Supports vision */}
                <label className="display-flex flex-row items-center gap-1 cursor-pointer">
                    <input
                        type="checkbox"
                        checked={!!model.supports_vision}
                        onChange={(e) => update({ supports_vision: e.target.checked })}
                        style={{ minWidth: 'auto' }}
                    />
                    <span className="text-base font-color-primary">Supports vision (image input)</span>
                </label>

                {/* Footer actions */}
                <div className="display-flex flex-row items-center justify-between mt-1">
                    <MenuButton
                        menuItems={testMenuItems}
                        customContent={testButtonCustomContent}
                        variant="outline"
                        width="180px"
                        className="text-base"
                        ariaLabel="Test endpoint"
                        disabled={!isComplete && testStatus !== 'loading'}
                        tooltipContent={!isComplete ? 'Fill in all required fields to test the endpoint.' : undefined}
                    />
                    <div className="display-flex flex-row items-center gap-3">
                        <Button
                            variant="outline"
                            icon={CopyIcon}
                            onClick={onDuplicate}
                        >
                            Duplicate
                        </Button>
                        <Button
                            variant="outline"
                            icon={DeleteIcon}
                            onClick={onRemove}
                        >
                            Delete
                        </Button>
                        <Button
                            variant="solid"
                            onClick={onToggleExpand}
                        >
                            Done
                        </Button>
                    </div>
                </div>

                {/* Test result (shown below the Test button) */}
                {testStatus === 'success' && testResult && (
                    <div
                        className="display-flex flex-col gap-1 rounded-md px-2 py-15 text-sm"
                        style={{ border: '1px solid var(--tag-green-tertiary)', background: 'var(--tag-green-quinary)' }}
                    >
                        <div className="display-flex flex-row items-center gap-2 font-color-primary">
                            <Icon icon={TickIcon} className="font-color-green" />
                            <span className="font-medium">Endpoint works</span>
                            {testResult.user_move && testResult.agent_move && (
                                <span className="display-flex flex-row items-center gap-1 font-color-secondary">
                                    <span title={`You: ${MOVE_LABELS[testResult.user_move]}`}>
                                        <Icon icon={MOVE_ICONS[testResult.user_move]} />
                                    </span>
                                    <span>vs</span>
                                    <span title={`Model: ${MOVE_LABELS[testResult.agent_move]}`}>
                                        <Icon icon={MOVE_ICONS[testResult.agent_move]} />
                                    </span>
                                    <span>· {outcomeText(testResult)}</span>
                                </span>
                            )}
                        </div>
                        {testResult.agent_message && (
                            <div className="font-color-secondary" style={{ fontStyle: 'italic' }}>
                                “{testResult.agent_message}”
                            </div>
                        )}
                    </div>
                )}
                {testStatus === 'error' && testError && (
                    <div
                        className="display-flex flex-row items-start gap-2 rounded-md px-2 py-15 text-sm"
                        style={{ border: '1px solid var(--tag-red-tertiary)', background: 'var(--tag-red-quinary)', color: 'var(--tag-red-secondary)' }}
                    >
                        <Icon icon={AlertIcon} className="flex-shrink-0 mt-020" />
                        <span>{testError}</span>
                    </div>
                )}
            </div>
        </div>
    );
};

export default CustomProviderCard;
