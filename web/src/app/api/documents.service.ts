import { HttpClient, HttpEvent } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';

import { API, params, silent } from './http-context';
import { ChunkOut, DocumentOut, DocumentPage, DocumentQuery, PipelineRunOut, UploadResult } from './models';

export const UPLOAD_EXTENSIONS = ['.md', '.markdown', '.txt', '.pdf', '.html', '.htm'] as const;

export function isUploadable(filename: string): boolean {
  const lower = filename.toLowerCase();
  return UPLOAD_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

@Injectable({ providedIn: 'root' })
export class DocumentsApi {
  private readonly http = inject(HttpClient);

  list(ws: string, collectionId: string, q: DocumentQuery = {}, background = false): Observable<DocumentPage> {
    return this.http.get<DocumentPage>(`${API}/w/${ws}/collections/${collectionId}/documents`, {
      params: params({ ...q }),
      context: background ? silent() : undefined,
    });
  }

  /** Multipart upload with progress events (field name `file`). */
  upload(ws: string, collectionId: string, file: File): Observable<HttpEvent<UploadResult>> {
    const form = new FormData();
    form.append('file', file, file.name);
    return this.http.post<UploadResult>(`${API}/w/${ws}/collections/${collectionId}/documents`, form, {
      reportProgress: true,
      observe: 'events',
      context: silent(),
    });
  }

  get(ws: string, id: string): Observable<DocumentOut> {
    return this.http.get<DocumentOut>(`${API}/w/${ws}/documents/${id}`);
  }

  chunks(ws: string, id: string): Observable<ChunkOut[]> {
    return this.http.get<ChunkOut[]>(`${API}/w/${ws}/documents/${id}/chunks`);
  }

  reingest(ws: string, id: string): Observable<PipelineRunOut> {
    return this.http.post<PipelineRunOut>(`${API}/w/${ws}/documents/${id}/reingest`, null);
  }

  delete(ws: string, id: string): Observable<void> {
    return this.http.delete<void>(`${API}/w/${ws}/documents/${id}`);
  }
}
