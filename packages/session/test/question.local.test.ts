import { describe, expect, it } from 'vitest';
import type { BodyOf } from '@agents-io/protocol';
import { parseQuestionActionId, questionActionId, questionFormAnswer, questionTextAnswer } from '../src/question.js';

const req: BodyOf<'request.opened'> = {
  t: 'request.opened', requestId: 'r1', kind: 'question', title: 'Settings', risk: {},
  questions: [
    { id: 'q1', text: 'First' },
    { id: 'q0', text: 'Second' },
  ],
  allowedDecisions: ['answer', 'deny'], allowAlways: false, defaultDeny: false,
};

describe('native question answers', () => {
  it('maps form fields by position even when native ids look like form names', () => {
    expect(questionFormAnswer(req, { q0: 'first', q1: 'second' })).toEqual({ kind: 'answer', answers: { q1: 'first', q0: 'second' } });
    expect(questionFormAnswer(req, { q0: 'first' })).toBe('Question 2 needs an answer.');
  });

  it('maps selections and custom answers, and rejects forged option values', () => {
    const choices: BodyOf<'request.opened'> = { ...req, questions: [
      { id: 'color', text: 'Color?', options: [{ label: 'Red' }, { label: 'Blue' }] },
      { id: 'features', text: 'Features?', multiSelect: true, options: [{ label: 'Search' }, { label: 'Export' }] },
    ] };
    expect(questionFormAnswer(choices, { q0_choice: '1', q0_other: '', q1_choice: ['0'], q1_other: 'Custom' })).toEqual({ kind: 'answer', answers: { color: 'Blue', features: ['Search', 'Custom'] } });
    expect(questionFormAnswer(choices, { q0_choice: '1', q0_other: 'Other', q1_choice: ['0'], q1_other: '' })).toEqual({ kind: 'answer', answers: { color: 'Other', features: ['Search'] } });
    expect(questionFormAnswer(choices, { q0_choice: '9', q0_other: '', q1_choice: ['0'] })).toBe('Question 1 has an invalid option.');
  });

  it('accepts a keyed JSON answer and a session-scoped action code', () => {
    expect(questionTextAnswer(req, '{"q1":"first","q0":"second"}')).toEqual({ kind: 'answer', answers: { q1: 'first', q0: 'second' } });
    expect(parseQuestionActionId(questionActionId('topic:main', 'r1'))).toEqual({ sessionKey: 'topic:main', requestId: 'r1' });
    expect(parseQuestionActionId('ask:bad')).toBeUndefined();
  });
});
