import { describe, expect, it } from 'vitest';

import { isKeyboardHeight } from './useSoftKeyboardOpen';

describe('isKeyboardHeight', () => {
  it('sees the keyboard in the heights measured on an iPhone home-screen app', () => {
    expect(isKeyboardHeight(812, 416)).toBe(true);
    expect(isKeyboardHeight(812, 812)).toBe(false);
  });

  it('takes browser chrome showing or hiding for no keyboard', () => {
    expect(isKeyboardHeight(760, 660)).toBe(false);
  });
});
