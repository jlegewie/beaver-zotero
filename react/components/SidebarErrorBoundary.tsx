import React, { type ReactNode } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import ErrorBoundary from '@beaver/agent-ui/primitives/ErrorBoundary';
import Button from '@beaver/agent-ui/primitives/Button';
import RenderErrorBoundary from '@beaver/agent-ui/chat/RenderErrorBoundary';
import { currentThreadIdAtom, newThreadAtom } from '../atoms/threads';
import { activeDialogAtom } from '../atoms/ui';
import { useSurfaceWindow } from '../runtime/SurfaceWindowContext';
import DialogContainer from './dialog/DialogContainer';

const renderNothing = () => null;

/**
 * The last-resort boundary around a chat surface: a main window's sidebar or
 * the separate window. Messages and the thread view have boundaries of their
 * own; this one catches what fails outside them (the header, the composer, a
 * page), so the user gets a notice and a way out — a new chat — instead of
 * an empty pane. Opening another chat clears it.
 */
const SidebarErrorBoundary = ({ children }: { children: ReactNode }) => {
    const threadId = useAtomValue(currentThreadIdAtom);
    const activeDialog = useAtomValue(activeDialogAtom);
    const newThread = useSetAtom(newThreadAtom);
    const surfaceWindow = useSurfaceWindow();

    return (
        <RenderErrorBoundary
            scope="sidebar"
            summary="Something went wrong in Beaver."
            detail="Start a new chat to keep working."
            threadId={threadId}
            resetKey={threadId}
            layout="page"
            actions={(reset) => (
                <Button
                    variant="solid"
                    onClick={async () => {
                        // Undefined when the user kept the current chat.
                        if ((await newThread({ window: surfaceWindow })) === undefined) return;
                        // Already on a new chat, the thread id does not change.
                        reset();
                    }}
                >
                    New chat
                </Button>
            )}
            wrapFallback={(notice) => (
                <div className="bg-sidepane h-full w-full display-flex flex-col justify-center min-w-0 relative overflow-y-auto">
                    {notice}
                    {/* The report form; the one the failed surface rendered is gone.
                        A dialog that fails stays out, and the next one gets its turn. */}
                    <ErrorBoundary fallback={renderNothing} resetKey={activeDialog}>
                        <DialogContainer />
                    </ErrorBoundary>
                </div>
            )}
        >
            {children}
        </RenderErrorBoundary>
    );
};

export default SidebarErrorBoundary;
