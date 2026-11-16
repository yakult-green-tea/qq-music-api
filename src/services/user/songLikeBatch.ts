import { QqApiError } from '../../protocol/errors';
import type { MusicuDescriptor } from '../../protocol/musicu';
import { dictionaryOf, isDictionary } from '../../util/values';
import type { AuthSession } from '../auth/qrLogin';
import { failureResult, type NewRouteResult, okResult } from '../recommend/newRouteResult';
import { createSessionMusicuClient, type SessionMusicuOptions } from '../recommend/sessionMusicu';
import { exactObjectOf, positiveIntegerOf } from './writeInput';

// src/services/user/songLikeBatch.ts
//
// `POST /user/song/like/batch`：一次把 1–100 首歌加进或移出「我喜欢」。`/user/song/like`（单首）不变。
// 流程照单首红心：先核对歌曲身分（CgiGetTrackInfo，每次 20 首、一次请求送完），再一次读红心状态
// （SongFavRead.IsSongFanByMid，2026-11 实测一次两首都有回答），只把状态不同的歌写一次
// （PlaylistDetailWrite.AddSonglist／DelSonglist，dirId 201），最后读回确认。只收已经验证过的类型 0。
// 写入、读回都只送一次；写了之后的失败一律标 writeAttempted、不可重试，不会自动重写。

const MAX_SONGS = 100;
const TRACK_IDS_A_CALL = 20;

interface SongInput {
  id: number;
  mid: string;
}

const inputOf = (raw: unknown): { songs: SongInput[]; liked: boolean } => {
  const input = exactObjectOf(raw, ['songs', 'liked']);
  if (typeof input.liked !== 'boolean') throw new QqApiError('input');
  if (!Array.isArray(input.songs) || input.songs.length < 1 || input.songs.length > MAX_SONGS)
    throw new QqApiError('input');
  const songs = input.songs.map((value) => {
    const song = exactObjectOf(value, ['id', 'mid', 'type']);
    if (
      typeof song.id !== 'number' ||
      positiveIntegerOf(song.id) === undefined ||
      typeof song.mid !== 'string' ||
      !/^[A-Za-z0-9]{1,64}$/.test(song.mid) ||
      song.type !== 0
    )
      throw new QqApiError('input');
    return { id: song.id, mid: song.mid };
  });
  if (
    new Set(songs.map((song) => song.id)).size !== songs.length ||
    new Set(songs.map((song) => song.mid)).size !== songs.length
  )
    throw new QqApiError('input');
  return { songs, liked: input.liked };
};

const fanStateOf = (
  mids: string[],
  allowMissing = false,
): MusicuDescriptor<Map<string, boolean>> => ({
  module: 'music.musicasset.SongFavRead',
  method: 'IsSongFanByMid',
  param: { v_songMid: mids },
  readOnly: true,
  operation: 'subscription.song-status',
  decode: (data) => {
    if (!isDictionary(data) || !isDictionary(data.m_fan)) throw new QqApiError('invalid-response');
    const fan = data.m_fan;
    const state = new Map<string, boolean>();
    for (const mid of mids) {
      if (allowMissing && fan[mid] === undefined) continue;
      if (typeof fan[mid] !== 'boolean') throw new QqApiError('invalid-response');
      state.set(mid, fan[mid] as boolean);
    }
    return state;
  },
});

interface WriteState {
  attempted: boolean;
  accepted: boolean;
}

const mark = (result: NewRouteResult, state: WriteState): NewRouteResult => {
  if (!state.attempted) return result;
  return {
    ...result,
    body: {
      ...dictionaryOf(result.body),
      retryable: false,
      writeAttempted: true,
      accepted: state.accepted,
      verified: false,
      verification: 'unconfirmed',
    },
  };
};

export const songLikeBatchResult = async (
  session: AuthSession | null,
  raw: unknown,
  options: SessionMusicuOptions = {},
): Promise<NewRouteResult> => {
  const state: WriteState = { attempted: false, accepted: false };
  try {
    if (!session) throw new QqApiError('auth-missing');
    const { songs, liked } = inputOf(raw);
    const client = createSessionMusicuClient(session, { ...options, maxRetries: 0 });

    // 身分核对：每首都要按 id 读到同一个 mid，有一首对不上就整批不写。
    const chunks: number[][] = [];
    for (let from = 0; from < songs.length; from += TRACK_IDS_A_CALL)
      chunks.push(songs.slice(from, from + TRACK_IDS_A_CALL).map((song) => song.id));
    const replies = await client.executeBatch(
      chunks.map((ids) => ({
        module: 'music.trackInfo.UniformRuleCtrl',
        method: 'CgiGetTrackInfo',
        param: { ids, types: ids.map(() => 1) },
        readOnly: true,
        operation: 'song.identity-check',
      })),
    );
    const midById = new Map<number, string>();
    for (const reply of replies) {
      if (!reply.ok) throw reply.error;
      const list = dictionaryOf(reply.data).tracks;
      for (const track of Array.isArray(list) ? list : []) {
        const item = dictionaryOf(track);
        const id = positiveIntegerOf(item.id);
        if (id !== undefined && typeof item.mid === 'string') midById.set(id, item.mid);
      }
    }
    if (songs.some((song) => midById.get(song.id) !== song.mid)) throw new QqApiError('input');

    const before = await client.execute(fanStateOf(songs.map((song) => song.mid)));
    const pending = songs.filter((song) => before.get(song.mid) !== liked);
    if (!pending.length)
      return okResult({
        liked,
        results: songs.map((song) => ({ id: song.id, status: 'unchanged' })),
        writeAttempted: false,
        verified: true,
      });

    state.attempted = true;
    await client.execute({
      module: 'music.musicasset.PlaylistDetailWrite',
      method: liked ? 'AddSonglist' : 'DelSonglist',
      param: { dirId: 201, v_songInfo: pending.map((song) => ({ songId: song.id, songType: 0 })) },
      readOnly: false,
      operation: liked ? 'song.like' : 'song.unlike',
      decode: (data) => {
        if (!isDictionary(data) || data.retCode !== 0 || !isDictionary(data.result))
          throw new QqApiError('invalid-response');
        const result = data.result;
        if (
          !(result.dirId === 201 && positiveIntegerOf(result.tid) !== undefined) &&
          !(result.dirId === 0 && (result.tid === 0 || result.tid === '0'))
        )
          throw new QqApiError('invalid-response');
        return undefined;
      },
    });
    state.accepted = true;

    const after = await client.execute(
      fanStateOf(
        pending.map((song) => song.mid),
        true,
      ),
    );
    const written = new Set(pending.map((song) => song.mid));
    const results = songs.map((song) => ({
      id: song.id,
      status: !written.has(song.mid)
        ? 'unchanged'
        : after.get(song.mid) === liked
          ? 'changed'
          : 'unconfirmed',
    }));
    if (results.some((result) => result.status === 'unconfirmed')) {
      const failure = failureResult(
        'song-like-batch',
        new QqApiError('upstream-business', {
          errorKey: 'upstream.unknown',
          retryable: false,
        }),
      );
      const marked = mark(failure, state);
      return { ...marked, body: { ...dictionaryOf(marked.body), liked, results } };
    }
    return okResult({
      liked,
      results,
      writeAttempted: true,
      accepted: true,
      verified: results.every((result) => result.status !== 'unconfirmed'),
    });
  } catch (error) {
    // 限流也不能让调用方以为可以马上重送：写了的一律标不可重试。
    const safe =
      state.attempted && error instanceof QqApiError && error.kind === 'rate-limited'
        ? new QqApiError('upstream-business', {
            ...error.toJSON(),
            errorKey: 'upstream.unknown',
            retryable: false,
          })
        : error;
    return mark(failureResult('song-like-batch', safe), state);
  }
};
