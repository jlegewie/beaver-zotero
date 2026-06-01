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
    defaultExpanded?: boolean;
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

const pickRandomMove = (): RockPaperScissorsMove => MOVES[Math.floor(Math.random() * MOVES.length)];

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
    defaultExpanded = false,
    hasBorder = false,
}) => {
    const [isExpanded, setIsExpanded] = useState(defaultExpanded);
    const [testStatus, setTestStatus] = useState<TestStatus>('idle');
    const [testResult, setTestResult] = useState<RockPaperScissorsTestResult | null>(null);
    const [testError, setTestError] = useState<string | null>(null);

    // --- Field updates (controlled by parent) ---
    const update = useCallback((patch: Partial<CustomChatModel>) => {
        onChange({ ...model, ...patch });
    }, [model, onChange]);

    const handleContextWindowChange = useCallback((raw: string) => {
        const trimmed = raw.trim();
        if (trimmed === '') {
            update({ context_window: undefined });
            return;
        }
        const parsed = parseInt(trimmed, 10);
        update({ context_window: Number.isFinite(parsed) ? parsed : undefined });
    }, [update]);

    // --- Validation (mirrors the backend security checks) ---
    const apiBaseValidation = useMemo(() => validateCustomProviderApiBase(model.api_base), [model.api_base]);
    const hasName = !!model.name?.trim();
    const hasSnapshot = !!model.snapshot?.trim();
    const hasApiKey = !!model.api_key?.trim();
    const isComplete = hasName && hasSnapshot && hasApiKey && apiBaseValidation.valid;

    // --- Test endpoint ---
    const runTest = useCallback(async () => {
        setTestStatus('loading');
        setTestResult(null);
        setTestError(null);
        try {
            const userMove = pickRandomMove();
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

    const testMenuItems: MenuItem[] = useMemo(() => [
        {
            label: 'Rock Paper Scissors',
            onClick: runTest,
            disabled: !isComplete || testStatus === 'loading',
            customContent: (
                <div className="display-flex flex-col">
                    <span className="text-base font-color-primary">Rock Paper Scissors</span>
                    <span className="text-sm font-color-tertiary">
                        Play one round to verify streaming and tool calling.
                    </span>
                </div>
            ),
        },
    ], [runTest, isComplete, testStatus]);

    const testButtonCustomContent = (
        <span className="display-flex flex-row items-center gap-2">
            {testStatus === 'loading' && <Spinner />}
            {testStatus === 'success' && <Icon icon={TickIcon} className="font-color-green" />}
            <span>Test</span>
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
                className={`action-card ${hasBorder ? 'border-top-quinary' : ''}`}
                onClick={() => setIsExpanded(true)}
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
            <div className="display-flex flex-col gap-3">
                {/* Name */}
                <label className="display-flex flex-col gap-1">
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
                <label className="display-flex flex-col gap-1">
                    <span className="text-sm font-color-secondary">Model (snapshot)</span>
                    <input
                        type="text"
                        value={model.snapshot}
                        onChange={(e) => update({ snapshot: e.target.value })}
                        placeholder="gpt-4o or claude-3-5-sonnet-20241022"
                        aria-label="Model snapshot"
                        className="chat-input text-base font-color-primary"
                    />
                </label>

                {/* API base */}
                <label className="display-flex flex-col gap-1">
                    <span className="text-sm font-color-secondary">Endpoint URL (api_base)</span>
                    <input
                        type="text"
                        value={model.api_base ?? ''}
                        onChange={(e) => update({ api_base: e.target.value })}
                        placeholder="https://api.example.com/v1"
                        aria-label="Endpoint URL"
                        className="chat-input text-base font-color-primary"
                    />
                    {model.api_base?.trim() && !apiBaseValidation.valid && (
                        <span className="display-flex flex-row items-start gap-1 text-sm" style={{ color: 'var(--tag-red-secondary)' }}>
                            <Icon icon={AlertIcon} className="flex-shrink-0 mt-020" />
                            <span>
                                {apiBaseValidation.error}{' '}
                                <DocLink path="custom-models">Network requirements</DocLink>
                            </span>
                        </span>
                    )}
                </label>

                {/* Format + Context window row */}
                <div className="display-flex flex-row gap-3">
                    <label className="display-flex flex-col gap-1 flex-1">
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
                    <label className="display-flex flex-col gap-1 flex-1">
                        <span className="text-sm font-color-secondary">Context window</span>
                        <input
                            type="number"
                            value={model.context_window ?? ''}
                            onChange={(e) => handleContextWindowChange(e.target.value)}
                            placeholder="128000"
                            aria-label="Context window"
                            className="chat-input text-base font-color-primary"
                        />
                    </label>
                </div>

                {/* API key */}
                <label className="display-flex flex-col gap-1">
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
                <label className="display-flex flex-row items-center gap-2 cursor-pointer">
                    <input
                        type="checkbox"
                        checked={!!model.supports_vision}
                        onChange={(e) => update({ supports_vision: e.target.checked })}
                        style={{ minWidth: 'auto' }}
                    />
                    <span className="text-base font-color-primary">Supports vision (image input)</span>
                </label>

                {/* Test result */}
                {testStatus === 'success' && testResult && (
                    <div
                        className="display-flex flex-col gap-1 rounded-md px-2 py-15 text-sm"
                        style={{ border: '1px solid var(--tag-green-tertiary)', background: 'var(--tag-green-quinary)' }}
                    >
                        <div className="display-flex flex-row items-center gap-2 font-color-primary">
                            <Icon icon={TickIcon} className="font-color-green" />
                            <span className="font-medium">Provider works</span>
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

                {/* Footer actions */}
                <div className="display-flex flex-row items-center justify-between mt-2">
                    <div className="display-flex flex-row items-center gap-3">
                        <MenuButton
                            menuItems={testMenuItems}
                            customContent={testButtonCustomContent}
                            variant="outline"
                            width="240px"
                            className="text-base"
                            ariaLabel="Test provider"
                            disabled={!isComplete && testStatus !== 'loading'}
                            tooltipContent={!isComplete ? 'Fill in all required fields to test the provider.' : undefined}
                        />
                    </div>
                    <div className="display-flex flex-row items-center gap-3">
                        <Button
                            variant="ghost-secondary"
                            icon={DeleteIcon}
                            style={{ padding: "2px 8px" }}
                            onClick={onRemove}
                        >
                            <span className="text-xs">Delete</span>
                        </Button>
                        <Button
                            variant="solid"
                            style={{ padding: "2px 8px" }}
                            onClick={() => setIsExpanded(false)}
                        >
                            Done
                        </Button>
                    </div>
                </div>
            </div>
        </div>
    );
};

export default CustomProviderCard;
