// The header Brain tab's content: one brain surface, persisted across
// reloads. Dashboard → project → search live inside it (BrainSurface).
import BrainSurface from './BrainSurface';

export default function BrainDashboard() {
  return <BrainSurface surfaceId="tab" persist initialLoc={{ view: 'dashboard' }} />;
}
