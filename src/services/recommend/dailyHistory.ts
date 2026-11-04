import { QqApiError } from '../../protocol/errors';
import { isDictionary } from '../../util/values';
import type { AuthSession } from '../auth/qrLogin';
import { failureResult, okResult } from './newRouteResult';
import { createSessionMusicuClient } from './sessionMusicu';

// 日推历史的日期与曲目读取；不补日期、不解释 bSet，也不提供历史收藏写入。

const calendarDate = (value: unknown): string => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith('0000'))
    throw new QqApiError('input');
  const date = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value)
    throw new QqApiError('input');
  return value;
};

const readHistory = async (session: AuthSession, spec: Record<string, unknown>) => {
  const data = await createSessionMusicuClient(session, { maxRetries: 0 }).execute({
    module: 'music.srfDissInfo.aiHistory',
    method: 'get_aiHistoryinfo',
    param: { tid: 0, dirid: 202, spec },
    readOnly: true,
    operation: 'recommend.daily-history',
  });
  if (!isDictionary(data) || (data.code !== undefined && data.code !== 0))
    throw new QqApiError('invalid-response');
  return data;
};

export const dailyHistoryDatesResult = async (session: AuthSession | null) => {
  try {
    if (!session) throw new QqApiError('auth-missing');
    const data = await readHistory(session, {});
    if (!Array.isArray(data.items)) throw new QqApiError('invalid-response');
    const dates: string[] = [];
    for (const item of data.items) {
      if (!isDictionary(item) || ![item.year, item.month, item.day].every(Number.isSafeInteger))
        throw new QqApiError('invalid-response');
      const value = `${String(item.year).padStart(4, '0')}-${String(item.month).padStart(2, '0')}-${String(item.day).padStart(2, '0')}`;
      try {
        calendarDate(value);
      } catch {
        throw new QqApiError('invalid-response');
      }
      if (!dates.includes(value)) dates.push(value);
    }
    if (!dates.length) throw new QqApiError('not-found');
    return okResult({ dates });
  } catch (error) {
    return failureResult('get-daily-history', error);
  }
};

export const dailyHistorySongsResult = async (session: AuthSession | null, rawDate: unknown) => {
  try {
    if (!session) throw new QqApiError('auth-missing');
    const date = calendarDate(rawDate);
    const [year, month, day] = date.split('-').map(Number);
    // 沿用已观察的查询参数；bSet 的含义尚未确认，不能将它解释为收藏状态。
    const data = await readHistory(session, { year, month, day, bSet: true, optime: 0 });
    if (!Array.isArray(data.songlist)) throw new QqApiError('invalid-response');
    const songs = data.songlist.map((entry: unknown) => {
      if (!isDictionary(entry) || !isDictionary(entry.track))
        throw new QqApiError('invalid-response');
      if (typeof entry.track.mid !== 'string' || !entry.track.mid)
        throw new QqApiError('invalid-response');
      return entry.track;
    });
    if (!songs.length) throw new QqApiError('not-found');
    return okResult({ date, songs });
  } catch (error) {
    return failureResult('get-daily-history', error);
  }
};
