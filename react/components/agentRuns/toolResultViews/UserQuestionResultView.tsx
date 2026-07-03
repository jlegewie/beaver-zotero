import React from 'react';
import { UserQuestionView } from '../../../types/toolResultViews';
import { renderContentWithRefChips } from '../refChipRendering';
import { chipForMessageAttachment } from '../requestChips/RequestChipPrimitives';

/**
 * Shared renderer for the {@link UserQuestionView} view model (ask_user_question).
 *
 * Renders the answered (or skipped/timed-out) question card in chat history:
 * each question with the selected option labels and/or the free-text answer.
 * Host-agnostic — pure view data, no client lookups.
 */
export const UserQuestionResultView: React.FC<{ view: UserQuestionView }> = ({ view }) => {
    // The backend default is "answered" and may be omitted on the wire —
    // gate only on the non-default states.
    const status = view.status ?? 'answered';
    const statusNote =
        status === 'cancelled'
            ? 'Question skipped'
            : status === 'no_response'
                ? 'No response'
                : null;

    return (
        <div className="display-flex flex-col min-w-0 p-3 gap-4">
            {view.answers.map((answer, index) => {
                const selected = answer.selected ?? [];
                const customText = answer.custom_text?.trim();
                const references = answer.references ?? {};
                const answerReferences = answer.answer_references ?? [];
                return (
                    <div key={index} className="display-flex flex-col min-w-0 gap-05">
                        <div className="text-base font-color-secondary">
                            {renderContentWithRefChips(answer.question, references)}
                        </div>
                        {(selected.length > 0 || customText) ? (
                            <div className="display-flex flex-col min-w-0 gap-05">
                                {selected.map((label) => (
                                    <div key={label} className="font-color-primary">
                                        {renderContentWithRefChips(label, references)}
                                    </div>
                                ))}
                                {customText && (
                                    <div className="font-color-primary">
                                        {customText}
                                    </div>
                                )}
                            </div>
                        ) : (
                            <div className="text-sm font-color-tertiary">
                                Not answered
                            </div>
                        )}
                        {answerReferences.length > 0 && (
                            <div className="display-flex flex-wrap gap-col-3 gap-row-2 mt-1">
                                {answerReferences.map((att, refIndex) => (
                                    chipForMessageAttachment(att, `answer-ref-${index}-${refIndex}`)
                                ))}
                            </div>
                        )}
                    </div>
                );
            })}
        </div>
    );
};

export default UserQuestionResultView;
