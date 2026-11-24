import { getTransportConfigurationError } from '@beaver/agent-core/transport/config';
import { Provider } from 'jotai';
import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { SurfaceWindowContext } from '../runtime/SurfaceWindowContext';
import { store } from '../store';

/**
 * Every React root this renderer has mounted, keyed by its container. A root
 * stays registered when its container leaves the document (a Zotero 11 library
 * view closing with the library sidebar inside), so disposal still unmounts it.
 */
const rootsMap = new Map<HTMLElement, Root>();

/** Mount a renderer surface into `domElement`, replacing any root already there. */
export function mountSurface(domElement: HTMLElement, children: React.ReactNode): Root {
    unmountFromElement(domElement);
    const root = createRoot(domElement);
    rootsMap.set(domElement, root);
    root.render(
        <Provider store={store}>
            <SurfaceWindowContext.Provider value={domElement.ownerDocument.defaultView}>
                {getTransportConfigurationError() ? (
                    <div role="alert" style={{ padding: 20 }}>
                        <strong>Beaver couldn’t start</strong>
                        <p>{getTransportConfigurationError()}</p>
                        <p>
                            Restart Zotero. If this continues, reinstall Beaver.
                        </p>
                    </div>
                ) : children}
            </SurfaceWindowContext.Provider>
        </Provider>,
    );
    return root;
}

/**
 * Unmount a React root from a DOM element
 */
export function unmountFromElement(domElement: HTMLElement): boolean {
    const root = rootsMap.get(domElement);
    if (root) {
        root.unmount();
        rootsMap.delete(domElement);
        return true;
    }
    return false;
}

/** Unmount every root, including those whose container left the document. */
export function unmountAllSurfaces(): void {
    for (const root of rootsMap.values()) {
        try { root.unmount(); } catch (error) { Zotero.logError(error as Error); }
    }
    rootsMap.clear();
}

export function mountedSurfaceCount(): number {
    return rootsMap.size;
}
