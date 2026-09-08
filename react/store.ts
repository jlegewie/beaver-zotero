import { createStore } from 'jotai';

/** Each evaluated renderer owns its atoms and store; its mounted surfaces share both. */
export const store = createStore();
