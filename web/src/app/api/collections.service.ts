import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';

import { API } from './http-context';
import { CollectionIn, CollectionOut, CollectionPatch, PipelineRunOut, SearchIn, SearchOut } from './models';

@Injectable({ providedIn: 'root' })
export class CollectionsApi {
  private readonly http = inject(HttpClient);

  list(ws: string): Observable<CollectionOut[]> {
    return this.http.get<CollectionOut[]>(`${API}/w/${ws}/collections`);
  }

  get(ws: string, id: string): Observable<CollectionOut> {
    return this.http.get<CollectionOut>(`${API}/w/${ws}/collections/${id}`);
  }

  create(ws: string, body: CollectionIn): Observable<CollectionOut> {
    return this.http.post<CollectionOut>(`${API}/w/${ws}/collections`, body);
  }

  update(ws: string, id: string, body: CollectionPatch): Observable<CollectionOut> {
    return this.http.patch<CollectionOut>(`${API}/w/${ws}/collections/${id}`, body);
  }

  delete(ws: string, id: string): Observable<void> {
    return this.http.delete<void>(`${API}/w/${ws}/collections/${id}`);
  }

  reindex(ws: string, id: string): Observable<PipelineRunOut> {
    return this.http.post<PipelineRunOut>(`${API}/w/${ws}/collections/${id}/reindex`, null);
  }

  search(ws: string, body: SearchIn): Observable<SearchOut> {
    return this.http.post<SearchOut>(`${API}/w/${ws}/search`, body);
  }
}
