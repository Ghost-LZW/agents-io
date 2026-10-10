import { describe, expect, it } from 'vitest';
import { FakeLark } from './fake-lark.js';
import { cardOf, make, route, turn } from './process-helpers.js';

describe('process card: CardKit streaming (panels)', () => {
  it('renders action buttons as callbacks and removes them when they go away #RQ-5', async () => {
    const { lark, adapter } = make({ process: 'panels' });
    const t = turn();
    const stop = { id: 'turn:t1:interrupt', label: 'Stop', style: 'danger' as const };
    const { providerMessageId: id } = await adapter.send(route, t.msg({ actions: [stop] }), { operationId: 'o' });
    const card = cardOf(lark, id!);
    const btn = card.json.body.elements.find((e: any) => e.tag === 'button');
    expect(btn).toMatchObject({ type: 'danger', behaviors: [{ type: 'callback', value: { actionId: 'turn:t1:interrupt' } }] });
    const approve = { id: 'req:r1:allow_once', label: 'Allow', style: 'primary' as const };
    await adapter.edit(route, id!, t.msg({ actions: [approve, stop] }), { operationId: 'e1', sequence: 1 });
    expect(card.json.body.elements.filter((e: any) => e.tag === 'button').map((e: any) => e.behaviors[0].value.actionId)).toEqual([
      'turn:t1:interrupt',
      'req:r1:allow_once',
    ]);
    await adapter.edit(route, id!, t.msg({ actions: [stop] }), { operationId: 'e2', sequence: 2 });
    expect(card.json.body.elements.filter((e: any) => e.tag === 'button')).toHaveLength(1);
    expect(card.json.body.elements.at(-1).element_id).toBe('footer');
  });

  it('a retried send after a lost reply reuses its card and bubble (same uuid, same message) #DL-2', async () => {
    const lark = new FakeLark();
    const reply = lark.client.im.v1.message.reply;
    let lose = true;
    // The server applies the reply, the client sees a transport error.
    lark.client.im.v1.message.reply = async (req) => {
      const r = await reply(req);
      if (lose && JSON.parse(req.data.content).data?.card_id) {
        lose = false;
        throw new Error('socket hang up');
      }
      return r;
    };
    const { adapter } = make({ process: 'cot' }, lark);
    const t = turn();
    t.p.steps.push({ kind: 'reasoning', id: 'r0', text: 'hmm', done: false });
    await expect(adapter.send(route, t.msg(), { operationId: 'op' })).rejects.toThrow('socket hang up');
    const { providerMessageId: id } = await adapter.send(route, t.msg(), { operationId: 'op' }); // the outbox retries
    expect(lark.messages.filter((m) => m.msg_type === 'interactive')).toHaveLength(1);
    expect(lark.cards.size).toBe(1);
    expect(lark.cots).toHaveLength(1);
    t.p.answer = 'HELLO';
    t.p.status = 'completed';
    t.p.answerFinal = true;
    await adapter.finalize(route, id!, t.msg());
    await adapter.settled();
    // The card the message shows is the one that got the answer.
    expect(FakeLark.element(cardOf(lark, id!).json, 'answer').content).toBe('HELLO');
  });

  it('is idempotent per operationId and drops stale edit sequences #DL-2', async () => {
    const { lark, adapter } = make({ process: 'panels' });
    const t = turn();
    const a = await adapter.send(route, t.msg(), { operationId: 'same' });
    const b = await adapter.send(route, t.msg(), { operationId: 'same' });
    expect(b).toEqual(a);
    t.p.answer = 'two';
    await adapter.edit(route, a.providerMessageId!, t.msg(), { operationId: 'e2', sequence: 2 });
    t.p.answer = 'one';
    await adapter.edit(route, a.providerMessageId!, t.msg(), { operationId: 'e1', sequence: 1 });
    expect(lark.messages).toHaveLength(1);
    expect(FakeLark.element(cardOf(lark, a.providerMessageId!).json, 'answer').content).toBe('two');
    // A restart re-sends under the same uuid: still one platform message.
    const fresh = make({ process: 'panels' }, lark).adapter;
    expect(await fresh.send(route, t.msg(), { operationId: 'same' })).toEqual(a);
    expect(lark.messages).toHaveLength(1);
  });

  it('retries interaction-lock / rate-limit rejections with the same sequence and uuid #DL-2', async () => {
    const { lark, adapter } = make({ process: 'panels' });
    const t = turn();
    const { providerMessageId: id } = await adapter.send(route, t.msg(), { operationId: 'o' });
    lark.fail.set('cardElement.content', [200810, 99991400]);
    t.p.answer = 'hello';
    await adapter.edit(route, id!, t.msg(), { operationId: 'e', sequence: 1 });
    const card = cardOf(lark, id!);
    expect(card.ops.filter((o) => o.op === 'cardElement.content')).toHaveLength(1);
    expect(lark.log.filter((x) => x === 'cardElement.content:answer')).toHaveLength(3);
    expect(FakeLark.element(card.json, 'answer').content).toBe('hello');
  });
});

describe('process card: degradation', () => {
  it('takes over a CardKit card it did not send (restart) via idConvert + card.update #RS-1', async () => {
    const { lark, adapter } = make({ process: 'panels' });
    const t = turn();
    const { providerMessageId: id } = await adapter.send(route, t.msg(), { operationId: 'o' });
    const fresh = make({ process: 'panels' }, lark).adapter;
    lark.fail.set('message.patch', [230020]);
    t.p.answer = 'after restart';
    await fresh.edit(route, id!, t.msg(), { operationId: 'e', sequence: 1 });
    expect(FakeLark.element(cardOf(lark, id!).json, 'answer').content).toBe('after restart');
  });
});
