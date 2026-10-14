// Page link inside a brain surface — the 1:1 stand-in for packages/web's
// next/link on dashboard/project/search links. Engram links are NOT this:
// they stay react-router <Link to={hrefFor(id)}> so the global drawer opens.
import type { MouseEvent, ReactNode } from 'react';

import type { BrainLoc } from '@/lib/brain-nav';
import { useBrainNav } from './BrainSurface';

type BrainLinkProps = {
  to: BrainLoc;
  className?: string;
  title?: string;
  children: ReactNode;
};

export default function BrainLink({ to, className, title, children }: BrainLinkProps) {
  const { go } = useBrainNav();
  const handleClick = (event: MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault();
    go(to);
  };
  return (
    <a href="#" onClick={handleClick} className={className} title={title}>
      {children}
    </a>
  );
}
