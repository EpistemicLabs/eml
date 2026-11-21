/** The sidebar's props: the drawer comes separately (Sidebar). */
export interface SidebarProps {
  /** Settings, optionally open on one tab (the account row opens Account). */
  onShowSettings: (tab?: string) => void;
}

/** The compact layout's sidebar: a drawer the page opens and closes. */
export interface SidebarDrawer {
  open: boolean;
  onClose: () => void;
}

export interface SidebarError {
  /** Bumped per report so a repeated message restarts the dismiss timer. */
  id: number;
  message: string;
}
