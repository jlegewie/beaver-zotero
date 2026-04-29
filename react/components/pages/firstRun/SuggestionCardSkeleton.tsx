import React from 'react';

const SuggestionCardSkeleton: React.FC = () => {
    return (
        <div className="p-3 rounded-md bg-senary first-run-skeleton-card">
            <style>
                {`
                @keyframes firstRunSkeletonPulse {
                    0%, 100% { opacity: 1; }
                    50% { opacity: 0.45; }
                }
                .first-run-skeleton-bar {
                    background-color: var(--fill-quinary);
                    border-radius: 4px;
                    animation: firstRunSkeletonPulse 1.6s ease-in-out infinite;
                }
                `}
            </style>
            <div className="display-flex flex-col gap-2">
                <div className="display-flex flex-row items-center gap-2 mb-1">
                    <div className="first-run-skeleton-bar" style={{ width: 16, height: 16, borderRadius: 4 }} />
                    <div className="first-run-skeleton-bar" style={{ width: '40%', height: 12 }} />
                </div>
                <div className="first-run-skeleton-bar" style={{ width: '95%', height: 10 }} />
                <div className="first-run-skeleton-bar" style={{ width: '70%', height: 10 }} />
            </div>
        </div>
    );
};

export default SuggestionCardSkeleton;
