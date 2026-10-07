import { makeAdapter } from '../chan-impl.mjs';

export const createChannel = async (init) => makeAdapter(init, 'import-only');
