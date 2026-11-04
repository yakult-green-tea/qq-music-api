import { QqApiError } from '../../protocol/errors';
import { isDictionary } from '../../util/values';
import type { AuthSession } from '../auth/qrLogin';
import { failureResult, okResult } from './newRouteResult';
import { radioIdOf } from './radio';
import { createSessionMusicuClient } from './sessionMusicu';

// 普通官方雷达的选项对应 radio ID；读取和换批不代表保存 RadioConfig 或账号偏好。
const validRadioId = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value !== 99;

export const officialRadioModesResult = async (
  session: AuthSession | null,
  unsupportedQuery: boolean,
) => {
  try {
    if (!session) throw new QqApiError('auth-missing');
    if (unsupportedQuery) throw new QqApiError('input');
    const data = await createSessionMusicuClient(session, { maxRetries: 0 }).execute({
      module: 'music.radio.PfRadioSvr',
      method: 'GetRecRadioList',
      // 手机已观察参数组；API Android comm 与各账号仍待实网验收。
      param: { Offset: 0, PageSize: 2147483647 },
      readOnly: true,
      operation: 'recommend.official-radio',
    });
    if (
      !isDictionary(data) ||
      !Number.isSafeInteger(data.HasMore) ||
      !Array.isArray(data.Radios) ||
      data.Radios.length > 256
    )
      throw new QqApiError('invalid-response');
    const seen = new Set<number>();
    const modes = data.Radios.map((entry: unknown) => {
      if (
        !isDictionary(entry) ||
        !validRadioId(entry.ID) ||
        seen.has(entry.ID) ||
        typeof entry.Title !== 'string' ||
        typeof entry.BgPicUrl !== 'string'
      )
        throw new QqApiError('invalid-response');
      seen.add(entry.ID);
      return { radioId: entry.ID, title: entry.Title, cover: entry.BgPicUrl };
    });
    if (!modes.length) throw new QqApiError('not-found');
    // 只有首屏样本，没有完整遍历或服务器 current selection 的证据。
    return okResult({ selection: 'single', modes, coverage: 'first-page', complete: false });
  } catch (error) {
    return failureResult('get-radio-recommendation-modes', error);
  }
};

export const officialRadioTracksResult = async (
  session: AuthSession | null,
  rawId: unknown,
  unsupportedQuery: boolean,
) => {
  try {
    if (!session) throw new QqApiError('auth-missing');
    const id = typeof rawId === 'string' ? radioIdOf(rawId) : undefined;
    if (unsupportedQuery || id === undefined || id === 99) throw new QqApiError('input');
    const data = await createSessionMusicuClient(session, { maxRetries: 0 }).execute({
      module: 'music.radioProxy.MbTrackRadioSvr',
      method: 'get_radio_track',
      // 只带业务参数，不复制手机设备、播放历史或场景上下文；不接受未验证的 cursor。
      param: { id, num: 5 },
      readOnly: true,
      operation: 'recommend.official-radio',
    });
    if (
      !isDictionary(data) ||
      data.id !== id ||
      typeof data.name !== 'string' ||
      !Array.isArray(data.tracks) ||
      (data.extras != null && !Array.isArray(data.extras))
    )
      throw new QqApiError('invalid-response');
    if (!data.tracks.length) throw new QqApiError('not-found');
    return okResult({
      station: 'official-radio',
      radioId: id,
      title: data.name,
      songs: data.tracks,
      ...(Array.isArray(data.extras) ? { extras: data.extras } : {}),
    });
  } catch (error) {
    return failureResult('get-radio-recommendation-tracks', error);
  }
};
