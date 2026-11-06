import { FilePen, FileText, Globe, Search, Terminal, Users, Wrench, type LucideIcon } from 'lucide-react';

import type { ToolKind } from './chat-state';

export const TARGET = 'min-h-11 md:min-h-0';

export const TOOL_ICONS: Record<ToolKind, LucideIcon> = {
  read: FileText, edit: FilePen, execute: Terminal, search: Search, fetch: Globe, agent: Users, other: Wrench,
};
