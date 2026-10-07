import { makeAdapter } from '../chan-impl.mjs';

export const createChannel = (init) => makeAdapter(init, 'createChannel');
export const other = (init) => makeAdapter(init, 'other');
export default (init) => makeAdapter(init, 'default');
