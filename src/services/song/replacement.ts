import { QqApiError } from '../../protocol/errors';
import { hasKnownUnplayableTraits } from '../../protocol/playbackHints';
import { AuthCredentialRejectedError } from '../../util/authError';
import { dictionaryOf, isDictionary } from '../../util/values';
import type { AuthSession } from '../auth/qrLogin';
import { failureResult, type NewRouteResult, okResult } from '../recommend/newRouteResult';
import { songVersionsResult } from './versions';

// 替代歌曲：原曲拿不到链接、而且命中已验证的不可播规则（地区或会员）时，才从「其他版本」里挑一首。
// 跳过原曲，有这些特征的版本排后面，最多 3 个合成一次取链接；第一个真拿到链接的才算。
// 原因没确认时不找：不能把一次没拿到链接说成这首放不了。

/** 取 128 链接；回 `/getMusicPlay` 同形的 `{ [mid]: { url, restriction? } }`，会话解不开回 null。 */
export type PlayUrlReader = (mids: string[]) => Promise<Record<string, unknown> | null>;

const MAX_CANDIDATES = 3;
const REPLACEABLE_HINTS = ['playback.maybe-region-restricted', 'playback.maybe-membership'];

const midOf = (raw: unknown): string => {
  const mid = typeof raw === 'string' ? raw.trim() : '';
  if (!/^[A-Za-z0-9]{1,64}$/.test(mid)) throw new QqApiError('input');
  return mid;
};
const urlOf = (entry: unknown): string => {
  const url = dictionaryOf(entry).url;
  return typeof url === 'string' ? url : '';
};
const hintOf = (entry: unknown): string | null => {
  const key = dictionaryOf(dictionaryOf(dictionaryOf(entry).restriction).hint).key;
  return typeof key === 'string' ? key : null;
};
const read = async (readPlayUrls: PlayUrlReader, mids: string[]) => {
  const urls = await readPlayUrls(mids);
  if (!urls) throw new QqApiError('auth-missing');
  return urls;
};

export const songReplacementResult = async (
  session: AuthSession | null,
  rawMid: unknown,
  readPlayUrls: PlayUrlReader,
): Promise<NewRouteResult> => {
  try {
    if (!session) throw new QqApiError('auth-missing');
    const mid = midOf(rawMid);
    const originalEntry = (await read(readPlayUrls, [mid]))[mid];
    const playable = urlOf(originalEntry) !== '';
    const hint = playable ? null : hintOf(originalEntry);
    const original = { mid, playable, hint };
    if (playable) return okResult({ original, song: null, reason: 'original-playable' });
    if (!hint || !REPLACEABLE_HINTS.includes(hint))
      return okResult({ original, song: null, reason: 'reason-unconfirmed' });

    const versions = await songVersionsResult({ mid });
    if (versions.status === 422)
      return okResult({ original, song: null, reason: 'no-other-version' });
    if (versions.status !== 200) return versions;
    const candidates = (dictionaryOf(versions.body).songs as unknown[])
      .filter(isDictionary)
      .filter(
        (song) =>
          typeof song.mid === 'string' && /^[A-Za-z0-9]{1,64}$/.test(song.mid) && song.mid !== mid,
      )
      .sort((a, b) => Number(hasKnownUnplayableTraits(a)) - Number(hasKnownUnplayableTraits(b)))
      .slice(0, MAX_CANDIDATES);
    if (!candidates.length)
      return okResult({ original, song: null, reason: 'no-playable-version' });

    const urls = await read(
      readPlayUrls,
      candidates.map((song) => song.mid as string),
    );
    const song = candidates.find((candidate) => urlOf(urls[candidate.mid as string]) !== '');
    if (!song) return okResult({ original, song: null, reason: 'no-playable-version' });
    const subtitle = typeof song.subtitle === 'string' ? song.subtitle.trim() : '';
    return okResult({ original, song, ...(subtitle ? { label: subtitle } : {}) });
  } catch (error) {
    return failureResult(
      'get-song-replacement',
      error instanceof AuthCredentialRejectedError ? new QqApiError('auth-missing') : error,
    );
  }
};
