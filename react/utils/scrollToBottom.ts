
// Function to scroll to the bottom of the chat container
// const scrollToBottom = () => {
//   if (containerRef.current && !userScrolled) {
//     containerRef.current.scrollTop = containerRef.current.scrollHeight;
//   }
// };

export const scrollToBottom = (containerRef: React.RefObject<HTMLElement>, userScrolled: boolean) => {
    if (!(containerRef.current && !userScrolled))
        return;
    const container = containerRef.current;
    const targetScrollTop = container.scrollHeight;
    const startScrollTop = container.scrollTop;
    const distance = targetScrollTop - startScrollTop;
    const duration = 1; // Adjust the duration (in milliseconds) to control the scrolling speed

    let start: number | null = null;

    const step = (timestamp: number) => {
        if (!start) start = timestamp;
        const progress = timestamp - start;
        const percentage = Math.min(progress / duration, 1);
        const scrollTop = startScrollTop + distance * percentage;
        container.scrollTop = scrollTop;

        if (progress < duration) {
            Zotero.getMainWindow().requestAnimationFrame(step);
        }
    };

    Zotero.getMainWindow().requestAnimationFrame(step);
};
