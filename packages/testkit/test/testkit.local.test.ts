import { describe, expect, it } from 'vitest';
import { loadEnvFile, parseEnv } from '../src/index.js';

describe('parseEnv', () => {
  it('parses .env.live style files', () => {
    expect(
      parseEnv('# c\n\nexport A=1\nB = "two words"\nC=\'x#y\'\nD=val # note\nnot a line\nE=a=b'),
    ).toEqual({ A: '1', B: 'two words', C: 'x#y', D: 'val', E: 'a=b' });
  });

  it('loadEnvFile returns {} for a missing file', () => {
    expect(loadEnvFile('/nonexistent/agents-io/.env.live')).toEqual({});
  });
});
