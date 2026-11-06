/**
 * Presentation vocabulary shared by the table's view state and its renderer.
 * Anything that is a fact about the data rather than about the rendering
 * belongs in `@beaver/agent-core/layouts/table` instead.
 */

import React from "react";
import { FindHighlight } from "../chat/highlightText";

/**
 * Row height, and with it how many lines every cell clamps to. The pixel
 * values live in the table stylesheet, keyed on `data-density`.
 */
export type TableDensity = "compact" | "cozy" | "tall";

/**
 * Renders a cell's text. Text cells are markdown that may carry inline
 * `<citation …/>` tags, so the client injects its own markdown + citation
 * renderer; a rendering without one still shows the text.
 */
export type TextRenderer = (text: string) => React.ReactNode;

/** The text as it is, with the table search's hits marked. */
export const renderPlainText: TextRenderer = (text) => React.createElement(FindHighlight, { text });
