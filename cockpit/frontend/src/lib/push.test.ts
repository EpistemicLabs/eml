import { describe, it, expect } from 'vitest';

import { deviceLabel, keyBytes, pushSupport } from './push';

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.1 Mobile/15E148 Safari/604.1';
const MAC_SAFARI = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.1 Safari/605.1.15';
const MAC_CHROME = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36';

describe('deviceLabel', () => {
  it('names the device the way Settings lists it', () => {
    expect(deviceLabel(IPHONE)).toBe('iPhone');
    expect(deviceLabel(MAC_SAFARI)).toBe('Mac · Safari');
    expect(deviceLabel(MAC_CHROME)).toBe('Mac · Chrome');
    expect(deviceLabel('Mozilla/5.0 (X11; Linux x86_64) Gecko/20100101 Firefox/145.0')).toBe('Linux · Firefox');
  });
});

describe('keyBytes', () => {
  it('turns the host\'s base64url key into the bytes subscribe() takes', () => {
    expect([...keyBytes('BAEC_-8')]).toEqual([4, 1, 2, 255, 239]);
  });
});

describe('pushSupport', () => {
  it('asks for the home screen on an iPhone outside the home-screen app', () => {
    expect(pushSupport({ userAgent: IPHONE, standalone: false, hasPush: false })).toBe('home-screen');
    expect(pushSupport({ userAgent: IPHONE, standalone: true, hasPush: true })).toBe('supported');
    expect(pushSupport({ userAgent: MAC_CHROME, standalone: false, hasPush: true })).toBe('supported');
    expect(pushSupport({ userAgent: MAC_CHROME, standalone: false, hasPush: false })).toBe('unsupported');
  });
});
