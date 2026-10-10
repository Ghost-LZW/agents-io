import { describe, expect, it } from 'vitest';
import { parseCli, redispatchRequest } from '../src/cli.js';

describe('inbound.redispatch', () => {
  it('aio redispatch parses its arguments', () => {
    const r = (argv: string[]) => redispatchRequest(parseCli(['redispatch', ...argv]));
    expect(r(['7'])).toEqual({ cursor: 7 });
    expect(r(['7', '--agent', 'chat', '--session', 'main', '--cwd', '/w', '--env', 'A=1'])).toEqual({ cursor: 7, agent: 'chat', session: 'main', launch: { cwd: '/w', env: { A: '1' } } });
    expect(r(['7', '--session', 'K9'])).toEqual({ cursor: 7, session: { key: 'K9' } });
    expect(r(['7', '--session', '{"key":"K9","agent":"x"}']).session).toEqual({ key: 'K9', agent: 'x' });
    expect(() => r(['x'])).toThrow(/usage/);
  });
});
