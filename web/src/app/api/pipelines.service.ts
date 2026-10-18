import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';

import { API, params, silent } from './http-context';
import { RunDetailOut, RunPage, RunQuery, TaskLogOut } from './models';

@Injectable({ providedIn: 'root' })
export class PipelinesApi {
  private readonly http = inject(HttpClient);

  runs(ws: string, q: RunQuery = {}, background = false): Observable<RunPage> {
    return this.http.get<RunPage>(`${API}/w/${ws}/pipelines/runs`, {
      params: params({ ...q }),
      context: background ? silent() : undefined,
    });
  }

  run(ws: string, runId: string, background = false): Observable<RunDetailOut> {
    return this.http.get<RunDetailOut>(`${API}/w/${ws}/pipelines/runs/${runId}`, {
      context: background ? silent() : undefined,
    });
  }

  taskLog(ws: string, runId: string, taskId: string, tryNumber = 1): Observable<TaskLogOut> {
    return this.http.get<TaskLogOut>(
      `${API}/w/${ws}/pipelines/runs/${runId}/tasks/${encodeURIComponent(taskId)}/log`,
      { params: params({ try_number: tryNumber }) },
    );
  }
}
