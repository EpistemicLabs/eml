// "N folders aren't in a brain project yet" (decision cockpit-brain-project-model): every project is a
// brain project now, and the open space still has folder-only projects of the user's (`linkable`). Link
// them opens the list to link or remove each. Derived from the project list: once none is left, the
// strip goes by itself.
import { useState } from 'react';
import { FolderInput } from 'lucide-react';

import LinkFoldersDialog from '@/components/projects/LinkFoldersDialog';
import type { Project } from '@/types/app';

import { Banner, BannerButton } from './Banner';

export default function LinkFoldersBanner({ projects, onChanged, onRemoved }: {
  /** The open space's projects. */
  projects: Project[];
  onChanged: () => void;
  onRemoved: (projectId: string) => void;
}) {
  // The folders as they were when the list opened: it keeps its rows while they are linked away.
  const [listed, setListed] = useState<Project[] | null>(null);
  const linkable = projects.filter((project) => project.linkable);
  const count = linkable.length;

  return (
    <>
      {count > 0 && (
        <Banner
          tone="info"
          icon={FolderInput}
          dismissKey={`link-folders:${linkable.map((p) => p.projectId).sort().join('|')}`}
          actions={<BannerButton onClick={() => setListed(linkable)}>{count === 1 ? 'Link it' : 'Link them'}</BannerButton>}
        >
          {count === 1 ? '1 folder isn’t in a brain project yet.' : `${count} folders aren’t in a brain project yet.`}
        </Banner>
      )}
      {listed && <LinkFoldersDialog projects={listed} onClose={() => setListed(null)} onChanged={onChanged} onRemoved={onRemoved} />}
    </>
  );
}
