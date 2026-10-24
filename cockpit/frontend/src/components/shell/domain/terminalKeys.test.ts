import { describe, expect, it } from 'vitest';
import { imageReference, keySequence, submissionText } from './terminalKeys';

const normal = { applicationCursor: false };
const application = { applicationCursor: true };

describe('keySequence', () => {
  it('sends the bytes a hardware keyboard sends', () => {
    expect(keySequence('escape', normal)).toBe('\x1b');
    expect(keySequence('tab', normal)).toBe('\t');
    expect(keySequence('shift-tab', normal)).toBe('\x1b[Z');
    expect(keySequence('enter', normal)).toBe('\r');
    expect(keySequence('interrupt', normal)).toBe('\x03');
  });

  it('sends arrows as CSI normally and as SS3 in application cursor mode', () => {
    expect(keySequence('up', normal)).toBe('\x1b[A');
    expect(keySequence('down', normal)).toBe('\x1b[B');
    expect(keySequence('right', normal)).toBe('\x1b[C');
    expect(keySequence('left', normal)).toBe('\x1b[D');
    expect(keySequence('up', application)).toBe('\x1bOA');
    expect(keySequence('left', application)).toBe('\x1bOD');
  });
});

describe('submissionText', () => {
  it('drops trailing line breaks, Enter follows on its own', () => {
    expect(submissionText('fix the test\n\n')).toBe('fix the test');
  });

  it('keeps line breaks inside a message', () => {
    expect(submissionText('one\ntwo')).toBe('one\ntwo');
  });

  it('is empty for an empty message, so sending it is just Enter', () => {
    expect(submissionText('  \n')).toBe('');
  });
});

describe('imageReference', () => {
  it('pastes the image path and leaves room for a caption', () => {
    expect(imageReference('/tmp/shot.png')).toBe('\x1b[200~/tmp/shot.png\x1b[201~ ');
  });
});
