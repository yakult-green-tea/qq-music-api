import { describeRuntimeCapabilities } from '../src/services/runtimeCapabilities';

// 取歌能力不代表支持 FM 模式；尚未完成实账号验证的历史与屏蔽能力不能提前打开。
it.each([
  'node',
  'serverless',
] as const)('%s does not advertise unsupported FM mode controls', (runtime) => {
  const declaration = describeRuntimeCapabilities(
    runtime,
    {
      channels: ['qq'],
      sessionMode: runtime === 'node' ? 'stored' : 'sealed',
    },
    true,
  );
  expect(declaration.features.recommendations).toMatchObject({
    getPersonalFm: true,
    getDailySongs: true,
    personalFmModes: false,
    getHistoryDates: false,
    getHistorySongs: false,
    dislikeSong: false,
  });
});
