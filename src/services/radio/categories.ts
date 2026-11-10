import { WEB_ANONYMOUS_COMM_WITH_UIN } from '../../protocol/clientProfiles';
import { QqApiError } from '../../protocol/errors';
import { createMusicuClient } from '../../protocol/musicu';
import { createFetchTransport } from '../../transport/fetch';
import { anonymousResult, arrayOf, countOf, objectOf, textOf } from '../catalog/anonymous';
import { okResult } from '../recommend/newRouteResult';

/** 匿名分类不访问登录服务；个人最近记录不在这个入口提供。 */
export const radioCategoriesResult = () =>
  anonymousResult('get-radio-categories', async () => {
    const client = createMusicuClient({
      http: createFetchTransport(),
      comm: WEB_ANONYMOUS_COMM_WITH_UIN,
      maxRetries: 0,
    });
    const raw = await client.execute({
      module: 'pf.radiosvr',
      method: 'GetRadiolist',
      param: { uin: '0' },
      operation: 'radio.categories',
      readOnly: true,
    });
    const entries = arrayOf(objectOf(raw).radio_list);
    if (!entries.length) throw new QqApiError('not-found');
    const groups = entries.flatMap((entry) => {
      const group = objectOf(entry),
        id = countOf(group.id);
      if (!id) return [];
      const radios = arrayOf(group.list).flatMap((entry) => {
        const radio = objectOf(entry),
          id = countOf(radio.id);
        if (!id) return [];
        return [
          {
            id,
            title: textOf(radio.title),
            picurl: textOf(radio.pic_url),
            ...(countOf(radio.listenNum) === undefined ? {} : { listenNum: radio.listenNum }),
          },
        ];
      });
      return [{ id, title: textOf(group.title), radios }];
    });
    if (!groups.length) throw new QqApiError('invalid-response');
    return okResult({ groups });
  });
