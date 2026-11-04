## [3.3.6](https://github.com/yakult-green-tea/qq-music-api/compare/v3.3.5...v3.3.6) (2026-11-05)

这一版补上一批需要登录的个人化接口：私人 FM、猜你喜欢的听歌模式、音乐偏好读写、听歌排行、每日30首历史、客户端首页 feed、普通官方雷达和黑名单，还能给放不了的歌找可播的其他版本。已有接口的调用方式不变；回包只有能力旗标 `personalFmModes` 从 `true` 改成 `false`。账号写入多了一层防跨站检查，只影响浏览器里靠 Cookie 带会话、又被标成跨站的请求。

### 新功能

- **私人 FM**：`GET /user/personal-fm?page=` 需要会话，用雷达取歌，和 id 99 的猜你喜欢分开。页码严格校验，失败不自动重发，分得清上游结束和本地页数上限。已用真实账号实测：连读三次第 1 页，每次都是新的一批，彼此没有重复。
- **猜你喜欢听歌模式**：`GET /user/guess-you-like/modes` 读模式目录（主模式、场景、建议和当前选中项）；`GET /user/guess-you-like/tracks?pool=` 按模式取一批，不写账号的模式设置。不提供切换模式的写入，模式编号也不能和普通雷达 radio ID、音乐偏好混用。已用真实账号按两种模式各取过一批；不写设置时上游是否一定按模式给歌，还没确认。
- **音乐偏好**：`GET /user/recommendation-preferences` 读私人 FM 和每日30首共用的那一份偏好，返回各项的 key、名称和 0–100 的分值；只读官方偏好页的首屏数据，不执行页面脚本，不返回页面里的歌曲。`POST /user/recommendation-preferences/update` 默认开放：先读现值，只改指定项后整份写一次，再读回确认；不重试，结果不明时标出已尝试。同一进程内按账号排队；Serverless 多个实例之间、或和手机 App 同时修改，仍可能互相覆盖，这是已接受的风险。已用真实账号读写过，读回一致。
- **听歌排行**：`GET /user/listening-rank?range=day|week|month|year`，可选历史日期，每首歌带播放次数。只读本人，没有「全部时间」。空榜回 200 和空列表，不是错误。已用真实账号读过本周和上一周；周的边界（自然周还是最近七天）由上游决定，还没确认。其他听歌报告字段留到后续版本，响应以后可能增加字段，客户端要忽略不认识的字段。
- **每日30首历史**：读历史日期和指定日期的歌曲，只返回上游给的日期和实际曲数，不补缺日，不提供整份历史收藏。
- **客户端首页 feed**：`GET /recommend/feed` 需要会话，只读第 1 页的歌曲和歌单，不翻页，失败不重试。
- **普通官方雷达**：读单选的 radio ID 选项，按 ID 取一批歌；和猜你喜欢的模式目录分开，只取歌、不保存账号设置，旧的电台接口不变。
- **黑名单**：读歌曲、歌手、风格黑名单的首屏和单曲可选的风格，首屏明确标成不完整，不公开内部 Token。新增分类「不喜欢」／减少风格推荐和单项取消：只选歌曲的「不喜欢」默认可用；歌手、风格、混合选择和取消仍是实验写入，默认关闭。只写一次并按分类读回，不自动关联没选的目标，不承诺原子性；首屏没看到目标不等于已经完整移除。
- **替代歌曲**：`GET /song/replacement?mid=` 需要会话。原曲拿不到播放链接、又命中地区或会员规则时，最多试 3 个其他版本，以真拿到链接为准；找不到回 `song: null` 和原因。

### 修复

- 排行榜列表 `/recommend/toplists` 不再丢掉第一组「巅峰榜」：上游这组的组 id 是 0，之前被当成无效整组滤掉。
- 账号 POST 写入在会话来自 Cookie 且 `Sec-Fetch-Site` 为 `same-site`／`cross-site` 时回 403；显式会话标头或查询参数、没有该标头、`same-origin`／`none` 保持原有行为。GET 登出和扫码流程不加这层保护，接受同站其他来源触发的风险。
- 这一版新增的、需要会话的个人化接口，响应都带 `Cache-Control: private, no-store`，失败响应也一样。
- 偏好写入和黑名单的新增、取消，只收 `application/json`，否则回 415。
- 把还没实现的私人 FM 模式能力 `personalFmModes` 改回 `false`；已有的取歌、登录通道和会话模式不变，也不拿猜你喜欢的模式冒充私人 FM 模式。
- 有安全通报的依赖升到修好的版本：运行时依赖 `zod` 的范围提到 `^4.6.6`，下游安装时一定拿到修好的版本；axios 间接用到的 `follow-redirects` 在锁文件里升到 1.16.2，下游要更新自己的锁文件才会拿到。开发工具链里的 `handlebars`、`fast-uri`、`brace-expansion`、`js-yaml` 也一起升了。对外接口不变。

### 给下游的通知

- 新接口都要会话；Serverless 没配会话密钥时回 `501`。
- 浏览器前端如果靠 Cookie 带会话做写入，又和 API 不同站，写入会回 403，要改成用会话标头或查询参数带会话。
- `features.recommendations.personalFmModes` 现在是 `false`：靠这个旗标显示私人 FM 模式入口的客户端，升级后入口会消失。这个后端本来就不处理私人 FM 的模式，之前的 `true` 是错的。
- 精确锁版的应用要更新依赖和锁文件；Electron 要重新打包，Docker 要重建镜像，Vercel 和 Cloudflare 要重新部署，详见[相容与版本政策](./docs/compatibility.md)。

## [3.3.5](https://github.com/yakult-green-tea/qq-music-api/compare/v3.3.4...v3.3.5) (2026-10-21)

这一版修好扫码登录在几种时序下「手机上显示成功、客户端仍未登录」的问题，补上四条读取接口，并移除 3.3.4 预告过的 17 条 Node 旧路由。其余已有接口的调用方式和回包不变，Folia 这类使用保留接口的下游不用修改接入代码。

### 新功能

- **歌曲收藏数**：`GET /song/fav-count?ids=` 匿名查询 1–20 个数字 songid。重复 id 只查一次，结果保留输入顺序和重复项；缺值为 `null`，整批没有数据回 `422`。
- **用户搜索**：`GET /search/users?keyword=&page=&limit=` 需要会话，原样返回用户条目和可用的总数，空页回 `422`。不改变已有 `/search` 的类型和排序。
- **歌曲其他版本**：`GET /song/versions?id=` 或 `?mid=` 匿名读取其他版本，两种标识必须二选一，歌曲条目保留原格式，空列表回 `422`。
- **本人音乐基因**：`GET /user/music-gene` 需要会话，只读本人，原样返回 `profile`；`IsVisitAccount` 保留数字，上游非零业务码回 `502` 并保留 `upstreamCode`。

四条路由在 Node 和 Serverless 都可用；两条需要会话的路由在 Serverless 未配置密钥时回 `501`。

### 移除

以下 17 条只在 Node 上有的旧路由已移除，上一版已提前预告。Node 现在回 `404`，Serverless 照旧回 `501`。有替代接口的请按[使用文档](./docs/README.md#335-已移除)调整参数和响应解析，不能只替换路径：

| 已移除路由 | 替代接口 |
| --- | --- |
| `/getSmartbox` | `/search/match`、`/search/suggest` |
| `/getSongListCategories` | `/recommend/categories/all` |
| `/getSongLists` | `/recommend/category-playlists/sorted` |
| `/batchGetSongInfo` | `POST /song/batch` |
| `/getRadioLists` | `/radio/categories` |
| `/getComments` | `/comment/list` |
| `/getNewDisks` | `/recommend/new-albums` |
| `/getTopLists` | `/recommend/toplists` |
| `/getRanks` | `/recommend/toplist` |

下面 8 条没有替代接口，直接移除：`/user/getCookie`、`/user/setCookie`、`/downloadQQMusic`、`/getImageUrl`、`/getRecommend`、`/getTicketInfo`、`/getDigitalAlbumLists`、`/batchGetSongLists`。

保留的接口不受影响，Folia 这类使用保留接口的下游不用修改接入代码。

### 修复

- 扫码登录在几种时序下会出现「手机上显示登录成功、客户端仍未登录」：换凭证时被取消，凭证存下来却没人拿得到；`/logout` 不管带的是哪把会话，都会丢掉所有正在进行的扫码；最后几秒才确认的二维码一过有效期就被清掉，还在路上的轮询只拿到过期；轮询遇到意外错误也一律说成过期。现在取消、退出登录和过期分开处理：换凭证时被取消的不会再发会话；`/logout` 只退出自己那把会话；已确认的二维码在有效期后再留 60 秒给轮询领取，没人领取的才撤销；意外错误回 `QR login failed`。`/login/status` 被上游拒绝时照旧回空，但会记一条带上游码的日志。回包字段和格式都没有变。

### 改进

- 匿名旧 CGI 接口（`/search/match`、`/recommend/categories/all`、`/recommend/category-playlists/sorted`、`/comment/list`）和其他新接口共用同一个进程内的请求限流，等待的时间算在原来的 25 秒内。回包和错误都没有变。
- 启动和请求日志不再带终端颜色码，文字内容不变。运行依赖少了 `chalk`、`colors`、`moment`；载入本包也不会再往 `String.prototype` 上加属性，嵌入 Electron 时不影响主进程里的其他代码。

### 给下游的通知

- 扫码登录的修复在后端：Folia 等嵌入方要升级依赖和锁文件、重新打包，才会到用户手上。客户端如果自己在「已扫码」后很快放弃并取消，手机上晚确认的那次登录仍然会丢，需要客户端放宽等待时间。
- `/logout` 现在只退出当前带的会话，不再顺带取消别的正在进行的扫码；要取消扫码请用 `/login/qr/cancel?key=`。
- 已移除的 17 条旧路由见上表。精确锁版的应用要更新依赖和锁文件；Electron 要重新打包，Docker 要重建镜像，Vercel 和 Cloudflare 要重新部署，详见[相容与版本政策](./docs/compatibility.md)。

## [3.3.4](https://github.com/yakult-green-tea/qq-music-api/compare/v3.3.3...v3.3.4) (2026-10-21)

这一版补上六条匿名读取接口和排行榜的可选字段，MV 播放链接也能带会话读，同时移除九条已经预告的旧路由。其余已有接口的调用方式和行为保持不变，Folia 这类使用保留接口的下游不用修改接入代码。

### 新功能

下面六条接口在 Node 和 Serverless 都有提供，不需要登录或会话密钥，带上会话也不会用它访问上游：

- **搜索直接命中**：`GET /search/match?keyword=` 返回歌曲、歌手、专辑、MV 分组中的匹配条目。要搜索词建议仍用 `/search/suggest`。
- **完整歌单分类**：`GET /recommend/categories/all` 读取旧 CGI 的分类字典，保留分组、可用标记和上游给出的排序选项；原来的 `/recommend/categories` 继续提供热门分类。
- **带排序的分类歌单**：`GET /recommend/category-playlists/sorted` 接受 `id`、`offset`、`limit` 和 `sortId`。它与 `/recommend/category-playlists` 使用不同数据源，分页位置和总数不能混用。
- **批量歌曲详情**：`POST /song/batch` 一次查询 1–20 首，保留输入顺序和重复项。部分成功时逐项返回结果并标记 `partial`；全空或全失败时返回整体错误，不自动重试。
- **匿名电台分类**：`GET /radio/categories` 列出电台分组，保留空分组，不提供账号的最近记录。`/radio/list` 和 `/radio/tracks` 仍要求登录。
- **资源评论与回复**：`GET /comment/list` 读取评论和回复，下一页要带上一页给的 `nextCursor`；普通评论的末条没有 `rootcommentid` 时不给 `nextCursor`，个别评论缺这个字段也照样交出。资源类型的数字参数还没有完整验证。实测一次读同一个资源的两页，普通评论没有重复，热评只在第一页出现；这只是一个样本，不能当作全部类型和分页都已确认。

`GET /recommend/toplist` 还会从同一次上游响应中补上可选的 `ranks` 和 `history`。`ranks` 按歌曲编号给出排名及上游提供的变化类型和值；`history` 保留往期目录。**实测的两个榜都没有往期条目**，不保证每个榜都有可用的往期目录。缺少或损坏的可选数据会省略，原来的歌曲、分页和错误处理不变，也不增加上游请求。

`GET /mv/url` 带了会话就用它读，登录后可能拿到更多档位的 MP4；没带、解不开会话，或 Serverless 没配置 `QQ_SESSION_SECRET` 时照旧匿名读。回包格式不变，仍然只给有链接的 MP4。

### 移除

以下九条旧路由已移除，上一版已提前预告。请按[使用文档](./docs/README.md#334-已移除)调整参数和响应解析，不能只替换路径：

| 已移除路由 | 替代接口 |
| --- | --- |
| `/getHotkey` | `/search/hot` |
| `/getSingerList` | `/singer/list` |
| `/getSingerDesc` | `/singer/detail` |
| `/getSingerStarNum` | `/singer/homepage` |
| `/getSimilarSinger` | `/singer/similar` |
| `/getSingerMv` | `/singer/mvs` |
| `/getMv` | `/mv/list` |
| `/getMvByTag` | `/mv/list` |
| `/getMvPlay` | `/mv/detail` 和 `/mv/url` |

### 改进

路由注册统一由清单生成，Node 专用代码和共用业务的职责也重新整理，并补上依赖边界检查。除本页列出的新增接口、可选字段、MV 播放链接的会话和旧路由移除外，已有接口行为不变，Folia 这类下游不用为内部整理改代码。

### 给下游的通知

**计划在 3.3.5 移除以下 17 条 Node 旧路由，3.3.4 仍保留。** 请在升级前迁移；替代接口的参数、响应、分页方式可能不同，不承诺与旧接口逐字段相同。

| 计划移除的旧路由 | 改用 |
| --- | --- |
| `/getSmartbox` | `/search/match`、`/search/suggest` |
| `/getSongListCategories` | `/recommend/categories/all` |
| `/getSongLists` | `/recommend/category-playlists/sorted` |
| `/batchGetSongInfo` | `POST /song/batch` |
| `/getRadioLists` | `/radio/categories` |
| `/getComments` | `/comment/list` |
| `/getNewDisks` | `/recommend/new-albums` |
| `/getTopLists` | `/recommend/toplists` |
| `/getRanks` | `/recommend/toplist` |

以下 8 条没有替代接口，将直接移除：

- `/user/getCookie`
- `/user/setCookie`
- `/downloadQQMusic`
- `/getImageUrl`
- `/getRecommend`
- `/getTicketInfo`
- `/getDigitalAlbumLists`
- `/batchGetSongLists`

这些变动不包括 Folia 正在使用的保留接口。精确锁版的应用仍需更新依赖和锁文件；Electron 要重新打包，Docker 要重建镜像，Vercel 和 Cloudflare 要重新部署，详见[相容与版本政策](./docs/compatibility.md)。

## [3.3.3](https://github.com/yakult-green-tea/qq-music-api/compare/v3.3.2...v3.3.3) (2026-10-18)

这一版让 Vercel、Cloudflare 不用中继也能手机 QQ 扫码登录，不登录也搜得到歌了，还加上排行榜、新碟、刷歌模式、相似歌曲，以及歌手、评论、MV、热搜和搜索建议、歌曲标签这一批新接口。Folia 已经在用的接口，路径、参数、字段和状态码都没变；要注意的是 Serverless 的 `/login/channels` 默认多了 `qq`，见下面「给下游的通知」。

### 新功能

- **Vercel、Cloudflare 上也能用手机 QQ 扫码登录**：以前 Serverless 没有中继时只能微信扫码。现在没有中继时，手机 QQ 扫码（`qq` 通道）改走 QQ 互联的网页登录，全程是普通的 HTTP 请求，不用长连接，也不用另外配存储。二维码大约 120 秒失效；手机上确认后，那一次 `/login/qr/check` 会慢一些（最多 15 秒）。登录后的会话跟着 QQ 给的凭证寿命走（目前大约 3 天），快到期时调 `POST /login/refresh` 就能续，最多 30 天。不想提供时设 `QQ_PTLOGIN_HTTP_ENABLED=0`。注入了中继的部署照旧走 MQTT，Node、Electron、Docker 不受影响。
- **歌曲标签**：`GET /song/labels?id=` 读一首歌的标签。不用登录，Node 和 Serverless 都能用；`features` 多了 `songs.getSongLabels`。
- **MV**：`GET /mv/list`（可按地区、版本筛选，带可选的筛选值）、`/mv/detail`、`/mv/url`（MP4 播放链接，只给有链接的档位）、`/song/mvs`（一首歌相关的 MV）。不用登录，Node 和 Serverless 都能用；`features` 多了 `mvs` 一组。
- **歌曲评论**：`GET /comment/hot`、`/comment/new` 读一首歌的热评和最新评论（可翻页），`/comment/count` 读评论数。不用登录，Node 和 Serverless 都能用；`features` 多了 `comments` 一组。
- **歌手**：`GET /singer/list`（可按地区、性别、流派、首字母筛选，带可选的筛选值）、`/singer/detail`（简介、百科）、`/singer/homepage`（粉丝数、关注数）、`/singer/similar`（相似歌手）、`/singer/songs`、`/singer/mvs`（歌手的歌和 MV，可翻页）。不用登录，Node 和 Serverless 都能用；`features` 多了 `singers` 一组。
- **热搜和搜索建议**：`GET /search/hot` 读现在的热搜，`GET /search/suggest?keyword=` 边打字边给搜索词。不用登录，Node 和 Serverless 都能用；`features.search` 多了 `getHotSearches`、`getSearchSuggestions`。
- **相似歌曲、包含这首歌的歌单**：`GET /song/similar?id=` 和 `GET /song/related-playlists?id=`，用数字歌曲 id。要登录（不登录时 QQ 只回空清单），Node 和 Serverless 都能用；`features.recommendations` 多了 `getSimilarSongs`、`getRelatedPlaylists`。
- **刷歌模式**：`GET /recommend/radar?page=` 一页大约 10 首推荐歌，可以一直往下读（QQ 音乐客户端里的「雷达」）。登录了就按账号推荐，没登录也能读；`features.recommendations` 多了 `getRadarSongs`。
- **新碟上架**：`GET /recommend/new-albums` 按地区读新专辑（带歌手、发行日期、歌曲数），可以翻页，同时给出可选的地区。不用登录，Node 和 Serverless 都能用；`features.recommendations` 多了 `getNewAlbums`。
- **排行榜**：`GET /recommend/toplists` 列出全部榜单（按组分好，带封面、这一期是哪天或哪一周、前几名预览），`GET /recommend/toplist?id=` 读一个榜的歌，可以翻页，也可以指定往期。不用登录，Node 和 Serverless 都能用；`/login/channels` 的 `features.recommendations` 多了 `getToplists`、`getToplistSongs`。

### 改进

- **不登录也能搜歌了**：`/search` 不登录搜歌以前常被上游拒绝（`502 search.rejected`），原因是上游已经不认搜歌原来的类型值；现在不登录时改送新的值，就搜得到了，条目格式不变。登录后的搜索照旧。
- **Serverless 上手机 QQ 扫码被拒时也说得出原因**：网页登录换凭证被拒（例如登录设备满了、登录太频繁、账号受限）时，`800` 回应会和 MQTT 通道一样带上 `upstreamErrorKey` 和 `failureHint`，前端可以直接提示该怎么做。网页登录没有再验证这一步，所以这些字段就在顶层，不用看 `primaryFailure`。这几个码的含义沿用公开资料，网页登录这一步还没实测。
- **登录检查不会再拖到 20 秒**：Folia 等一个登录请求 20 秒就当没回应。Serverless 的 `/login/qr/check` 每次最多做 15 秒（以前 20 秒）；Node 的 `QQ_WECHAT_POLL_BUDGET_MS` 上限从 20000 改成 15000 毫秒。
- `/user/liked-songs` 的 `total` 只在上游给的是正常整数时照用，上游给了小数、负数或大得离谱的数时，改用这一页的条数。

### 给下游的通知

- **Serverless 的 `/login/channels` 默认多了 `qq`**：没有中继的部署以前只回 `["wechat"]`，现在回 `["qq", "wechat"]`。照 `data.channels` 显示登录方式的前端（例如 Folia）会多出手机 QQ 这一项，不用改代码；不想要就设 `QQ_PTLOGIN_HTTP_ENABLED=0`。
- 之前把 `QQ_WECHAT_POLL_BUDGET_MS` 设成 15001–20000 的，会改用默认的 15 秒；设在 15000 以内的不受影响。
- **打算在 3.3.4 移除的旧路由**（都只在 Node 上有，已经有新路由接手）：`/getHotkey` 改用 `/search/hot`；`/getSingerList` 改用 `/singer/list`；`/getSingerDesc` 改用 `/singer/detail`；`/getSingerStarNum` 改用 `/singer/homepage`；`/getSimilarSinger` 改用 `/singer/similar`；`/getSingerMv` 改用 `/singer/mvs`。`/getMv`、`/getMvByTag` 改用 `/mv/list`；`/getMvPlay` 改用 `/mv/detail` 和 `/mv/url`。Folia 在用的 `/getSingerHotsong`、`/getSingerAlbum` 不动。
- **以后也会移除、但 3.3.4 先留着的旧路由**：`/getSmartbox`（要搜索词改用 `/search/suggest`，要直接找歌曲、歌手、专辑改用 `/search`；它一次给的「直接命中」还没有完全一样的新路由）、`/getComments`（歌曲评论改用 `/comment/hot`、`/comment/new`；专辑、歌单等其他评论还没有新路由）。

## [3.3.2](https://github.com/yakult-green-tea/qq-music-api/compare/v3.3.1...v3.3.2) (2026-10-17)

这一版加上音乐云盘、QQ 音乐 App 扫码、主动续期和歌词补翻译，修好 Vercel、Cloudflare 上搜索、红心、歌单写入等接口一直回 `502` 的问题，以及网络慢时微信扫码停在“请扫描”。Folia 已经在用的接口，路径、参数、字段和状态码都没变；唯一要注意的是旧的 `/getSearchByKey` 已经移除，见下面「给下游的通知」。

### 新功能

- **音乐云盘**：`GET /user/cloud?limit=&offset=`，要登录，回 `{ code, data, count, hasMore }`。每首带歌曲（上游格式）、文件名、加入时间和 `playable`：对得上曲库的歌拿 `song.mid` 照常用 `/getMusicPlay` 播放，自己上传、没对上的文件只给资料。`limit` 默认 200、最多 1000，一般一次请求只打一次上游。`features` 的 `library.getCloudCollection`、`catalog.getCloudTracks` 现在是 `true`。
- **歌单详情带播放数**：`/user/playlist-detail?playCount=1` 在回包顶层多给一个 `play_cnt`，取自同一次读详情的结果，不多打上游。不公开的歌单是 `0`，“我喜欢”不给（官方也不显示）。不带这个参数时回包和以前一样。
- **歌词补翻译**：`/getLyric?trans=1` 在旧接口的翻译是空的时，再去另一个歌词接口要一次翻译，要到就放进 `trans`（base64 的 LRC）。Node 和 Serverless 都能用，不用登录；补的那次只试一次，失败照常回原来的歌词。不带这个参数时只打一次上游，和以前一样。
- **QQ 音乐 App 扫码登录**：新的登录通道 `qqmusic`（`/login/qr/key?channel=qqmusic`）。用 QQ 音乐 App 扫一扫，就用 App 里当下登录的账号登录，绑 QQ 或微信都行。二维码和手机 QQ 扫码同一种，Serverless 一样要中继。`/login/channels` 的 `channels` 多了 `qqmusic`，排在最后；只认得 `qq`、`wechat` 的前端（例如目前的 Folia）不受影响。
- **主动续期** `POST /login/refresh`：回 `{ token, rotated, expiresAt }`。Serverless 在离到期不到 6 小时时续期并交出新 token（旧 token 照原到期时间可用），从第一次扫码算起最多 30 天；Node、Electron、Docker 照常静默续期、token 不变。不调用就和以前完全一样。新签发的 Serverless token 会多带续期需要的字段，以前签发的照常能用，只是不能续。

### 改进

- 用 QQ 音乐 App 扫手机 QQ 的二维码、App 登的是微信账号时，`login.wrong-scan-app` 的提示改成建议改用 QQ 音乐 App 登录。
- **歌单播放数少打上游**：`/user/playlist?playCount=1` 同一账号 10 分钟内直接用上次读到的播放数，不再每次重扫，所以数字最多晚 10 分钟更新。上游没给明确的翻页信号时，补到的照给，但 `playCountComplete` 是 `false`。

### 修复

- **Vercel、Cloudflare 上搜索、推荐、红心、歌单写入等接口一直回 `502`**：这些接口共用的上游请求带了 `redirect: 'error'`，而 Vercel Edge 和 Cloudflare Workers 的 `fetch` 只认 `follow`、`manual`，请求一发就报错，结果是 `502`（`errorKey` 为 `network.unknown`）。受影响的有搜索、红心、收藏专辑和歌单、歌单加删歌和建立改名删除、会员状态、分类和推荐、每日 30 首、电台、猜你喜欢、云盘、歌词补翻译。现在改成 `manual`，上游真的转址时照旧算网络失败、不跟着跳，状态码和 `errorKey` 都和以前一样。登录、歌单读取、播放走的是另一套请求，本来就正常；Node、Electron、Docker 不受影响。
- **网络慢时微信扫码一直停在“请扫描”**（Node、Electron、Docker）：以前每次 `/login/qr/check` 只等微信 1.5 秒，等不到就断开，下一次要重新连线、重新握手；电脑到微信的往返一慢（实测约 600 毫秒就会），一次都等不到微信回话，手机上同意了，电脑还一直是 `801`，也不报错。现在每次最多等 15 秒，有新状态时微信会马上回，所以扫码和登录成功的反应不会变慢，只有没动静时每次 check 会拖长；对上游的请求也从每分钟十几次降到几次。扫过之后的轮询会带 `last=404`，让微信一直等到授权结果，而不是重复回“已扫描”。Serverless 原本就等 20 秒，不受影响。

### 给下游的通知

- **移除旧搜索接口 `GET /getSearchByKey`**（只有 Node 有，3.3.1 已经预告过）。它实际只会搜歌曲，上游也常出错。现在访问它会回 `404`，请改用 `GET /search`：
  - 参数 `key` 改成 `keyword`，`page`、`limit` 照旧（`limit` 最多 20）；要搜专辑、歌单、歌手就带 `type`。
  - 回包从上游原样的 `{ response }` 变成 `{ code, type, page, limit, total, more, items }`，`items` 里的条目保持上游格式。
  - 不登录搜歌曲常被上游拒绝，这时回 `502`（`errorKey` 为 `search.rejected`），登录后再搜即可。
  - Folia 没用这条接口，不受影响。
- **Node 的微信 `/login/qr/check` 最久会等 15 秒才回**（以前是 1.5 秒左右），回包内容不变。自己写客户端、给这个请求设了比 15 秒短的超时的，请调长；或者部署时设 `QQ_WECHAT_POLL_BUDGET_MS`（1000–20000 毫秒）改回较短的等待，代价是网络慢时又可能等不到扫码。Folia 不设超时，不受影响。

## [3.3.1](https://github.com/yakult-green-tea/qq-music-api/compare/v3.3.0...v3.3.1) (2026-10-15)

这一版补上专辑收藏、红心、关键字搜索、Serverless 歌词和歌单播放数，并修好 Docker 镜像。Folia 已经在用的接口，路径、参数、字段和状态码都没变；新东西都是新路由、可选参数或可选字段，不用就和 3.3.0 完全一样。

### 新功能

- **红心**：`POST /user/song/like`，JSON `{ song: { id, mid, type: 0 }, liked }`，要登录。先核对歌曲，写一次后读回确认才回成功；结果不明回 `502`，不自动重送。`features.mutations.likeSong` 为 `true`。
- **收藏专辑**：`POST /user/album/subscribe`，JSON `{ id: 专辑MID, subscribed }`，要登录，同样写一次、读回确认。`features.mutations.subscribeAlbum` 为 `true`。微信账号的长账号 id 也能正确读写。
- **关键字搜索**：`GET /search?keyword=&type=song|album|playlist|singer&page=&limit=`，Node 和 Serverless 都能用，不登录也能搜。条目保持上游格式、保留各种 MID；搜不到回 `200` 加空清单。不登录搜歌曲常被上游拒绝，这时回 `502`、`errorKey` 为 `search.rejected`，**不会**当成搜不到，登录后再搜即可。`features.search` 多了 `searchAlbums`、`searchPlaylists`、`searchArtists`，`searchSongs` 现在指向这条新路由。
- **歌词支持 Serverless**：`/getLyric` 在 Serverless 也能用了，回包形状和 Node 一样；`features.lyrics.getLyrics` 两个运行时都是 `true`。
- **歌单播放数**：`GET /user/playlist?playCount=1` 会按需给每张歌单补上 `play_cnt`，并多一个 `playCountComplete`。不带这个参数时请求和回包都和以前一样，也不会多打上游。
- **加歌“没有变更”时的说明**：`POST /user/playlist/tracks` 回 `changed: false` 时，多一个可选的 `verification.status`：`present`（歌都已在歌单里）、`absent`（都不在）、`unknown`（判断不出来）。原来的 HTTP 状态和 `changed` 不变。

### 修复

- **QQ 扫码引导更耐时钟误差**：本机时间和服务器差超过一分钟、引导请求被拒时，改用服务器时间重签一次，并补上回归测试与安全日志断言。感谢 [chthollyphile](https://github.com/chthollyphile) 的[贡献](https://github.com/yakult-green-tea/qq-music-api/pull/20)。
- **Docker 镜像**：改用 Node 24 运行编译好的产物，只安装生产依赖，登录状态放在 `/app/.auth-state` 卷里；构建、打标签、推送分开成三个命令，推送地址由使用者明确指定，不再自动推送。

### 改进

- 手机 QQ 扫码收到回调时，多一条 info 日志 `qq-auth.qq-cookies`，只记 cookie 名称和 `tmeLoginType` 数字，不记任何值，方便排查不同 App 扫码的差异。
- 契约测试集扩大到现有的写入、播放和扫码诊断，离线全套都会跑。

### 给下游的提醒

- 旧的 `GET /getSearchByKey`（只有 Node）不建议再用，**计划在 3.3.2 移除**。它实际只会搜歌曲，上游也常常出错；请改用 `/search`，参数从 `key` 改成 `keyword`，回包是 `{ code, type, page, limit, total, more, items }`。

## [3.3.0](https://github.com/yakult-green-tea/qq-music-api/compare/v3.2.0...v3.3.0) (2026-10-14)

这一版补上推荐、电台、歌单编辑和更清楚的播放结果。Folia 已经在用的接口，路径、参数、字段和状态码都没变；下面「对现有调用的影响」列了几处看得出来、但不需要改调用方的行为变化。

### 新功能

- **电台**：`/radio/list` 读电台分组，`/radio/tracks?id=` 读某个电台的歌，都要登录。`id=99` 就是「猜你喜欢」，可能带推荐理由 `extras`。
- **歌单分类、分类歌单和新歌速递**：`/recommend/categories`、`/recommend/category-playlists?id=&page=&limit=`（带 `total` 和 `more`，可以一页一页往下读）、`/recommend/new-songs?area=`，不登录也能用。
- **每日 30 首**：`/user/daily-songs`，要登录。直接读账号自己的每日推荐，不用先在 QQ 音乐里收藏它；没有 `refresh` 参数，同一天拿到的是同一批。
- **编辑自己的歌单**（都要登录、用 POST，只对自己的普通歌单生效，写入只送一次、不自动重试）：
  - `/user/playlist/tracks`：往歌单里加歌或删歌，回 `{ code, changed }`，`changed` 说明这次有没有真的改动。
  - `/user/playlist/create`、`/user/playlist/rename`、`/user/playlist/delete`：建立、改名、删除。改名会保留原来的简介、标签、封面和公开设置（设了第二张封面的歌单暂时不能改名）；写完都会读回确认。“我喜欢”和系统歌单不能改。
- **收藏**：`POST /user/playlist/subscribe` 收藏或取消收藏歌单；`GET /user/subscription-status?type=&ids=` 一次查多个歌单、专辑或歌曲有没有收藏，查不出来时明确回 `unknown`，不会假装成“没收藏”。
- **会员状态**：`/user/vip` 回 `isVip` 和 `vipLevel`（`free`、`green` 绿钻、`super` 超级会员、`unknown` 判断不出来）。这两个字段只用来显示，能不能播还是看取链接的结果。
- **播放结果更清楚**（`/getMusicPlay`）：
  - 拿不到链接的那首会多一个 `restriction`（`key` 一律是 `url_unavailable`）和给人看的 `hint`（`key` 加英文预设文案，前端可以按 `key` 换成自己的说法）。只有经过受控实测的情况才会说“可能是地区限制”或“可能需要会员”，其他一律说“原因尚未确认”。设 `QQ_PLAYBACK_HINTS_ENABLED=0` 可以关掉具体提示。
  - `preview=1` 改要试听文件，拿到的条目标 `preview: true`。会先确认这首有试听文件才去要；确定没有时提示 `playback.preview-missing`。
  - `quality=best` 帮你拿这首歌能拿到的最高音质：按 flac、320、128 一级一级试，每个条目多一个 `quality` 说明实际拿到哪一级。不带 `quality` 时和以前一样是 128。
  - `quality=ape` 会先确认有这个文件才去要，没有文件和查询失败给不同的提示。
- **扫码失败更好判断**：扫码失败的回应可能多 `upstreamErrorKey` 和 `failureHint`；手机 QQ 通道在换凭证失败时会多给 `primaryFailure`，告诉你被后续检查盖掉的真正原因（例如登录设备数到上限）。
- `/login/channels` 的 `data.features` 把上面这些新功能标成 `true`；红心、专辑收藏写入等还没验证的功能仍是 `false`。

### 对现有调用的影响

- **扫码失败后的冷却**改成固定 15 秒，不再越失败越久；上游明确说操作太频繁时是 30 秒。
- **桌面版、Node、Docker 的登录会自动续期**：凭证快到期前 6 小时内，服务会在背景换新凭证，会话 token 不变，不用再大约三天重扫一次。网页版（Serverless）还没有这个能力。
- **原因没确认时会再取一次链接**：带登录的 `m4a`／`128` 有歌拿不到链接、原因又判断不出来时，服务会用同一会话马上再要一次（这几首合成一个请求，每首最多多一次）。拿到了就直接回链接；还是没有就回第一次的结果。
- **微信扫码后不会再跳回“等待扫码”**：手机已经扫了、还没按确认时，`/login/qr/check` 会一直回 `802`。手机 QQ 通道不变；网页版每次检查仍会重建状态，还没有完全修好。

### 改进

- 开发日志更安全：请求日志只留方法、路由模板、参数键名和数量、白名单里的数字码和耗时，不记歌曲 id、播放链接或参数值。拿不到链接的歌会在 debug 日志里记一条 `playback.url-unavailable`（匿名播放也记）。
- 微信扫码新增三类 info 日志（`qq-auth.wechat-poll`、`qq-auth.wechat-qr-state`、`qq-auth.wechat-qr-check`），只记状态、耗时和安全数字码，方便分清是扫码、换凭证还是画面显示的问题。回应没有新增字段。

### 文档

- 使用文档补上 Serverless 部署须知：网页版可能有几首歌拿不到链接，新的部署会算成新登录设备。
- 新功能都写进了[使用文档](./docs/README.md)和 API Explorer 的说明。

## [3.2.0](https://github.com/yakult-green-tea/qq-music-api/compare/v3.1.5...v3.2.0) (2026-10-13)

### 新功能

- Node 增加 `/login/channels`，可在登录前查询支持的登录通道、会话模式与后端功能。Node 和 serverless 的响应都新增 `data.features`，按接口分组，用布尔值说明已经实现的方法；写入等尚未实现的方法保持 `false`。原有通道、会话模式和 `configured` 的含义不变。
- `/user/playlist` 的收藏歌单超过 1000 张时可以接着读：响应带 `nextFavoriteOffset`，把它当成 `favoriteOffset` 再请求一次，那一轮只返回收藏歌单。不带参数时请求和响应都和以前一样。
- 新增 `/user/guess-you-like`（猜你喜欢，要登录，每次拿几首歌）和 `/recommend/playlists`（推荐歌单，有登录就带凭证，没有就匿名读），Node 和 serverless 都能用。出错时用状态码加固定的 `errorKey` 说明原因：没登录或凭证被拒是 `401`、上游没给数据是 `422`、限流是 `429`、上游失败或格式不对是 `502`。设 `LOG_LEVEL=debug` 时，`401`、`422` 的原因也会写进开发日志。`/login/channels` 里的 `getPersonalFm`、`getRecommendedCollections` 改成 `true`。
- `/getSongListDetail` 带凭证重读官方歌单时，`cdlist[0]` 多了 `listennum`（播放数）、`uin` 和 `encrypt_uin`（建立者），字段名沿用上游。

### 改进

- Cloudflare Workers 等没有全局 `Buffer` 的 Web 宿主现在可以启动扫码流程：协议字节操作改用 Web API 兜底，Node 仍直接使用原来的 Buffer，不增加 npm 或 Node 运行时依赖。
- 登录态读取中，上游网关码和凭证拒绝码同时出现时，改为返回 `502`，不再误回 `401` 清掉会话；`error` 仍保留原有的安全协议说明。只有网关失败、没有凭证拒绝码时仍沿用原来的 `500`，真正的凭证拒绝仍是 `401`。Folia 会把这个 `502` 当作网络错误，播放时可能触发音源冷却。
- 旧接口出错返回 `500` 时，不再把原始异常原样带回去。以前响应里可能夹着上游请求地址、请求头、调用栈这类内部信息；现在 `error` 只留固定的说明文字，再加上可以公开的错误码（例如 `ECONNRESET`）和上游 HTTP 状态码。状态码和 `error` 字段都没变。日志也只记录同样的摘要，账号和设备相关的参数值会被遮掉。
- `/user/playlist` 的收藏歌单没读完时（读到 1000 条上限、上游给了空页或反复给同一页），`more` 改为 `true`，`total` 改为真实总数，不再把截断的列表说成完整的。上限本身不变；上游不理分页时会提早停下，少发几次请求。
- `/user/playlist` 的 `uid` 只能是登录账号本身：传别人的 uid 改为返回 `400`，不再把对方的自建歌单和自己的收藏混在一起返回。不传 `uid` 的调用（包括 Folia）不受影响。
- `/getSongListDetail` 带凭证重读官方歌单时，上游反复给同一页不再把重复的歌接上去；`cdlist[0]` 多了 `hasmore`（`1` 表示没读完）。
- 登录态取播放链接时，某首歌拿不到链接会在开发日志里记一条 `playback.url-unavailable`（要设 `LOG_LEVEL=debug` 才看得到），带上那首歌在请求里的位置、音质和上游给的几个数字码，方便排查为什么播不了。不记歌曲 id、凭证、链接和账号 id；`/getMusicPlay` 的响应不变。

### 内部改进

- Node 和 serverless 原本各写一份的 18 个 Folia 接口，改成共用同一套处理代码，两边只保留很薄的转接；登录认证服务按扫码、会话、带凭证读取、播放链接、MQTT 拆成多个模块，原来的入口和桌面版用到的钩子都保留。每个接口都和 3.1.4、3.1.5 逐一比对过，对外行为除本页列出的改动外不变。
- 为后续接口增加共用请求核心，支持批次请求、限流、只读重试和整体超时。新增离线测试同时验证 Node 原生 fetch 和 Web Response 的行为。
- 上游错误码改成按接口和响应层级分别登记，不再全局套用同一张码表。
- 开发日志更好排查：程序自己的固定错误说明会作为 `reason` 记进日志，对外响应仍是一般化的文字；分页没读完就停下时会记一条 `qq-auth.paging-stopped`，说明原因和读到的数量，不记账号或歌单 id。

### 仓库维护

- 默认测试里不再有只看状态码的旧路由测试：全部改成模拟上游的严格测试，Node 和 serverless 各跑一遍，不连外网。`npm run test:legacy-routes` 与 `npm run probe:legacy-routes` 保留，目前没有测试。

## [3.1.5](https://github.com/yakult-green-tea/qq-music-api/compare/v3.1.4...v3.1.5) (2026-10-11)

### 改进

- `/user/playlist` 里官方歌单（每日30首与算法歌单）的封面少打上游请求：条目自带的 `albumPicUrl` 是专辑图时直接用它拼出封面，不再为每张歌单多读一首歌；缺失或不是专辑图时才像以前一样读第一首歌，一次最多 20 张。封面地址和字段与 3.1.4 完全相同。

### 文档

- README、接口文档和 API Explorer 里把 `qq` 通道写成了“QQ 音乐 App 扫码”，实际是用手机 QQ 扫码，现已更正。通道 id（`qq`、`wechat`）和接口行为都没有变。

## [3.1.4](https://github.com/yakult-green-tea/qq-music-api/compare/v3.1.3...v3.1.4) (2026-10-09)

### 问题修复

- `/getSongListDetail` 读不到 QQ 音乐按账号生成的官方歌单（百万收藏、新歌推荐、歌手漫游等），匿名接口只返回 `code: 10`。请求带着登录会话时改用登录凭证重新读取，响应结构不变；其他歌单不受影响，重新读取失败时保持原响应，不返回 `401`。Node 与 Serverless 入口行为一致。
- `/user/playlist` 中的官方歌单（每日30首与算法歌单）改用第一首歌的专辑图作为封面；收藏的他人歌单补上歌单原本的封面。两者都写入与自建歌单相同的 `bigpicUrl`／`picUrl` 字段。

## [3.1.3](https://github.com/yakult-green-tea/qq-music-api/compare/v3.1.2...v3.1.3) (2026-10-05)

### 改进

- 扫码失败响应增加阶段、原因和上游 HTTP 状态；本地退避 `429` 保留前一次失败摘要。不返回异常原文或登录凭证。

### 问题修复

- 修复取消或替换旧二维码后误触发登录退避的问题，避免重试时返回 `429`；过期清理只计一次退避。

## [3.1.2](https://github.com/yakult-green-tea/qq-music-api/compare/v3.1.1...v3.1.2) (2026-09-12)

### 新功能

- 新增 `/user/playlist-detail`，用登录凭证分页读取用户自己的歌单（`tid`／`dirid`／`offset`／`limit`），响应形状与 `/user/liked-songs` 相同。设为「不公开」的自建歌单在匿名的 `/getSongListDetail` 上只会返回空列表，现在可以经由这条路由读到；收藏的他人歌单仍应走 `/getSongListDetail`。`/user/liked-songs` 改为走同一实现，行为不变。

## [3.1.1](https://github.com/yakult-green-tea/qq-music-api/compare/v3.1.0...v3.1.1) (2026-09-10)

### 问题修复

- 当 Android `UrlGetVkey` 未返回 CDN 地址时，优先探测可用的高速节点，并在失败时动态调度其他节点，改善高码率音频播放卡顿。

## 3.1.0 (2026-08-25)

### 新功能

- 新增 `@yakult-green-tea/qq-music-api/mqtt` 子路径导出，让能够维持 WebSocket 长连接的宿主复用同一套 MQTT 编解码和 QR 事件解析逻辑。
- 为 Serverless 入口增加可注入的 QQ QR 中继；注入中继时 `/login/channels` 同时公布 QQ 与微信通道，未注入时保持仅微信通道。

### 问题修复

- MQTT WebSocket 握手失败或提前关闭时立即结束等待，避免登录请求一直挂起。
- 明确要求宿主等待 WebSocket `open` 事件后再发送 CONNECT，并正确转发 `Uint8Array` 的有效字节范围。

### 文档

- 补充 Node.js、Vercel Functions 与 Cloudflare Durable Object 的导出入口、能力边界和安全责任说明。

## 3.0.0 (2026-08-18)

### 新功能

- 新增零 Koa、零 `node:*` 依赖闭包的 `./serverless` 导出和 Web 标准 `handleRequest` 入口。
- 使用密封 QR 与登录会话，使 Vercel Functions 和 Cloudflare Workers 的无状态请求能够延续扫码登录。
- 增加 Fetch 版认证与旧接口传输层，并提供登录、用户歌单、收藏专辑、我喜欢和登录态播放等必要路由。

### 问题修复

- 从密封 QR 中移除二维码图片，改为根据标识重新获取，避免令牌过大。
- 移除 Serverless 依赖闭包中的 Node.js 加密模块，解除 Edge 运行时部署阻断。

### 仓库维护

- 记录受保护分支、验证、安全报告与发布流程。
- 明确 Folia 只会在单独更新 npm 依赖与锁文件后使用新版本。
- 在包元数据和文档中保留下游贡献者署名。

## [2.3.0](https://github.com/yakult-green-tea/qq-music-api/compare/v2.2.2...v2.3.0) (2026-08-09)

### Features

- Add an injectable authentication-session repository for trusted npm hosts while retaining the in-memory default.

## [2.2.2](https://github.com/yakult-green-tea/qq-music-api/compare/v2.2.1...v2.2.2) (2026-08-09)

### Bug fixes

- Isolate the legacy QQ request client from shared `axios.defaults` so importing the package does not modify its host process.

## [2.2.1](https://github.com/yakult-green-tea/qq-music-api/compare/v2.2.0...v2.2.1) (2026-08-09)

### Bug fixes

- Publish only account identifiers that are actually available from the login credential.

## [2.2.0](https://github.com/yakult-green-tea/qq-music-api/compare/v2.1.0...v2.2.0) (2026-08-08)

### Features

- Add `GET /user/albums` for authenticated favorite-album pagination.
- Derive the account identifier required by authenticated user collections.

## [2.1.0](https://github.com/yakult-green-tea/qq-music-api/compare/v1.0.4...v2.1.0) (2026-08-07)

### Features

- Migrate the maintained fork to TypeScript and add the local API Explorer.
- Add native mobile QQ and WeChat QR login, authenticated playback, and cancellable QR sessions.
- Add runnable JavaScript package output and export the HTTP server handle for npm embedders.

### Bug fixes

- Isolate authentication requests from global Axios defaults and persist a non-secret device context.
- Correct runtime dependencies and disable the development version check for embedded consumers.

## [1.0.4](https://github.com/Rain120/qq-music-api/compare/v1.0.3...v1.0.4) (2021-01-25)


### Bug Fixes

* doc screenshot png path ([fe811e2](https://github.com/Rain120/qq-music-api/commit/fe811e26c0c0a2ed468728b0323866bd27b5a404))
* music play url quality; docs about cookie, music play; ([#35](https://github.com/Rain120/qq-music-api/issues/35)) ([f0b7923](https://github.com/Rain120/qq-music-api/commit/f0b7923b9feb7e32c44bc9417c2d426148ab3865))



## [1.0.3](https://github.com/Rain120/qq-music-api/compare/v1.0.1...v1.0.3) (2021-01-24)


### Bug Fixes

* doc screenshot png path ([cb8b253](https://github.com/Rain120/qq-music-api/commit/cb8b25358219ca1cc3e973e6f46a3f75bb3b8b29))


### Features

* user cookie ([#32](https://github.com/Rain120/qq-music-api/issues/32)) ([5a32dae](https://github.com/Rain120/qq-music-api/commit/5a32daeca351c7b18352f9267db0c173fef9bff6))



## [1.0.1](https://github.com/Rain120/qq-music-api/compare/v1.0.0...v1.0.1) (2020-12-25)


### Bug Fixes

* build docker image sh ([fe395a4](https://github.com/Rain120/qq-music-api/commit/fe395a435efc0678d3d387abbcd6b33786bb72fa))


### Features

* docker build images to hub for docker env run ([dcbbf95](https://github.com/Rain120/qq-music-api/commit/dcbbf95e70b305cd2ad4d00a7cc0bd4db5d0f8ab))
* docker repository version ([d74a425](https://github.com/Rain120/qq-music-api/commit/d74a4251da8c0c2dac2f5e4251e91f288f732d43))



# [1.0.0](https://github.com/Rain120/qq-music-api/compare/4d79041a5e5712c0c6bc6e6d55045f732636c80f...v1.0.0) (2020-09-15)


### Bug Fixes

* bug about search by key https://github.com/Rain120/qq-music-api/issues/28 ([12b7d66](https://github.com/Rain120/qq-music-api/commit/12b7d667c05f92ad61545c5f75a82d878ad3220c))
* getComment ([#26](https://github.com/Rain120/qq-music-api/issues/26)) ([9e62be5](https://github.com/Rain120/qq-music-api/commit/9e62be539b3b78cdf0eea3e1696d9505ab242756))
* getSingerHotsong pagination ([#19](https://github.com/Rain120/qq-music-api/issues/19)) ([9bb705a](https://github.com/Rain120/qq-music-api/commit/9bb705a1b6eb4e2577ba20f0a279ccb63112390d))
* getSingerHotsong pagination ([#22](https://github.com/Rain120/qq-music-api/issues/22)) ([6d6dbf3](https://github.com/Rain120/qq-music-api/commit/6d6dbf36c545269ad7a6138e711e436a90d61e28))
* issue 14 about getRank topId was invalid ([024096f](https://github.com/Rain120/qq-music-api/commit/024096fa63144391680f1d6ec376929fee697c37))
* issue 14 about getRank which bug about period change by qq music api ([f13d2b5](https://github.com/Rain120/qq-music-api/commit/f13d2b540d860994600cc2728e4d848df574b2f4))
* issue: 12 -> (getHotkey -> getHotKey); axios option error; ([ee0371b](https://github.com/Rain120/qq-music-api/commit/ee0371b32352546feb8b60b7725dc3ff66a412ef))
* issue: 12, require getHotkey Camel-Case bug ([0eb9297](https://github.com/Rain120/qq-music-api/commit/0eb9297ff19773ef2d61377f341937f20a70d6a4))
* mv params bug: https://github.com/Rain120/qq-music-api/issues/16\#issuecomment-638230301 ([8f29b87](https://github.com/Rain120/qq-music-api/commit/8f29b874705ab0638310bcc13781a5599ab9de4d)), closes [#issuecomment-638230301](https://github.com/Rain120/qq-music-api/issues/issuecomment-638230301)
* song list params bug: https://github.com/Rain120/qq-music-api/issues/16 ([d9fb973](https://github.com/Rain120/qq-music-api/commit/d9fb9732f546cb76f208053a8dabd164aad893c5))


### Features

* add song list ([c0e8de8](https://github.com/Rain120/qq-music-api/commit/c0e8de86dd93a907aa75e838c18d967b1434493d))
* batch get song info ([0ac4cfc](https://github.com/Rain120/qq-music-api/commit/0ac4cfca38e15e727d79f76c39e729a0ff3abc16))
* batch get songlist ([facc3cb](https://github.com/Rain120/qq-music-api/commit/facc3cbf7a44fbeb1db48bfa0c18e7918938b21c))
* eslint + prettier + commitlint + changelog + editorconfig ([e547ca3](https://github.com/Rain120/qq-music-api/commit/e547ca3c43db052769a06f5e0090a29749b721d5))
* get song info; rebuild the axios request, cut down route params ([4d79041](https://github.com/Rain120/qq-music-api/commit/4d79041a5e5712c0c6bc6e6d55045f732636c80f))
* getImageUrl; commit push shell; ([69f257a](https://github.com/Rain120/qq-music-api/commit/69f257a41d5d4746dce306c84ff902358a0d391c))
* rebuild router and axios ([0b737df](https://github.com/Rain120/qq-music-api/commit/0b737df8971a560119af2bcae199a1ea5549859c))
* rebuild router for lost ([2165b6a](https://github.com/Rain120/qq-music-api/commit/2165b6a8b5527bb2b68592b17e28846fce1e856f))
* rebuild routers ([1278008](https://github.com/Rain120/qq-music-api/commit/1278008d57bd8fb4bced800c3de6c6f16f0aee8f))
