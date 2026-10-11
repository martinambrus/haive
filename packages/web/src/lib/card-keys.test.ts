import { describe, expect, it } from 'vitest';
import { isCardActivation } from './card-keys';

const card = {};
const button = {};

describe('isCardActivation', () => {
  it('acts on Enter and Space aimed at the card itself', () => {
    expect(isCardActivation({ key: 'Enter', target: card, currentTarget: card })).toBe(true);
    expect(isCardActivation({ key: ' ', target: card, currentTarget: card })).toBe(true);
  });

  it('does nothing for an event that bubbled up from a button inside the card', () => {
    expect(isCardActivation({ key: 'Enter', target: button, currentTarget: card })).toBe(false);
    expect(isCardActivation({ key: ' ', target: button, currentTarget: card })).toBe(false);
  });

  it('ignores other keys on the card', () => {
    expect(isCardActivation({ key: 'Tab', target: card, currentTarget: card })).toBe(false);
  });
});
