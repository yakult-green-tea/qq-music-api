import { QqApiError } from '../../protocol/errors';
import type { MusicuDescriptor } from '../../protocol/musicu';
import { type Dictionary, isDictionary } from '../../util/values';
import type { AuthSession } from '../auth/qrLogin';
import { failureResult, type NewRouteResult, okResult } from '../recommend/newRouteResult';
import { createSessionMusicuClient, type SessionMusicuOptions } from '../recommend/sessionMusicu';

// src/services/user/soundPower.ts
//
// `/user/sound-power`：本人的音乐力等级。Node 与 serverless 共用。
// 实测（2026-11，带会话）：`music.soundPower.SoundPowerSvr.QueryLevelDetailPage {}` 回 `powerInfo`
// （level、value、name、icon、currentValue、nextValue、reachMaxLevel…）、`medalNum`、`todayLT` 等。
// `todayLT` 等于听歌报告当天的听歌秒数；`reachMaxLevel` 只见过 0／1，是「是否到最高级」的旗标。
// 权益清单、跳转链接、昵称头像不交出。

const countOf = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;

const decodeDictionary = (data: unknown): Dictionary => {
  if (!isDictionary(data)) throw new QqApiError('invalid-response');
  return data;
};

const LEVEL_PAGE: MusicuDescriptor<Dictionary> = {
  module: 'music.soundPower.SoundPowerSvr',
  method: 'QueryLevelDetailPage',
  param: {},
  readOnly: true,
  operation: 'user.sound-power',
  decode: decodeDictionary,
};

/** 没有等级资料回 502；读不出来的数字省略，`reachMaxLevel` 只认 0／1。 */
export const soundPowerResult = async (
  session: AuthSession | null,
  options: SessionMusicuOptions = {},
): Promise<NewRouteResult> => {
  try {
    if (!session) throw new QqApiError('auth-missing');
    const data = await createSessionMusicuClient(session, options).execute(LEVEL_PAGE);
    const info = data.powerInfo;
    if (!isDictionary(info)) throw new QqApiError('invalid-response');
    const level = countOf(info.level);
    if (level === undefined) throw new QqApiError('invalid-response');
    const numbers: Array<[string, number | boolean | undefined]> = [
      ['value', countOf(info.value)],
      ['currentValue', countOf(info.currentValue)],
      ['nextValue', countOf(info.nextValue)],
      [
        'reachedMaxLevel',
        info.reachMaxLevel === 1 ? true : info.reachMaxLevel === 0 ? false : undefined,
      ],
      ['medalCount', countOf(data.medalNum)],
      ['todayListenSeconds', countOf(data.todayLT)],
    ];
    return okResult({
      level,
      name: typeof info.name === 'string' ? info.name : '',
      icon: typeof info.icon === 'string' ? info.icon : '',
      ...Object.fromEntries(numbers.filter(([, value]) => value !== undefined)),
    });
  } catch (error) {
    return failureResult('get-sound-power', error);
  }
};
