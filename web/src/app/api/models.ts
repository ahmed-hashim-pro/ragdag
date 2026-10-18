/**
 * Typed API models. These mirror `docs/openapi.json` (FastAPI, all paths under `/api`).
 * Dates are ISO-8601 strings; UUIDs are strings.
 */

export type Uuid = string;
export type IsoDate = string;

export type Role = 'owner' | 'admin' | 'editor' | 'viewer';
export const ROLES: readonly Role[] = ['owner', 'admin', 'editor', 'viewer'];
export const ROLE_RANK: Record<Role, number> = { viewer: 0, editor: 1, admin: 2, owner: 3 };

// ------------------------------------------------------------------ errors

export interface ValidationErrorItem {
  loc: (string | number)[];
  msg: string;
  type: string;
}

export interface HttpValidationError {
  detail?: ValidationErrorItem[];
}

/** FastAPI error body: `detail` is a string for HTTPException, an array for 422s. */
export interface ApiErrorBody {
  detail?: string | ValidationErrorItem[];
}

// ------------------------------------------------------------------ auth

export interface BootstrapOut {
  needs_setup: boolean;
  allow_signup: boolean;
}

export interface RegisterIn {
  email: string;
  name: string;
  /** min 10, max 256 */
  password: string;
  workspace_name?: string | null;
  invite_token?: string | null;
}

export interface LoginIn {
  email: string;
  password: string;
}

export interface TokenOut {
  access_token: string;
  token_type?: string;
  /** seconds */
  expires_in: number;
}

export interface UserOut {
  id: Uuid;
  email: string;
  name: string;
  created_at: IsoDate;
}

export interface MembershipOut {
  workspace_id: Uuid;
  workspace_name: string;
  workspace_slug: string;
  role: Role;
}

export interface MeOut {
  user: UserOut;
  memberships: MembershipOut[];
}

export interface PasswordChangeIn {
  current_password: string;
  new_password: string;
}

export interface AcceptInviteIn {
  token: string;
}

export interface InvitePreviewOut {
  workspace_name: string;
  email: string;
  role: Role;
  user_exists: boolean;
}

// ------------------------------------------------------------------ workspaces

export interface WorkspaceIn {
  name: string;
}

export interface WorkspaceOut {
  id: Uuid;
  name: string;
  slug: string;
  created_at: IsoDate;
}

export interface MemberOut {
  user_id: Uuid;
  email: string;
  name: string;
  role: Role;
  joined_at: IsoDate;
}

export interface MemberRoleIn {
  role: Role;
}

export interface InviteIn {
  email: string;
  role?: Role;
}

export interface InviteOut {
  id: Uuid;
  email: string;
  role: Role;
  expires_at: IsoDate;
  accepted_at: IsoDate | null;
  created_at: IsoDate;
  /** Only present in the response to POST (shown once). */
  invite_url?: string | null;
}

export interface ApiKeyIn {
  /** 20–300 chars; write-only */
  api_key: string;
}

export interface ApiKeyStatusOut {
  configured: boolean;
  hint?: string | null;
  updated_at?: IsoDate | null;
  model: string;
}

export interface AuditOut {
  id: number;
  action: string;
  target: string | null;
  meta: Record<string, unknown>;
  user_email: string | null;
  created_at: IsoDate;
}

export interface UsageOut {
  questions: number;
  answered: number;
  refused: number;
  no_evidence: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  documents: number;
  chunks: number;
}

// ------------------------------------------------------------------ collections

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export const EFFORTS: readonly Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];

export interface CollectionSettings {
  /** 100–2000, default 400 */
  chunk_tokens: number;
  /** 0–500, must be < chunk_tokens, default 60 */
  chunk_overlap: number;
  /** 1–30, default 8 */
  top_k: number;
  /** 0–1, default 0.25 */
  similarity_floor: number;
  effort: Effort;
}

export const DEFAULT_COLLECTION_SETTINGS: CollectionSettings = {
  chunk_tokens: 400,
  chunk_overlap: 60,
  top_k: 8,
  similarity_floor: 0.25,
  effort: 'medium',
};

export interface CollectionIn {
  name: string;
  description?: string;
  settings?: CollectionSettings;
}

export interface CollectionPatch {
  name?: string | null;
  description?: string | null;
  /** Replaces the whole settings object. */
  settings?: CollectionSettings | null;
}

export interface CollectionOut {
  id: Uuid;
  name: string;
  description: string;
  settings: CollectionSettings;
  created_at: IsoDate;
  document_count: number;
  ready_count: number;
  chunk_count: number;
}

// ------------------------------------------------------------------ documents

export type DocumentStatus = 'pending' | 'processing' | 'ready' | 'failed';
export const DOCUMENT_STATUSES: readonly DocumentStatus[] = ['pending', 'processing', 'ready', 'failed'];

export interface DocumentOut {
  id: Uuid;
  collection_id: Uuid;
  source_id: Uuid | null;
  title: string;
  filename: string;
  mime_type: string;
  size_bytes: number;
  sha256: string;
  /** pending | processing | ready | failed (typed as string in the OpenAPI schema) */
  status: DocumentStatus | string;
  error: string | null;
  chunk_count: number;
  token_count: number;
  created_at: IsoDate;
  updated_at: IsoDate;
  indexed_at: IsoDate | null;
}

export interface DocumentPage {
  items: DocumentOut[];
  total: number;
}

export interface UploadResult {
  document: DocumentOut;
  duplicate?: boolean;
}

export interface ChunkOut {
  id: number;
  ordinal: number;
  heading: string;
  content: string;
  token_count: number;
}

export interface DocumentQuery {
  q?: string;
  status_filter?: string;
  offset?: number;
  limit?: number;
}

// ------------------------------------------------------------------ sources

export type SourceKind = 'url' | 'folder';

export interface SourceIn {
  kind: SourceKind;
  name: string;
  url?: string | null;
  /** Relative to the server's mounted sources directory. */
  path?: string | null;
  glob?: string;
  /** 15–10080 */
  interval_minutes?: number;
  enabled?: boolean;
}

export interface SourcePatch {
  name?: string | null;
  interval_minutes?: number | null;
  enabled?: boolean | null;
}

export interface SourceConfig {
  url?: string;
  path?: string;
  glob?: string;
  [key: string]: unknown;
}

export interface SourceOut {
  id: Uuid;
  collection_id: Uuid;
  kind: SourceKind | string;
  name: string;
  config: SourceConfig;
  interval_minutes: number;
  enabled: boolean;
  last_synced_at: IsoDate | null;
  last_error: string | null;
  created_at: IsoDate;
}

// ------------------------------------------------------------------ pipelines

export const DAG_IDS = [
  'ragdag_ingest_document',
  'ragdag_sync_sources',
  'ragdag_reindex_collection',
  'ragdag_maintenance',
] as const;

export const RUN_STATES = ['queued', 'running', 'success', 'failed', 'skipped'] as const;
export const TERMINAL_RUN_STATES: ReadonlySet<string> = new Set(['success', 'failed', 'skipped']);

export interface PipelineRunOut {
  id: Uuid;
  dag_id: string;
  dag_run_id: string;
  state: string;
  collection_id: Uuid | null;
  document_id: Uuid | null;
  conf: Record<string, unknown>;
  error: string | null;
  created_at: IsoDate;
  started_at: IsoDate | null;
  ended_at: IsoDate | null;
}

export interface RunPage {
  items: PipelineRunOut[];
  total: number;
}

export interface RunQuery {
  dag_id?: string;
  state?: string;
  collection_id?: string;
  document_id?: string;
  offset?: number;
  limit?: number;
}

export interface TaskNode {
  task_id: string;
  downstream: string[];
  state?: string | null;
  try_number?: number | null;
  map_index?: number;
  mapped_count?: number;
  start_date?: IsoDate | null;
  end_date?: IsoDate | null;
  /** seconds */
  duration?: number | null;
}

export interface RunDetailOut {
  run: PipelineRunOut;
  airflow_state: string | null;
  tasks: TaskNode[];
  airflow_ui_url: string | null;
}

export interface TaskLogOut {
  task_id: string;
  try_number: number;
  content: string;
}

// ------------------------------------------------------------------ search / ask

export interface SearchIn {
  query: string;
  collection_id: Uuid;
  top_k?: number;
}

export interface SearchHit {
  chunk_id: number;
  document_id: Uuid;
  title: string;
  heading: string;
  content: string;
  score: number;
  similarity: number | null;
  lexical: boolean;
}

export interface SearchOut {
  hits: SearchHit[];
  best_similarity: number;
  confident: boolean;
}

export interface AskIn {
  question: string;
  collection_id: Uuid;
  conversation_id?: Uuid | null;
}

/**
 * A retrieved source. Sent in the `sources` SSE event and stored (the subset actually cited)
 * in `MessageOut.citations` (which OpenAPI types loosely as `object[]`).
 */
export interface Citation {
  n: number;
  chunk_id: number;
  document_id: Uuid;
  title: string;
  heading: string;
  score: number;
  similarity: number | null;
  snippet: string;
}

export type MessageStatus = 'ok' | 'no_evidence' | 'refused' | 'error';

export interface MessageUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

export interface MessageOut {
  id: Uuid;
  role: 'user' | 'assistant' | string;
  content: string;
  citations: Citation[];
  status: MessageStatus | string;
  model: string | null;
  usage: MessageUsage;
  latency_ms: number | null;
  created_at: IsoDate;
}

export interface ConversationOut {
  id: Uuid;
  collection_id: Uuid;
  title: string;
  created_at: IsoDate;
  updated_at: IsoDate;
}

export interface ConversationDetailOut extends ConversationOut {
  messages: MessageOut[];
}

/** Server-sent events emitted by `POST /api/w/{ws}/ask`. */
export type AskEvent =
  | { event: 'meta'; data: { conversation_id: Uuid; user_message_id: Uuid } }
  | { event: 'sources'; data: { sources: Citation[] } }
  | { event: 'delta'; data: { text: string } }
  | { event: 'reset'; data: Record<string, never> }
  | { event: 'done'; data: { message: MessageOut; best_similarity?: number } }
  | { event: 'error'; data: { message: string } };
