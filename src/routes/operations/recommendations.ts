import {
  guessYouLikeModeTracksResult,
  guessYouLikeResult,
} from '../../services/recommend/guessYouLike';
import { personalFmResult } from '../../services/recommend/personalFm';
import { radarPageOf, radarResult } from '../../services/recommend/radar';
import { radioListResult, radioTracksResult } from '../../services/recommend/radio';
import {
  recommendPlaylistsLimitOf,
  recommendPlaylistsResult,
} from '../../services/recommend/recommendPlaylists';
import { relatedPlaylistsResult, similarSongsResult } from '../../services/recommend/songRelations';
import { optionalSession, rawQuery, requiredSession } from './requestValues';
import type { OperationHandler } from './types';

// src/routes/operations/recommendations.ts
//
// 按账号推荐的内容。猜你喜欢、相似歌曲、电台要登录；推荐歌单和刷歌模式有会话就按账号推荐，
// 没有就匿名读。

export const getGuessYouLike: OperationHandler = async (request) =>
  guessYouLikeResult(await requiredSession(request));

// 按模式目录的 poolId 取一批；不写账号的模式设置。
export const getGuessYouLikeModeTracks: OperationHandler = async (request) =>
  guessYouLikeModeTracksResult(await requiredSession(request), request.query('pool'));

export const getPersonalFm: OperationHandler = async (request) =>
  personalFmResult(await requiredSession(request), rawQuery(request, 'page'));

export const getRecommendPlaylists: OperationHandler = async (request) =>
  recommendPlaylistsResult(
    await optionalSession(request),
    recommendPlaylistsLimitOf(rawQuery(request, 'limit')),
  );

export const getRecommendRadar: OperationHandler = async (request) =>
  radarResult(await optionalSession(request), radarPageOf(rawQuery(request, 'page')));

// 相似歌曲、包含这首歌的歌单：匿名时上游只给空清单，所以要登录。
export const getSimilarSongs: OperationHandler = async (request) =>
  similarSongsResult(await requiredSession(request), rawQuery(request, 'id'));

export const getRelatedPlaylists: OperationHandler = async (request) =>
  relatedPlaylistsResult(await requiredSession(request), rawQuery(request, 'id'));

export const getRadioList: OperationHandler = async (request) =>
  radioListResult(await requiredSession(request));

export const getRadioTracks: OperationHandler = async (request) =>
  radioTracksResult(await requiredSession(request), rawQuery(request, 'id'));
