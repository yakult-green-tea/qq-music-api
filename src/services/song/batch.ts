import { WEB_ANONYMOUS_COMM } from '../../protocol/clientProfiles';
import { QqApiError, toNewRouteErrorResponse } from '../../protocol/errors';
import { createMusicuClient } from '../../protocol/musicu';
import { createFetchTransport } from '../../transport/fetch';
import { anonymousResult, integerOf, objectOf } from '../catalog/anonymous';
import { okResult } from '../recommend/newRouteResult';

/** 每首一个 RPC，同一匿名 HTTP 批次；不去重、不重排、不自动重试。 */
export const songBatchResult = (raw: unknown) =>
  anonymousResult('get-song-batch', async () => {
    const source =
      raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
    if (!Array.isArray(source.songs) || source.songs.length < 1 || source.songs.length > 20)
      throw new QqApiError('input');
    const songs = source.songs.map((entry) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry))
        throw new QqApiError('input');
      const item = entry as Record<string, unknown>;
      if (typeof item.mid !== 'string' || !/^[A-Za-z0-9]{1,64}$/.test(item.mid))
        throw new QqApiError('input');
      const id = item.id === undefined ? '' : String(integerOf(item.id, undefined, 1));
      return { mid: item.mid, id };
    });
    const client = createMusicuClient({
      http: createFetchTransport(),
      comm: WEB_ANONYMOUS_COMM,
      maxRetries: 0,
    });
    const replies = await client.executeBatch(
      songs.map((song) => ({
        module: 'music.pf_song_detail_svr',
        method: 'get_song_detail_yqq',
        param: { song_type: 0, song_mid: song.mid, song_id: song.id },
        readOnly: true,
        operation: 'song.batch',
      })),
    );
    // 在 RPC 成功后解析，保留“成功但为空”与“格式损坏”的区别。
    const parsed = replies.map((reply, index) => {
      if (!reply.ok) return reply;
      try {
        const data = objectOf(reply.data);
        if (data.track_info === null) throw new QqApiError('not-found');
        const track = objectOf(data.track_info);
        if (
          track.mid !== songs[index].mid ||
          !Number.isSafeInteger(track.id) ||
          Number(track.id) <= 0
        )
          throw new QqApiError('invalid-response');
        return {
          ok: true as const,
          data: { song: track, info: data.info === undefined ? {} : objectOf(data.info) },
        };
      } catch (error) {
        return {
          ok: false as const,
          error: error instanceof QqApiError ? error : new QqApiError('invalid-response'),
        };
      }
    });
    const results = parsed.map((reply, index) =>
      reply.ok
        ? { index, code: 200, ...reply.data }
        : { index, ...toNewRouteErrorResponse(reply.error).body },
    );
    const successes = results.filter((result) => result.code === 200).length;
    if (!successes) {
      const failed = parsed.filter((reply) => !reply.ok);
      const failure =
        failed.find((reply) => !reply.ok && reply.error.kind !== 'not-found') ?? failed[0];
      if (failure && !failure.ok) throw failure.error;
      throw new QqApiError('invalid-response');
    }
    return okResult({ results, partial: successes !== results.length });
  });
