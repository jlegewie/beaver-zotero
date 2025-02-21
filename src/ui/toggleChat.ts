import { eventManager } from '../../react/events/eventManager';

/**
* Toggle the chat panel on and off.
* 
* @param win - The window to toggle the chat in.
* @param turnOn - Whether to turn the chat on or off.
*/
export function triggerToggleChat(win: Window) {
    eventManager.dispatch('toggleChat', { 
        location: 'library'
    });
}
