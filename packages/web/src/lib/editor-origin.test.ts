import { describe, expect, it } from 'vitest';
import { editorNeedsSecureCookie } from './editor-origin';

describe('plain HTTP editor cookie transport', () => {
  it.each([
    ['http://localhost:3000', 'http://localhost:3001', false],
    ['http://app.example.com', 'http://api.example.com', false],
    ['http://app.example.co.uk', 'http://ide.example.co.uk', false],
    ['http://app.example.co.uk', 'http://api.other.co.uk', true],
    ['http://haive', 'http://haive-api', true],
    ['http://127.0.0.1:3000', 'http://127.0.0.1:3001', false],
    ['http://127.0.0.1:3000', 'http://127.0.0.2:3001', true],
    ['http://[::1]:3000', 'http://[::1]:3001', false],
    ['http://app.github.io', 'http://editor.github.io', true],
    ['http://app.localhost', 'http://api.localhost', true],
    ['https://app.example.com', 'http://ide.example.com', true],
    ['http://app.example.com', 'https://editor.other.com', false],
    ['https://app.example.com', 'https://editor.other.com', false],
  ])('compares scheme and registrable site for %s → %s', (web, editor, blocked) => {
    expect(editorNeedsSecureCookie(web, editor)).toBe(blocked);
  });
});
