import React, { createContext, useContext } from 'react';
import { getHostWindow } from './windowRuntime';

/** The document hosting this React tree, including borrowed surfaces. */
export const SurfaceWindowContext = createContext<Window | null>(null);
export function useSurfaceWindow(): Window {
    return useContext(SurfaceWindowContext) ?? getHostWindow();
}
