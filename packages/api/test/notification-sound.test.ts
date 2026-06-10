import { describe, expect, it } from 'vitest';
import { notificationSettingsUpdateSchema } from '@haive/shared';
import { resolveSoundType } from '../src/routes/user-settings.js';

describe('resolveSoundType', () => {
  it('maps known mime types', () => {
    expect(resolveSoundType('chime.mp3', 'audio/mpeg')).toEqual({
      ext: 'mp3',
      mime: 'audio/mpeg',
    });
    expect(resolveSoundType('a.bin', 'audio/wav')).toEqual({ ext: 'wav', mime: 'audio/wav' });
  });

  it('lets the declared mime win over the extension', () => {
    expect(resolveSoundType('chime.bin', 'audio/wav')?.ext).toBe('wav');
  });

  it('falls back to the extension for octet-stream or empty mime', () => {
    expect(resolveSoundType('chime.ogg', 'application/octet-stream')).toEqual({
      ext: 'ogg',
      mime: 'audio/ogg',
    });
    expect(resolveSoundType('chime.m4a', '')).toEqual({ ext: 'm4a', mime: 'audio/mp4' });
  });

  it('strips mime parameters', () => {
    expect(resolveSoundType('a.weird', 'audio/ogg; codecs=opus')?.ext).toBe('ogg');
  });

  it('is case-insensitive', () => {
    expect(resolveSoundType('CHIME.MP3', '')?.ext).toBe('mp3');
    expect(resolveSoundType('x', 'AUDIO/MPEG')?.ext).toBe('mp3');
  });

  it('rejects non-audio inputs', () => {
    expect(resolveSoundType('notes.txt', 'text/plain')).toBeNull();
    expect(resolveSoundType('archive.zip', 'application/zip')).toBeNull();
    expect(resolveSoundType('noext', '')).toBeNull();
  });
});

describe('notificationSettingsUpdateSchema', () => {
  it('accepts booleans', () => {
    expect(notificationSettingsUpdateSchema.parse({ soundEnabled: true }).soundEnabled).toBe(true);
    expect(notificationSettingsUpdateSchema.parse({ soundEnabled: false }).soundEnabled).toBe(
      false,
    );
  });

  it('rejects missing or non-boolean values', () => {
    expect(notificationSettingsUpdateSchema.safeParse({}).success).toBe(false);
    expect(notificationSettingsUpdateSchema.safeParse({ soundEnabled: 'true' }).success).toBe(
      false,
    );
  });
});
