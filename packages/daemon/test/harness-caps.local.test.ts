import { describe, expect, it } from 'vitest';
import { nextKey, rec, start } from './harness-caps-helpers.js';
import { until } from './helpers.js';

/*
 * Topic titles (G4 makes them a host hook) are generated in an ephemeral session of a harness that
 * declares `ephemeralOpen`; a `use: "module"` harness declaring it gets them (fixtures/harness-caps.mjs).
 * The CT-2 / CT-3 capabilities are in harness-caps.test.ts.
 */

describe('harness capabilities: topic titles', () => {
  it("a module harness declaring ephemeralOpen titles a topic in an ephemeral session of its own, whose instructions (the title prompt's) win over the agent's", async () => {
    const key = nextKey();
    const w = await start({ plug: { key, ephemeralOpen: true } }, (dir) => ({ helper: { harness: 'plug', instructionsFile: `${dir}/helper.md` } }));
    await w.say('hi', (r) => r.includes('echo: hi'));
    // The first completed turn titles the topic in an ephemeral session of the same harness.
    const title = await until(() => rec(key).fake.sessions.find((s) => s.args.sessionKey.startsWith('topic-title:')));
    expect(title.args.options).toMatchObject({ ephemeral: true, preface: false });
    const [session] = rec(key).fake.sessions;
    expect(session!.args).toMatchObject({ instructions: 'Be helpful.', options: { developerInstructions: 'Be helpful.' } });
    // The open's own instructions, also in the transitional option a module harness gets.
    const prompt = 'You only return a brief title for supplied text. Do not use tools or read files.';
    expect(title.args).toMatchObject({ instructions: prompt, options: { developerInstructions: prompt } });
  });
});
