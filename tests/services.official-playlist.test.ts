import {
  albumCoverUrlOf,
  firstSongAlbumCoverUrl,
  isOfficialPlaylistEntry,
  OFFICIAL_PLAYLIST_DIR_TYPES,
  toSongListDetailResponse,
} from '../src/services/songLists/officialPlaylist';
import aiDissInfo211192 from './fixtures/official-playlists/ai-dissinfo-211192.json';
import createdPlaylists from './fixtures/official-playlists/user-playlist-created.json';
import favoritePlaylists from './fixtures/official-playlists/user-playlist-favorites.json';

// fixture 按 2026-10-09 实测的上游回应结构整理，账号信息、歌单名、歌曲与 id 都是假数据：收藏里有
// 每日30首（dirType 2）、歌手漫游与百万收藏（dirType 3），以及两张普通收藏（dirType 0）。

const COVER_211192 =
  'https://y.gtimg.cn/music/photo_new/T002R300x300M000000FixAlbum001.jpg?max_age=2592000';

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const dissData = () => clone(aiDissInfo211192.req_0.data) as Record<string, any>;

describe('isOfficialPlaylistEntry', () => {
  it('只把收藏条目里 dirType 为 2（每日30首）或 3（算法歌单）的认作官方歌单', () => {
    const verdicts = favoritePlaylists.v_list.map((entry) => [
      entry.name,
      isOfficialPlaylistEntry(entry),
    ]);

    expect(verdicts).toEqual([
      ['测试用户的每日30首', true],
      ['歌手漫游 | 专享歌手Mix', true],
      ['百万收藏', true],
      ['收藏歌单甲', false],
      ['收藏歌单乙', false],
    ]);
    expect([...OFFICIAL_PLAYLIST_DIR_TYPES]).toEqual([2, 3]);
  });

  it('自建歌单的条目没有 dirType，一律不是官方歌单', () => {
    for (const entry of createdPlaylists.v_playlist) {
      expect(isOfficialPlaylistEntry(entry)).toBe(false);
    }
  });

  it('未知或缺失的 dirType 一律当普通歌单，不做猜测', () => {
    for (const dirType of [0, 1, 4, -3, null, undefined, '', 'abc', 2.5]) {
      expect(isOfficialPlaylistEntry({ tid: 211111, dirType })).toBe(false);
    }
    expect(isOfficialPlaylistEntry({ tid: 211111, dirType: '3' })).toBe(true);
    expect(isOfficialPlaylistEntry(null)).toBe(false);
    expect(isOfficialPlaylistEntry('dirType=3')).toBe(false);
  });
});

describe('albumCoverUrlOf', () => {
  it('用专辑 mid 拼出与歌曲封面同一种写法的地址', () => {
    expect(albumCoverUrlOf('000FixAlbum001')).toBe(COVER_211192);
    expect(albumCoverUrlOf('  000FixAlbum001  ')).toBe(COVER_211192);
  });

  it('mid 为空、不是字符串或含非法字符时不给地址', () => {
    for (const mid of ['', '   ', undefined, null, 12345, '001vZ/../x', '001vZ?x=1', 'a b']) {
      expect(albumCoverUrlOf(mid)).toBeUndefined();
    }
  });
});

describe('firstSongAlbumCoverUrl', () => {
  it('取第一首歌的专辑封面', () => {
    expect(firstSongAlbumCoverUrl(dissData().songlist)).toBe(COVER_211192);
  });

  it('第一首没有专辑时不往后找，直接不给封面', () => {
    const songlist = dissData().songlist;
    songlist[0].album = { id: 0, mid: '', name: '' };

    expect(firstSongAlbumCoverUrl(songlist)).toBeUndefined();
  });

  it('没有歌或不是数组时不给封面', () => {
    expect(firstSongAlbumCoverUrl([])).toBeUndefined();
    expect(firstSongAlbumCoverUrl(undefined)).toBeUndefined();
    expect(firstSongAlbumCoverUrl({ 0: { album: { mid: '000FixAlbum001' } } })).toBeUndefined();
    expect(firstSongAlbumCoverUrl([null])).toBeUndefined();
    expect(firstSongAlbumCoverUrl([{ name: '没有专辑字段' }])).toBeUndefined();
  });
});

describe('toSongListDetailResponse', () => {
  it('把带凭据读到的歌单改写成匿名 CGI 的 cdlist[0] 形状', () => {
    const data = dissData();

    expect(toSongListDetailResponse(data)).toEqual({
      code: 0,
      subcode: 0,
      cdnum: 1,
      realcdnum: 1,
      cdlist: [
        {
          disstid: '211192',
          dissname: '歌手漫游 | 专享歌手Mix',
          // 官方歌单的封面一律是第一首歌的专辑图，不沿用 dirinfo.picurl
          logo: COVER_211192,
          desc: '为你推荐的专属歌手歌单！',
          nickname: '歌单作者',
          nick: '歌单作者',
          dir_show: 1,
          dirid: 0,
          song_begin: 0,
          cur_song_num: 3,
          songnum: 50,
          total_song_num: 50,
          songlist: data.songlist,
        },
      ],
    });
  });

  it('第一首没有专辑时封面退回 dirinfo.picurl', () => {
    const data = dissData();
    data.songlist[0].album = {};

    expect(toSongListDetailResponse(data)?.cdlist[0].logo).toBe(data.dirinfo.picurl);
  });

  it('第一首没有专辑、dirinfo 也没有封面时给空字符串', () => {
    const data = dissData();
    data.songlist[0].album = {};
    delete data.dirinfo.picurl;

    expect(toSongListDetailResponse(data)?.cdlist[0].logo).toBe('');
  });

  it('上游没给 total_song_num 时依次退回 dirinfo.songnum 与实际歌曲数', () => {
    const withoutTotal = dissData();
    delete withoutTotal.total_song_num;
    expect(toSongListDetailResponse(withoutTotal)?.cdlist[0]).toMatchObject({
      songnum: 50,
      total_song_num: 50,
    });

    const withoutAnyCount = dissData();
    delete withoutAnyCount.total_song_num;
    delete withoutAnyCount.dirinfo.songnum;
    expect(toSongListDetailResponse(withoutAnyCount)?.cdlist[0]).toMatchObject({
      songnum: 3,
      total_song_num: 3,
    });

    // null 与空字符串是「没给」，不能读成 0 首
    const nullCounts = dissData();
    nullCounts.total_song_num = null;
    nullCounts.dirinfo.songnum = '';
    expect(toSongListDetailResponse(nullCounts)?.cdlist[0]).toMatchObject({
      songnum: 3,
      total_song_num: 3,
    });
  });

  it('缺少的可选字段给出与匿名 CGI 一致的空值', () => {
    const data = dissData();
    data.dirinfo = { id: 211192, title: '歌手漫游 | 专享歌手Mix' };

    expect(toSongListDetailResponse(data)?.cdlist[0]).toMatchObject({
      disstid: '211192',
      desc: '',
      nickname: '',
      nick: '',
      dir_show: 0,
      dirid: 0,
    });
  });

  it('读不出歌单本体时返回 null，让调用方保留匿名 CGI 的原始响应', () => {
    const missingDirinfo = dissData();
    delete missingDirinfo.dirinfo;
    const emptyTitle = dissData();
    emptyTitle.dirinfo.title = '   ';
    const noSongs = dissData();
    noSongs.songlist = [];
    const songlistNotArray = dissData();
    songlistNotArray.songlist = { 0: songlistNotArray.songlist[0] };
    const missingId = dissData();
    delete missingId.dirinfo.id;

    for (const data of [missingDirinfo, emptyTitle, noSongs, songlistNotArray, missingId]) {
      expect(toSongListDetailResponse(data)).toBeNull();
    }
    expect(toSongListDetailResponse(null)).toBeNull();
    expect(toSongListDetailResponse('not a dictionary')).toBeNull();
  });
});
