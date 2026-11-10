import { WEB_ANONYMOUS_COMM_WITH_UIN } from '../../protocol/clientProfiles';
import { QqApiError } from '../../protocol/errors';
import { createMusicuClient } from '../../protocol/musicu';
import { createFetchTransport } from '../../transport/fetch';
import { isDictionary } from '../../util/values';
import { failureResult, okResult } from '../recommend/newRouteResult';
import { songIdOf } from './readValues';

export const songVersionsResult = async (raw: { id?: unknown; mid?: unknown }) => {
  try {
    if ((raw.id === undefined) === (raw.mid === undefined)) throw new QqApiError('input');
    let param: Record<string, unknown>;
    if (raw.id !== undefined) param = { songid: songIdOf(raw.id) };
    else {
      const mid = typeof raw.mid === 'string' ? raw.mid.trim() : '';
      if (!/^[A-Za-z0-9]{1,64}$/.test(mid)) throw new QqApiError('input');
      param = { songmid: mid };
    }
    const client = createMusicuClient({
      http: createFetchTransport(),
      comm: WEB_ANONYMOUS_COMM_WITH_UIN,
      maxRetries: 0,
    });
    const data = await client.execute({
      module: 'music.musichallSong.OtherVersionServer',
      method: 'GetOtherVersionSongs',
      param,
      readOnly: true,
    });
    if (!isDictionary(data)) throw new QqApiError('invalid-response');
    const songs = data.versionList ?? [];
    if (!Array.isArray(songs) || !songs.every(isDictionary))
      throw new QqApiError('invalid-response');
    if (!songs.length) throw new QqApiError('not-found');
    return okResult({ songs });
  } catch (error) {
    return failureResult('get-song-versions', error);
  }
};
