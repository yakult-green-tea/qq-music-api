const mockUCommon = jest.fn();
const mockGetMusicPlay = jest.fn();

jest.mock('../src/services', () => {
  const actual = jest.requireActual('../src/services');
  return {
    __esModule: true,
    default: { ...actual.default, UCommon: mockUCommon },
  };
});

// The singleton moved to the Node wrapper when `qrLogin.ts` became runtime-neutral; the mock
// follows it. What is mocked and what is asserted are unchanged.
jest.mock('../src/services/auth/qrLogin.node', () => {
  const actual = jest.requireActual('../src/services/auth/qrLogin.node');
  return {
    ...actual,
    __esModule: true,
    default: { getMusicPlay: mockGetMusicPlay },
  };
});

import request from 'supertest';
import app from '../src/app';

const server = app.callback();

describe('GET /getMusicPlay', () => {
  beforeEach(() => {
    mockUCommon.mockReset();
    mockGetMusicPlay.mockReset();
    mockGetMusicPlay.mockResolvedValue({
      'song-mid': { url: 'https://audio.example.test/song.flac', error: false },
    });
  });

  it('uses path songmid and the opaque session for authenticated playback', async () => {
    const response = await request(server).get(
      '/getMusicPlay/song-mid?quality=flac&cookie=qqmusic_session%3Dopaque-token',
    );

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      data: {
        playUrl: {
          'song-mid': { url: 'https://audio.example.test/song.flac', error: false },
        },
      },
    });
    expect(mockGetMusicPlay).toHaveBeenCalledWith('opaque-token', 'song-mid', 'flac', undefined);
    expect(mockUCommon).not.toHaveBeenCalled();
  });

  it('rejects a request without a path or query songmid', async () => {
    await request(server).get('/getMusicPlay').expect(400);
    expect(mockGetMusicPlay).not.toHaveBeenCalled();
    expect(mockUCommon).not.toHaveBeenCalled();
  });
});
