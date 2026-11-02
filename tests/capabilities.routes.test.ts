import request from 'supertest';
import app from '../src/app';
import { apiExplorerMetadata } from '../src/config/apiExplorer';
import { handleRequest, type QqQrRelay, type ServerlessEnv } from '../src/serverless';

// Public feature names follow provider interfaces; values describe implemented backend methods.
const expectedFeatures = (node: boolean) => ({
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
  playback: { getSongDetail: true, getAudioSource: true, getReplacement: false, preview: true },
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

const relay: QqQrRelay = {
  open: jest.fn(async () => {}),
  image: jest.fn(async () => ''),
  poll: jest.fn(async () => []),
  close: jest.fn(async () => {}),
};

const variants = [
  {
    name: 'node',
    node: true,
    env: {},
    relay: undefined,
    channels: ['qq', 'wechat', 'qqmusic'],
    sessionMode: 'stored',
    configured: true,
  },
  {
    name: 'serverless',
    node: false,
    env: { QQ_SESSION_SECRET: 'fixture-secret' },
    relay: undefined,
    channels: ['qq', 'wechat'],
    sessionMode: 'sealed',
    configured: true,
  },
  {
    name: 'serverless with relay',
    node: false,
    env: { QQ_SESSION_SECRET: 'fixture-secret' },
    relay,
    channels: ['qq', 'wechat', 'qqmusic'],
    sessionMode: 'sealed',
    configured: true,
  },
  {
    name: 'unconfigured serverless',
    node: false,
    env: {},
    relay: undefined,
    channels: ['qq', 'wechat'],
    sessionMode: 'sealed',
    configured: false,
  },
  {
    name: 'serverless with the HTTP mobile QQ login turned off',
    node: false,
    env: { QQ_SESSION_SECRET: 'fixture-secret', QQ_PTLOGIN_HTTP_ENABLED: '0' },
    relay: undefined,
    channels: ['wechat'],
    sessionMode: 'sealed',
    configured: true,
  },
  {
    name: 'serverless with a relay and the HTTP login turned off',
    node: false,
    env: { QQ_SESSION_SECRET: 'fixture-secret', QQ_PTLOGIN_HTTP_ENABLED: '0' },
    relay,
    channels: ['qq', 'wechat', 'qqmusic'],
    sessionMode: 'sealed',
    configured: true,
  },
  {
    name: 'serverless with previous secret only',
    node: false,
    env: { QQ_SESSION_SECRET_PREVIOUS: 'fixture-old-secret' },
    relay,
    channels: ['qq', 'wechat', 'qqmusic'],
    sessionMode: 'sealed',
    configured: false,
  },
] as const;

describe.each(variants)('backend capability declaration: $name', (variant) => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest
      .spyOn(global, 'fetch')
      .mockRejectedValue(new Error('Capability lookup must not contact upstream'));
  });
  afterEach(() => jest.restoreAllMocks());

  it.each([
    '/login/channels',
    '/login/channels/',
  ])('declares the exact compatible shape at %s without login', async (path) => {
    const response = variant.node
      ? await request(app.callback()).get(path)
      : await handleRequest(
          new Request(`https://fixture.invalid${path}`),
          variant.env as ServerlessEnv,
          { qqRelay: variant.relay },
        );
    const body = variant.node
      ? (response as request.Response).body
      : await (response as Response).json();
    expect(response.status).toBe(200);
    expect(body).toEqual({
      code: 200,
      data: {
        channels: variant.channels,
        sessionMode: variant.sessionMode,
        configured: variant.configured,
        features: expectedFeatures(variant.node),
      },
    });
    expect(global.fetch).not.toHaveBeenCalled();
    expect(relay.open).not.toHaveBeenCalled();
    expect(relay.poll).not.toHaveBeenCalled();
  });
});

it('includes the capability endpoint in the local Explorer', () => {
  expect(apiExplorerMetadata.endpoints).toContainEqual(
    expect.objectContaining({ method: 'GET', routePath: '/login/channels', category: 'Login' }),
  );
});
