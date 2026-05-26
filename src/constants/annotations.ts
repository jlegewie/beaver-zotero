export const BEAVER_ANNOTATION_AUTHOR = 'Beaver';
export const BEAVER_VISUALIZER_ANNOTATION_AUTHOR = 'Beaver Visualizer';

const BEAVER_ANNOTATION_AUTHORS = new Set([
    BEAVER_ANNOTATION_AUTHOR,
    BEAVER_VISUALIZER_ANNOTATION_AUTHOR,
]);

/**
 * Whether an annotation was created by Beaver (agent, citation preview, visualizer, etc.).
 */
export function isBeaverAuthoredAnnotation(authorName: string | undefined | null): boolean {
    return !!authorName && BEAVER_ANNOTATION_AUTHORS.has(authorName);
}
