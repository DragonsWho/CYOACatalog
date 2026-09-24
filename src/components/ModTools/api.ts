// Client for /api/modkit/* (modkit.go). The helper app talks to the same server with its own device
// token; this page only creates jobs and reads their progress.
import { authedFetch } from '../../pocketbase/pocketbase';

export interface HelperDevice {
  id: string;
  name: string;
  platform: string;
  client_version: string;
  last_seen: string;
  online: boolean;
  created: string;
}

export type JobKind = 'download' | 'import' | 'check' | 'upload';
export type JobStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled';

// Written by the helper after a download/import/check (tools/cyoa-helper/check.go).
export interface CheckReport {
  item: string;
  title?: string;
  source_url?: string;
  preview_url?: string;
  files: number;
  bytes: number;
  engine?: string;
  has_index: boolean;
  refs?: number;
  missing?: string[];
  missing_count?: number;
  hotlinks?: string[];
  hotlink_count?: number;
  root_absolute?: string[];
  escaping?: string[];
  failed_downloads?: string[];
  warnings?: string[];
  verdict: 'ok' | 'warn' | 'bad';
  suggested_slug?: string;
  author_guess?: string;
}

export interface HostedResult {
  id: string;
  url: string;
  user_slug: string;
  slug: string;
  version: number;
  files: number;
  size: number;
}

export interface HelperJob {
  id: string;
  device: string;
  kind: JobKind;
  status: JobStatus;
  input: Record<string, string>;
  progress: { phase?: string; message?: string; done?: number; total?: number; bytes?: number };
  result: (Partial<CheckReport> & { hosted?: HostedResult }) | Record<string, never>;
  error: string;
  created: string;
  updated: string;
  log?: string;
}

export interface HostingAccount {
  id: string;
  username: string;
  name: string;
  hosting_slug: string;
  reserved: boolean;
  games: number;
  home: string;
}

export interface DupHit {
  where: 'catalog' | 'pipeline';
  id: string;
  title: string;
  state?: string;
  link?: string;
  why: string;
}

export class ApiError extends Error {
  status: number;
  data: Record<string, unknown>;
  constructor(status: number, message: string, data: Record<string, unknown>) {
    super(message);
    this.status = status;
    this.data = data;
  }
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await authedFetch(path, init);
  let data: Record<string, unknown> = {};
  try {
    data = await res.json();
  } catch { /* empty body */ }
  if (!res.ok) {
    const msg = (data.error as string) || (data.message as string) || `Request failed (${res.status})`;
    throw new ApiError(res.status, msg, data);
  }
  return data as T;
}

export const listDevices = () => api<{ devices: HelperDevice[] }>('/api/modkit/devices');
export const confirmPairing = (code: string) =>
  api<{ device: HelperDevice }>('/api/modkit/pair/confirm', { method: 'POST', body: JSON.stringify({ code }) });
export const revokeDevice = (id: string) =>
  api<{ ok: boolean }>(`/api/modkit/devices/${id}/revoke`, { method: 'POST' });

export const listJobs = (limit = 40) => api<{ jobs: HelperJob[] }>(`/api/modkit/jobs?limit=${limit}`);
export const getJob = (id: string) => api<HelperJob>(`/api/modkit/jobs/${id}`);
export const createJob = (device: string, kind: JobKind, input: Record<string, string>) =>
  api<HelperJob>('/api/modkit/jobs', { method: 'POST', body: JSON.stringify({ device, kind, input }) });
export const cancelJob = (id: string) => api<HelperJob>(`/api/modkit/jobs/${id}/cancel`, { method: 'POST' });

export const findHostingAccounts = (q: string) =>
  api<{ accounts: HostingAccount[]; suggestion?: { slug: string; available: boolean; reason: string } }>(
    `/api/modkit/hosting-accounts?q=${encodeURIComponent(q)}`,
  );
export const createHostingAccount = (name: string, slug: string) =>
  api<{ account: HostingAccount }>('/api/modkit/hosting-accounts', {
    method: 'POST', body: JSON.stringify({ name, slug }),
  });

export const dupCheck = (url: string, title: string) =>
  api<{ hits: DupHit[] }>(`/api/modkit/dupcheck?url=${encodeURIComponent(url)}&title=${encodeURIComponent(title)}`);

export interface CardPayload {
  title: string;
  description: string;
  authors: string[];
  tags: string[];
  nsfw: boolean;
  source_url: string;
  upload_job: string;
  aliases: string;
  image_base64: string;
  confirm_not_duplicate: boolean;
  note: string;
}

export function submitCard(payload: CardPayload, cover: Blob) {
  const fd = new FormData();
  fd.append('payload', JSON.stringify(payload));
  fd.append('image', cover, 'cover.webp');
  return api<{ id: string; slug: string }>('/api/modkit/cards', { method: 'POST', body: fd });
}

export function addVariant(gameId: string, body: {
  language: string; version_label: string; title: string; description: string; iframe_url: string;
}) {
  return api<{ id: string }>(`/api/custom/games/${gameId}/variants`, { method: 'POST', body: JSON.stringify(body) });
}

// Accepts a game URL (…/game/<id or slug>) or a bare id.
export function gameRefFromInput(raw: string): string {
  const s = raw.trim();
  const m = s.match(/\/game\/([^/?#]+)/);
  return decodeURIComponent(m ? m[1] : s);
}

// Same shape as the hosting slug rules (hosting.go isValidSlug): a-z 0-9 hyphens, 3-60.
export function slugify(s: string, max = 60): string {
  const out = s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, max).replace(/-+$/, '');
  return out.length >= 3 ? out : (out ? `${out}-cyoa` : '');
}

export const HELPER_RELEASES_URL = 'https://github.com/DragonsWho/CYOACatalog/releases/latest';
