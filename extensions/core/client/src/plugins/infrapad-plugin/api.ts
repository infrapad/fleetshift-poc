// Infrapad REST API helpers.
// During local dev, the infrapad grpc-gateway runs on a separate origin
// with permissive CORS.  The base URL is configurable so it can be
// pointed at a proxy or a different host later.
const INFRAPAD_BASE =
  (typeof window !== "undefined" &&
    (window as unknown as Record<string, unknown>).__INFRAPAD_API_BASE__) ||
  "http://localhost:8088";

async function infrapadFetch<T>(
  path: string,
  init?: RequestInit,
): Promise<T> {
  const res = await fetch(`${INFRAPAD_BASE}${path}`, init);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const msg =
      (body as Record<string, string>).message ||
      (body as Record<string, string>).error ||
      `Infrapad API error (${res.status})`;
    throw new Error(msg);
  }
  return res.json();
}

// ---- Domain types (matching the swagger / proto definitions) ----

export interface InfrapadBlock {
  name: string;
  blockNumber: number;
  revisionNumber: number;
  authorId?: string;
  type: string;
  status?: string; // "progressing" | "published" | "deleted"
  createdAt?: string;
  content: Record<string, unknown>;
}

export interface InfrapadDocument {
  name: string; // "documents/{id}"
  status: string; // "active" | "archived"
  title: string;
  namespace?: string;
  createdAt?: string;
  blocks: InfrapadBlock[];
}

// ---- Get document ----

export interface GetDocumentResponse {
  document: InfrapadDocument;
}

export function getDocument(docId: string): Promise<GetDocumentResponse> {
  return infrapadFetch(`/v1/documents/${encodeURIComponent(docId)}`);
}

// ---- List documents ----

export interface ListDocumentsResponse {
  documents: InfrapadDocument[];
}

export function listDocuments(): Promise<ListDocumentsResponse> {
  return infrapadFetch("/v1/documents");
}

// ---- Block history ----

export interface ListBlockHistoryResponse {
  blocks: InfrapadBlock[];
}

export function listBlockHistory(
  docId: string,
  blockNumber: number,
): Promise<ListBlockHistoryResponse> {
  return infrapadFetch(
    `/v1/documents/${encodeURIComponent(docId)}/blocks/${blockNumber}/history`,
  );
}
