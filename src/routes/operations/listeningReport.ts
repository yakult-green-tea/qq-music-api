import { listeningReportResult } from '../../services/recommend/listeningReport';
import { rawQuery, requiredSession } from './requestValues';
import type { OperationHandler } from './types';

// 本人的听歌报告：range 必填，date 可选。和 /user/listening-rank（歌曲排行）分开。
export const getListeningReport: OperationHandler = async (request) =>
  listeningReportResult(await requiredSession(request), {
    range: rawQuery(request, 'range'),
    date: rawQuery(request, 'date'),
  });
