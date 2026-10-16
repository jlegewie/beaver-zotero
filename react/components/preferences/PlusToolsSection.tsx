import React, { useCallback } from "react";
import Button from "@beaver/agent-ui/primitives/Button";
import { SettingsGroup, SettingsRow, SectionLabel, DocLink } from "./components/SettingsElements";
import { setPref } from "../../../src/utils/prefs";
import { activePreferencePageTabAtom, requestPlusToolsAtom } from "../../atoms/ui";
import { remainingBeaverCreditsAtom } from "../../atoms/profile";
import { useAtom, useAtomValue, useSetAtom } from "jotai";

/** Plus Tools toggle for API-key users: status badge plus an enable/disable row keyed on credit balance. */
const PlusToolsSection: React.FC = () => {
    const setActiveTab = useSetAtom(activePreferencePageTabAtom);
    const [requestPlusTools, setRequestPlusTools] = useAtom(requestPlusToolsAtom);
    const remainingBeaverCredits = useAtomValue(remainingBeaverCreditsAtom);

    const handleRequestPlusToolsToggle = useCallback(() => {
        const newValue = !requestPlusTools;
        setPref('requestPlusTools', newValue);
        setRequestPlusTools(newValue);
    }, [requestPlusTools, setRequestPlusTools]);

    return (
        <>
            <div className="display-flex flex-row gap-2">
                <SectionLabel>Plus Tools</SectionLabel>
                {requestPlusTools ? (
                    remainingBeaverCredits > 0 ? (
                        <span
                            className="text-sm font-color-secondary px-15 py-05 rounded-md bg-quinary border-quinary"
                            style={{
                                marginTop: '20px', marginBottom: '6px',
                                backgroundColor: 'var(--tag-green-quinary)',
                                color: 'var(--tag-green-secondary)',
                                borderColor: 'var(--tag-green-tertiary)',
                            }}
                        >
                            Active
                        </span>
                    ) : (
                        <span
                            className="text-sm font-color-secondary px-15 py-05 rounded-md bg-quinary border-quinary"
                            style={{
                                marginTop: '20px', marginBottom: '6px',
                                backgroundColor: 'var(--tag-orange-quinary)',
                                color: 'var(--tag-orange-secondary)',
                                borderColor: 'var(--tag-orange-tertiary)',
                            }}
                        >
                            Paused &middot; No credits
                        </span>
                    )
                ) : (
                    <span
                        className="text-sm font-color-secondary px-15 py-05 rounded-md bg-quinary border-quinary"
                        style={{ marginTop: '20px', marginBottom: '6px' }}
                    >
                        Inactive
                    </span>
                )}
            </div>
            <SettingsGroup className="bg-senary">
                {requestPlusTools && remainingBeaverCredits > 0 ? (
                    /* State 1: Enabled + has credits */
                    <SettingsRow
                        className="items-start"
                        title="Use Plus Tools with your API key"
                        description={
                            <>
                                Plus tools include external search, batch extraction, and AI ranking with your own key for improved performance.
                                {/* <DocLink path="credits">See the benchmarks</DocLink> */}
                                {' '}<DocLink path="credits">Learn more</DocLink>
                                <br /><br />
                                <span className="font-semibold font-color-primary text-lg">{remainingBeaverCredits.toLocaleString()}</span>
                                {' '}<span className="font-color-primary text-base">credits left</span>
                                <br />
                                <span className="font-color-secondary text-sm">
                                    Just 0.25 credits per message. Some actions cost extra.
                                </span>
                            </>
                        }
                        control={
                            <Button variant="outline" className="mt-1" onClick={handleRequestPlusToolsToggle} style={{ padding: '4px 6px' }}>
                                Disable
                            </Button>
                        }
                    />
                ) : requestPlusTools && remainingBeaverCredits <= 0 ? (
                    /* State 2: Enabled + no credits */
                    <SettingsRow
                        className="items-start"
                        title="Use Plus Tools with your API key"
                        description={
                            <>
                                You're out of credits, so Plus tools are paused. Your API key still works for basic chat.
                                Add credits for external search, batch extraction, and AI ranking.
                                <br />
                                <br />
                                <Button variant="outline" className="mt-1" onClick={handleRequestPlusToolsToggle} style={{ padding: '4px 6px' }}>
                                    Disable Plus Tools
                                </Button>
                            </>
                        }
                        control={
                            <Button variant="solid" className="mt-1" onClick={() => setActiveTab('billing')} style={{ padding: '4px 6px' }}>
                                Get credits &rarr;
                            </Button>
                        }
                    />
                ) : !requestPlusTools && remainingBeaverCredits > 0 ? (
                    /* State 3: Disabled + has credits */
                    <SettingsRow
                        className="items-start"
                        title="Use Plus Tools with your API key"
                        description={
                            <>
                                Plus tools include external search, batch extraction, and AI ranking with your own key for improved performance.
                                {/* <DocLink path="credits">See the benchmarks</DocLink> */}
                                {' '}<DocLink path="credits">Learn more</DocLink>
                                <br /><br />
                                <span className="font-semibold font-color-primary text-lg">{remainingBeaverCredits.toLocaleString()}</span>
                                {' '}<span className="font-color-primary text-base">credits ready to use</span>
                                <br />
                                <span className="font-color-secondary text-sm">
                                    Just 0.25 credits per message. Some actions cost extra.
                                </span>
                            </>
                        }
                        control={
                            <Button variant="solid" className="mt-1" onClick={handleRequestPlusToolsToggle} style={{ padding: '4px 6px' }}>
                                Enable
                            </Button>
                        }
                    />
                ) : (
                    /* State 4: Disabled + no credits */
                    <SettingsRow
                        className="items-start"
                        title="Use Plus Tools with your API key"
                        description={
                            <>
                                Plus tools include external search, batch extraction, and AI ranking with your own key for improved performance.
                                Costs 0.25 credits per message. Some actions cost extra.{' '}
                                <DocLink path="credits">Learn more</DocLink>
                            </>
                        }
                        control={
                            <Button variant="solid" className="mt-1" onClick={() => {handleRequestPlusToolsToggle(); setActiveTab('billing')}} style={{ padding: '4px 6px' }}>
                                Get credits &rarr;
                            </Button>
                        }
                    />
                )}
            </SettingsGroup>
        </>
    );
};

export default PlusToolsSection;
