// Data shapes the project wizard passes between its request layer and its
// components. Every response field is optional on purpose: the host's JSON is
// narrowed defensively and a missing field must never crash the module.

/** One directory entry as the host lists it. */
export type FolderSuggestion = {
  /** The folder's base name. */
  name: string;
  /** Absolute path. */
  path: string;
  /** The host sends `"directory"`. */
  type?: string;
};

/** The host's error field: a plain message or a coded envelope. */
export type HostError = string | { code?: string; message?: string };

export type FolderListingResponse = {
  path?: string;
  suggestions?: FolderSuggestion[];
  error?: HostError;
};

export type MakeFolderResponse = {
  success?: boolean;
  path?: string;
  error?: HostError;
};

export type CreateProjectPayload = {
  path: string;
  /** Omitted when empty; the host then names the project after the folder. */
  customName?: string;
};

export type CreateProjectResponse = {
  success?: boolean;
  created?: boolean;
  project?: Record<string, unknown>;
  error?: HostError;
};
