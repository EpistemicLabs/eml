// How a reply's markdown is made safe to show. An image in a reply loads by itself, and
// its URL can carry data to any server: only images already in the page (data:, blob:)
// may show; any other becomes a link, opened on purpose through Streamdown's link check.
// The host's CSP blocks remote images too (http.ts); this holds without it.
import { defaultRehypePlugins, type StreamdownProps } from 'streamdown';

type PluggableList = NonNullable<StreamdownProps['rehypePlugins']>;
type Pluggable = PluggableList[number];

type HastNode = { type: string; tagName?: string; properties?: Record<string, unknown>; children?: HastNode[]; value?: string };

/** Shown as it is: an image the page already holds. */
export function isLocalImage(src: string): boolean {
  return src.startsWith('data:image/') || src.startsWith('blob:');
}

function imageLink(image: HastNode, src: string): HastNode {
  const alt = typeof image.properties?.alt === 'string' ? image.properties.alt.trim() : '';
  return {
    type: 'element',
    tagName: 'a',
    properties: { href: src },
    children: [{ type: 'text', value: `Image: ${alt || src}` }],
  };
}

/** Turns each image not already in the page into a link; harden then checks the link like any other. */
export function rehypeLinkRemoteImages() {
  const visit = (node: HastNode) => {
    if (!node.children) return;
    node.children = node.children.map((child) => {
      if (child.type === 'element' && child.tagName === 'img') {
        const src = typeof child.properties?.src === 'string' ? child.properties.src : '';
        if (src && !isLocalImage(src)) return imageLink(child, src);
      }
      visit(child);
      return child;
    });
  };
  return (tree: HastNode) => visit(tree);
}

const [harden, hardenDefaults] = defaultRehypePlugins.harden as [Pluggable, Record<string, unknown>];

/** Streamdown's own plugins, with images limited to what the page holds. */
export const replyRehypePlugins: PluggableList = [
  defaultRehypePlugins.raw,
  defaultRehypePlugins.sanitize,
  rehypeLinkRemoteImages,
  [harden, { ...hardenDefaults, allowedImagePrefixes: [], allowDataImages: true }] as Pluggable,
];
