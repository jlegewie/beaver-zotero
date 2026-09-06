import React from 'react';

/**
 * The mark for a run that is working: a dot with a soft ring that keeps
 * expanding out of it and fading, like a ping. Sized to an icon, so the same
 * slot holds an icon once the run has something more specific to say.
 */
const RunPulse: React.FC<{ className?: string }> = ({ className = '' }) => (
    <span className={`beaver-run-pulse ${className}`} aria-hidden="true">
        <span className="beaver-run-pulse__ring" />
        <span className="beaver-run-pulse__ring" />
        <span className="beaver-run-pulse__dot" />
    </span>
);

export default RunPulse;
