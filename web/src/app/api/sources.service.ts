import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';

import { API, params } from './http-context';
import { PipelineRunOut, SourceIn, SourceOut, SourcePatch } from './models';

@Injectable({ providedIn: 'root' })
export class SourcesApi {
  private readonly http = inject(HttpClient);

  list(ws: string, collectionId: string): Observable<SourceOut[]> {
    return this.http.get<SourceOut[]>(`${API}/w/${ws}/collections/${collectionId}/sources`);
  }

  create(ws: string, collectionId: string, body: SourceIn): Observable<SourceOut> {
    return this.http.post<SourceOut>(`${API}/w/${ws}/collections/${collectionId}/sources`, body);
  }

  update(ws: string, id: string, body: SourcePatch): Observable<SourceOut> {
    return this.http.patch<SourceOut>(`${API}/w/${ws}/sources/${id}`, body);
  }

  sync(ws: string, id: string): Observable<PipelineRunOut> {
    return this.http.post<PipelineRunOut>(`${API}/w/${ws}/sources/${id}/sync`, null);
  }

  delete(ws: string, id: string, deleteDocuments: boolean): Observable<void> {
    return this.http.delete<void>(`${API}/w/${ws}/sources/${id}`, {
      params: params({ delete_documents: deleteDocuments }),
    });
  }
}
