import React from 'react';
import Tooltip from '@beaver/agent-ui/primitives/Tooltip';
import { Icon, TickIcon } from '../../icons/icons';

export interface StepperStep {
    key: string;
    label: string;
    /** One line about a completed step ("10 items from 1 source"). */
    summary: string;
}

export interface TableCardStepperProps {
    steps: StepperStep[];
    /** Index of the step the card shows. */
    current: number;
    /** Completed steps cannot be revisited (the card is answered or held). */
    disabled: boolean;
    onGoTo: (key: string) => void;
}

/**
 * Where the card is in its steps, as numbered circles joined by a line. The
 * current step is the one filled circle; completed steps are a blue outline
 * with a check and lead back to their step; steps still to come are a grey
 * outline with their number and are inert, so the steps cannot be skipped
 * ahead. Each circle names its step in a tooltip.
 */
export const TableCardStepper: React.FC<TableCardStepperProps> = ({ steps, current, disabled, onGoTo }) => (
    <div className="table-card-stepper" role="group" aria-label={`Step ${current + 1} of ${steps.length}`}>
        {steps.map((step, index) => {
            const position = `Step ${index + 1} of ${steps.length}`;
            const line = index > 0 && (
                <span
                    className={`table-card-stepper-line ${index <= current ? 'table-card-stepper-line-done' : ''}`}
                    aria-hidden="true"
                />
            );
            if (index < current) {
                return (
                    <React.Fragment key={step.key}>
                        {line}
                        <Tooltip
                            content={`${step.label}: ${step.summary}`}
                            secondaryContent={disabled ? undefined : 'Click to go back to this step'}
                            showArrow
                            width="max-content"
                        >
                            <button
                                type="button"
                                className="table-card-stepper-step table-card-stepper-step-done"
                                aria-label={`${position}: ${step.label}, done. Go back to ${step.label}`}
                                disabled={disabled}
                                onClick={() => onGoTo(step.key)}
                            >
                                <Icon icon={TickIcon} />
                            </button>
                        </Tooltip>
                    </React.Fragment>
                );
            }
            const isCurrent = index === current;
            return (
                <React.Fragment key={step.key}>
                    {line}
                    <Tooltip
                        content={`${position}: ${step.label}`}
                        secondaryContent={isCurrent ? 'Current step' : 'Use Next to get here'}
                        showArrow
                        width="max-content"
                    >
                        <span
                            className={`table-card-stepper-step ${isCurrent ? 'table-card-stepper-step-current' : 'table-card-stepper-step-todo'}`}
                            role="img"
                            aria-label={`${position}: ${step.label}${isCurrent ? ', current' : ''}`}
                            aria-current={isCurrent ? 'step' : undefined}
                        >
                            {index + 1}
                        </span>
                    </Tooltip>
                </React.Fragment>
            );
        })}
    </div>
);

export default TableCardStepper;
