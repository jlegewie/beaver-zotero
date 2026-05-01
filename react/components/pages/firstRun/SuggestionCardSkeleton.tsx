import React from 'react';

const SuggestionCardSkeleton: React.FC = () => {
    return (
        <div className="p-3 rounded-md bg-senary first-run-skeleton-card">
            <style>
                {`
                @keyframes firstRunSkeletonShimmer {
                    0% { background-position: 200% 0; }
                    100% { background-position: -200% 0; }
                }
                .first-run-skeleton-bar {
                    border-radius: 4px;
                    background-color: var(--fill-quinary);
                    background-image: linear-gradient(
                        90deg,
                        transparent 0%,
                        var(--fill-tertiary) 50%,
                        transparent 100%
                    );
                    background-size: 200% 100%;
                    background-repeat: no-repeat;
                    animation: firstRunSkeletonShimmer 1.8s linear infinite;
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
