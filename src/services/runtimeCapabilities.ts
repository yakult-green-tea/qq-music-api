import type { RuntimeCapabilities } from './auth/qrLogin';

export type BackendRuntime = 'node' | 'serverless';

// These flags describe implemented backend methods, independent of login or upstream availability.
// Keep client-only predicates and diagnostics out of this declaration.
const featuresFor = () => ({
  user: { getVip: true },
  playlistManagement: { createPlaylist: true, renamePlaylist: true, deletePlaylist: true },
  auth: {
    getLoginStatus: true,
    logout: true,
    getQrKey: true,
    createQr: true,
    checkQr: true,
    cancelQr: true,
  },
  library: {
    getUserPlaylists: true,
    getUserAlbums: true,
    getLikedSongIds: true,
    getLikedSongs: true,
    getCloudCollection: true,
  },
  catalog: {
    getPlaylistTracks: true,
    getPlaylistDetail: false,
    getAlbumDetail: true,
    getAlbumTracks: true,
    getArtistDetail: true,
    getArtistSongs: true,
    getArtistAlbums: true,
    getCloudTracks: true,
    getSubscriptionStatus: true,
  },
  playback: {
    getSongDetail: true,
    getAudioSource: true,
    getReplacement: false,
    preview: true,
  },
  search: {
    searchSongs: true,
    searchAlbums: true,
    searchPlaylists: true,
    searchArtists: true,
    getHotSearches: true,
    getSearchSuggestions: true,
  },
  lyrics: { getLyrics: true, getChorusRanges: false },
  recommendations: {
    getPersonalFm: true,
    getDailySongs: true,
    getRecommendedCollections: true,
    getHistoryEntries: false,
    getHistoryDates: false,
    getHistorySongs: false,
    dislikeSong: false,
    // 取歌路由未实现模式参数；猜你喜欢的动态模式也不等于私人 FM 模式。
    personalFmModes: false,
    getPlaylistCategories: true,
    getCategoryPlaylists: true,
    getNewSongs: true,
    getToplists: true,
    getToplistSongs: true,
    getNewAlbums: true,
    getRadarSongs: true,
    getSimilarSongs: true,
    getRelatedPlaylists: true,
  },
  radio: { getRadioList: true, getRadioTracks: true },
  singers: {
    getSingerList: true,
    getSingerDetail: true,
    getSingerHomepage: true,
    getSimilarSingers: true,
    getSingerSongs: true,
    getSingerMvs: true,
  },
  comments: { getHotComments: true, getNewComments: true, getCommentCount: true },
  mvs: { getMvList: true, getMvDetail: true, getMvUrl: true, getSongMvs: true },
  songs: { getSongLabels: true },
  mutations: {
    updatePlaylistTracks: true,
    likeSong: true,
    subscribePlaylist: true,
    subscribeAlbum: true,
  },
  playbackReports: { reportPlayback: false },
});

export type BackendFeatures = ReturnType<typeof featuresFor>;

export interface BackendCapabilityDeclaration extends RuntimeCapabilities {
  readonly configured: boolean;
  readonly features: BackendFeatures;
}

/** Shared wire shape; existing channel order, session mode and configuration meaning stay intact. */
export const describeRuntimeCapabilities = (
  // 两个运行时现在声明同一组方法；参数保留，以后哪个方法只在一边实现时再按它区分。
  _runtime: BackendRuntime,
  capabilities: RuntimeCapabilities,
  configured: boolean,
): BackendCapabilityDeclaration => ({
  channels: [...capabilities.channels],
  sessionMode: capabilities.sessionMode,
  configured,
  features: featuresFor(),
});
