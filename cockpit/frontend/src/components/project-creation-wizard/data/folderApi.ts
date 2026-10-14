// Request layer over the host's folder and project endpoints. Each function
// reads the JSON body on success and on failure (the host's error envelope is
// JSON), turns a non-OK response into an Error carrying the host's message,
// and lets a rejected fetch propagate untouched.
import { api } from '@/utils/api';

import type {
  CreateProjectPayload,
  CreateProjectResponse,
  FolderListingResponse,
  FolderSuggestion,
  MakeFolderResponse,
} from '../types';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const nonBlankString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() !== '' ? value : undefined;

/** The message inside the host's `error` field, if it carries a usable one. */
function hostErrorMessage(error: unknown): string | undefined {
  const direct = nonBlankString(error);
  if (direct !== undefined) return direct;
  if (isRecord(error)) return nonBlankString(error.message);
  return undefined;
}

/**
 * Parse the body as JSON and reject non-OK responses with the host's message.
 * A body that is not valid JSON counts as a failure with the fallback message.
 */
async function readEnvelope(response: Response, fallbackMessage: string): Promise<Record<string, unknown>> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new Error(fallbackMessage);
  }
  const envelope = isRecord(body) ? body : {};
  if (!response.ok) {
    throw new Error(hostErrorMessage(envelope.error) ?? fallbackMessage);
  }
  return envelope;
}

const isFolderSuggestion = (value: unknown): value is FolderSuggestion =>
  isRecord(value) && typeof value.name === 'string' && typeof value.path === 'string';

/** Sub-folders of `path` as the host lists them, plus the absolute path it read. */
export async function fetchFolderListing(path: string): Promise<{ path: string; suggestions: FolderSuggestion[] }> {
  const response = await api.listFolders(path);
  const data: FolderListingResponse = await readEnvelope(response, 'Failed to browse filesystem');
  const suggestions = Array.isArray(data.suggestions) ? data.suggestions.filter(isFolderSuggestion) : [];
  return {
    path: typeof data.path === 'string' ? data.path : path,
    suggestions,
  };
}

/** Create a folder (parents included); resolves to its absolute path. */
export async function createFolder(path: string): Promise<string> {
  const response = await api.makeFolder(path);
  const data: MakeFolderResponse = await readEnvelope(response, 'Failed to create folder');
  return typeof data.path === 'string' ? data.path : path;
}

/** Register a folder as a cockpit project; resolves to the host's project record. */
export async function createProject(payload: CreateProjectPayload): Promise<Record<string, unknown> | undefined> {
  const response = await api.createProject(payload);
  const data: CreateProjectResponse = await readEnvelope(response, 'Failed to create project');
  return isRecord(data.project) ? data.project : undefined;
}
