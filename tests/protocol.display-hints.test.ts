import { LOGIN_HINT_MESSAGES, loginFailureHintOf } from '../src/protocol/loginHints';
import {
  hasKnownUnplayableTraits,
  PLAYBACK_HINT_MESSAGES,
  PLAYBACK_HINT_RULES,
  playbackHintOf,
} from '../src/protocol/playbackHints';

// 给使用者看的原因只是提示，不改 restriction.key、不改证据等级。播放原因不能猜：只有受控对照下验证过的规则
// 才能说会员、付费音乐包、地区或下架，其他一律是「原因尚未确认」那一句。登录失败按码挑一句英文预设文案。

const track = (overrides: { pay?: object; action?: object; ov?: unknown } = {}) => ({
  mid: 'fixture-song',
  pay: { pay_play: 0, pay_month: 0, ...overrides.pay },
  action: { switch: 1, msgid: 0, alert: 0, ...overrides.action },
  ...(overrides.ov === undefined ? {} : { ov: overrides.ov }),
});

const UNCONFIRMED = {
  key: 'playback.reason-unconfirmed',
  message: "This song can't be played right now. The exact reason isn't confirmed yet.",
};

describe('playback display hints', () => {
  it('完整规则只有地区、会员与下架候选，不带播放上下文时保持未知', () => {
    expect(PLAYBACK_HINT_RULES.map((rule) => rule.key)).toEqual([
      'playback.maybe-region-restricted',
      'playback.maybe-membership',
      'playback.maybe-taken-down',
    ]);
    expect(playbackHintOf(track({ action: { switch: 141671807 } }))).toEqual(UNCONFIRMED);
    expect(playbackHintOf(track({ action: { switch: 1, msgid: 23, alert: 0 } }))).toEqual(
      UNCONFIRMED,
    );
  });

  // 以前按这些讯号猜原因；没有受控证据之前都只能说原因尚未确认。
  it.each([
    ['msgid 23', track({ action: { msgid: 23 } })],
    ['ov 1', track({ ov: 1 })],
    ['alert 11', track({ action: { alert: 11 } })],
    ['pay_play 1', track({ pay: { pay_play: 1 } })],
    ['msgid 8', track({ action: { msgid: 8 } })],
    ['alert 35', track({ action: { alert: 35 } })],
    ['no signal', track()],
    ['no track at all', undefined],
    ['garbage', 'not-a-track'],
    ['null blocks', { pay: null, action: null }],
  ])('%s → the reason is not confirmed', (_label, input) => {
    expect(playbackHintOf(input)).toEqual(UNCONFIRMED);
  });

  it('uses the first verified rule that matches, and the unconfirmed line otherwise', () => {
    const rules = [
      {
        key: 'playback.maybe-membership' as const,
        matches: (trackInfo: unknown) =>
          (trackInfo as { pay?: { pay_play?: number } } | undefined)?.pay?.pay_play === 1,
      },
      { key: 'playback.maybe-taken-down' as const, matches: () => true },
    ];

    expect(playbackHintOf(track({ pay: { pay_play: 1 } }), rules)).toEqual({
      key: 'playback.maybe-membership',
      message: PLAYBACK_HINT_MESSAGES['playback.maybe-membership'],
    });
    expect(playbackHintOf(track(), rules).key).toBe('playback.maybe-taken-down');
    expect(playbackHintOf(track(), rules.slice(0, 1))).toEqual(UNCONFIRMED);
  });

  it('keeps a rule that throws from breaking the answer', () => {
    const rules = [
      {
        key: 'playback.maybe-region-restricted' as const,
        matches: () => {
          throw new Error('fixture');
        },
      },
    ];

    expect(playbackHintOf(track(), rules)).toEqual(UNCONFIRMED);
  });

  it('keeps every message in plain English without upstream text', () => {
    for (const message of Object.values(PLAYBACK_HINT_MESSAGES)) {
      expect(message).toMatch(/^[\x20-\x7e]+$/);
      expect(message.length).toBeGreaterThan(10);
    }
  });
});

describe('login display hints', () => {
  it.each([
    [
      'device limit on top',
      { upstreamCode: 20279, upstreamErrorKey: 'auth.device-limit' },
      'login.device-limit',
    ],
    [
      'device limit hidden behind the fallback',
      { upstreamCode: 1000, primaryFailure: { upstreamCode: 20279 }, fallbackAttempted: true },
      'login.device-limit',
    ],
    [
      'mobile QQ exchange 50006 then fallback',
      { upstreamCode: 1000, primaryFailure: { upstreamCode: 50006 }, fallbackAttempted: true },
      'login.wrong-scan-app',
    ],
    ['50006 without a fallback stays unknown', { upstreamCode: 50006 }, undefined],
    ['104604 on top', { upstreamCode: 104604 }, 'login.rate-limited'],
    [
      '104604 hidden behind the fallback',
      { upstreamCode: 1000, primaryFailure: { upstreamCode: 104604 }, fallbackAttempted: true },
      'login.rate-limited',
    ],
    ['upstream HTTP 429', { upstreamHttpStatus: 429 }, 'login.rate-limited'],
    ['restricted', { upstreamErrorKey: 'auth.account-restricted' }, 'login.account-restricted'],
    ['banned', { upstreamErrorKey: 'auth.account-banned' }, 'login.account-banned'],
    ['binding', { upstreamErrorKey: 'auth.account-binding' }, 'login.account-binding'],
    ['rejected', { upstreamErrorKey: 'auth.login-rejected' }, 'login.rejected'],
    ['canceled on the phone', { failureReason: 'user-canceled' }, undefined],
    ['natural expiry', { failureReason: 'qr-timeout' }, undefined],
    ['unknown code', { upstreamCode: 1000 }, undefined],
    ['nothing', {}, undefined],
  ])('%s → %s', (_label, details, key) => {
    expect(loginFailureHintOf(details as never)).toEqual(
      key === undefined
        ? undefined
        : { key, message: (LOGIN_HINT_MESSAGES as Record<string, string>)[key as string] },
    );
  });

  it('keeps every message in plain English', () => {
    for (const message of Object.values(LOGIN_HINT_MESSAGES))
      expect(message).toMatch(/^[\x20-\x7e]+$/);
  });
});

describe('下架特征（switch 的 bit 27）', () => {
  const context = {
    authenticated: true,
    quality: '128',
    codes: { result: 104003, subcode: 1 },
  };
  const withSwitch = (value: unknown) => ({ action: { switch: value, msgid: 0, alert: 0 } });

  it.each([
    [141671807, 'playback.maybe-taken-down'],
    [0x8010001, 'playback.maybe-taken-down'],
    ['134283265', 'playback.maybe-taken-down'],
    [0x10001, 'playback.reason-unconfirmed'],
    [7421823, 'playback.reason-unconfirmed'],
    [-1, 'playback.reason-unconfirmed'],
    [1.5, 'playback.reason-unconfirmed'],
  ])('switch %p → %s', (value, expected) => {
    expect(playbackHintOf(withSwitch(value), PLAYBACK_HINT_RULES, context).key).toBe(expected);
  });

  it('没有带会话的 104003 上下文就不说下架', () => {
    expect(
      playbackHintOf(withSwitch(141671807), PLAYBACK_HINT_RULES, {
        ...context,
        authenticated: false,
      }).key,
    ).toBe('playback.reason-unconfirmed');
    expect(
      playbackHintOf(withSwitch(141671807), PLAYBACK_HINT_RULES, { ...context, quality: '320' })
        .key,
    ).toBe('playback.reason-unconfirmed');
  });

  it('挑替代版本时，带下架特征的版本算已知不可播', () => {
    expect(hasKnownUnplayableTraits(withSwitch(141671807))).toBe(true);
    expect(hasKnownUnplayableTraits(withSwitch(7421823))).toBe(false);
  });
});
