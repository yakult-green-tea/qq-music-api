import { normalizeQqFailure, QqApiError } from '../../protocol/errors';
import { dictionaryOf, isDictionary } from '../../util/values';
import type { AuthSession } from '../auth/qrLogin';
import { failureResult, type NewRouteResult, okResult } from './newRouteResult';
import { createSessionMusicuClient } from './sessionMusicu';

// 客户端首页 feed 的第 1 页。续页组合实测回 500020，所以只给一屏、`more` 恒为 false。
// 只收歌曲卡（type 200，subtype 0 或 201）和歌单卡（500/3003/513）；节目、电台、运营入口、
// 动态日推卡（510）和没验证过的私荐歌单卡（500/10014/0）都不收。歌曲卡只有数字 songid，
// 用 CgiGetTrackInfo 一次 20 首补全；补不到的那首略过，一张都不剩的架子不出。

const TRACK_IDS_A_CALL = 20;
// 实测可用的精简请求：不送电量、蓝牙、最近播放这些手机环境。
const FEED_EXT = { has_login: '1', phone_language: 'zh-TW', client_time_zone: 'Asia/Taipei' };

const positiveIdOf = (value: unknown): number | undefined => {
  const number = typeof value === 'string' && /^[1-9]\d{0,15}$/.test(value) ? Number(value) : value;
  return typeof number === 'number' && Number.isSafeInteger(number) && number > 0
    ? number
    : undefined;
};
const textOf = (value: unknown): string => (typeof value === 'string' ? value : '');

type FeedCard =
  | { type: 'song'; id: number }
  | { type: 'playlist'; playlist: { id: number; title: string; subtitle: string; cover: string } };

const cardOf = (raw: unknown): FeedCard | null => {
  const card = dictionaryOf(raw);
  const id = positiveIdOf(card.id);
  if (id === undefined) return null;
  if (card.type === 200) return { type: 'song', id };
  if (card.type === 500 && card.jumptype === 3003 && card.subtype === 513)
    return {
      type: 'playlist',
      playlist: {
        id,
        title: textOf(card.title),
        subtitle: textOf(card.subtitle),
        cover: textOf(card.cover),
      },
    };
  return null;
};

export const recommendFeedResult = async (session: AuthSession | null): Promise<NewRouteResult> => {
  try {
    if (!session) throw new QqApiError('auth-missing');
    const client = createSessionMusicuClient(session, { maxRetries: 0 });
    const data = dictionaryOf(
      await client.execute({
        module: 'music.recommend.RecommendFeed',
        method: 'get_recommend_feed',
        param: {
          page: 1,
          direction: 0,
          s_num: 0,
          client_time: Math.floor(Date.now() / 1000),
          v_cache: [],
          ext: FEED_EXT,
        },
        readOnly: true,
        operation: 'recommend.feed',
      }),
    );
    if (!Number.isSafeInteger(data.retcode)) throw new QqApiError('invalid-response');
    if (data.retcode !== 0)
      throw normalizeQqFailure({ source: 'business', upstreamCode: data.retcode as number });
    if (!Array.isArray(data.v_shelf)) throw new QqApiError('invalid-response');

    const shelves = data.v_shelf.filter(isDictionary).map((shelf) => ({
      id: String(shelf.id ?? ''),
      titleTemplate: textOf(shelf.title_template),
      titleContent: textOf(shelf.title_content),
      cards: (Array.isArray(shelf.v_niche) ? shelf.v_niche : [])
        .flatMap((niche) => {
          const cards = dictionaryOf(niche).v_card;
          return Array.isArray(cards) ? cards : [];
        })
        .map(cardOf)
        .filter((card): card is FeedCard => card !== null),
    }));

    // 同一首只问一次，按出现的顺序。
    const songIds = [
      ...new Set(
        shelves.flatMap((shelf) =>
          shelf.cards.flatMap((card) => (card.type === 'song' ? [card.id] : [])),
        ),
      ),
    ];
    const tracks = new Map<number, Record<string, unknown>>();
    if (songIds.length) {
      const chunks: number[][] = [];
      for (let from = 0; from < songIds.length; from += TRACK_IDS_A_CALL)
        chunks.push(songIds.slice(from, from + TRACK_IDS_A_CALL));
      const replies = await client.executeBatch(
        chunks.map((ids) => ({
          module: 'music.trackInfo.UniformRuleCtrl',
          method: 'CgiGetTrackInfo',
          param: { ids, types: ids.map(() => 1) },
          readOnly: true,
          operation: 'recommend.feed-tracks',
        })),
      );
      for (const reply of replies) {
        if (!reply.ok) throw reply.error;
        const list = dictionaryOf(reply.data).tracks;
        for (const track of Array.isArray(list) ? list : []) {
          const id = isDictionary(track) ? positiveIdOf(track.id) : undefined;
          if (id !== undefined && typeof track.mid === 'string' && track.mid) tracks.set(id, track);
        }
      }
    }

    const readable = shelves
      .map(({ cards, ...shelf }) => ({
        ...shelf,
        // 一架里同一首、同一张歌单只出一次。
        items: [
          ...new Map(
            cards.flatMap((card): [string, Record<string, unknown>][] => {
              if (card.type === 'playlist')
                return [
                  [`playlist:${card.playlist.id}`, { type: 'playlist', playlist: card.playlist }],
                ];
              const song = tracks.get(card.id);
              return song ? [[`song:${card.id}`, { type: 'song', song }]] : [];
            }),
          ).values(),
        ],
      }))
      .filter((shelf) => shelf.items.length > 0);
    if (!readable.length) throw new QqApiError('not-found');
    return okResult({ page: 1, more: false, shelves: readable });
  } catch (error) {
    return failureResult('get-recommend-feed', error);
  }
};
