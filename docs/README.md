<h2 align="center" id="qqmusicapi">QQ Music API</h2>

!> 这是非官方、社区维护的 QQ 音乐 API。问题与建议请提交到当前 fork 的 [issue](https://github.com/yakult-green-tea/qq-music-api/issues)。软件按 [MIT License](https://github.com/yakult-green-tea/qq-music-api/blob/main/LICENSE) 提供；使用者仍应自行遵守所在地法律、平台条款与内容授权要求。

## API结构图

![qq-music](https://raw.githubusercontent.com/Rain120/qq-music-api/master/screenshot/qq-music.png)

## 当前架构

!> 当前主干分支已经完成 TypeScript 化改造，项目由 `Koa2 + TypeScript` 服务端和内置 `API Explorer` 调试工作台两部分组成。

- `src/app.ts`：应用入口，负责中间件、路由、静态资源与 Explorer 集成。
- `src/controllers/*`：控制器层，负责参数处理与响应封装。
- `src/services/*`：服务层，负责访问 QQ 音乐相关数据能力。
- `src/config/apiExplorer.ts`：Explorer 元数据源，统一维护接口清单、分类、参数与示例请求体。
- `src/explorer/contracts` / `domain` / `application`：Explorer 的状态模型、树构建、筛选逻辑与 Store/Command。
- `public/explorer/*`：Explorer 页面静态资源，包括界面、交互和样式。
- `tests/*`：覆盖控制器、服务、Explorer 元数据、Explorer 领域逻辑和页面路由。

## API Explorer

!> `API Explorer` 是项目内置的本地调试工作台，默认入口为 `http://localhost:3200/explorer`，页面会自动从 `/explorer/metadata` 拉取接口元数据并生成调试表单。

### 主要能力

- 按 `GET` / `POST` 进行方法筛选。
- 通过接口名、分类和路径关键字快速搜索接口。
- 自动渲染路径参数、查询参数和 JSON Body 编辑区。
- 在 `Response` 面板查看最近一次请求结果。
- 在 `Logs` 面板查看当前会话内的请求日志、状态和错误信息。

### 功能截图

#### 整体预览

![Explorer 整体预览](./explorer-overview.png)

## API接口

!> koa2 接口说明(参数, 地址, 效果图)

## 新特性

### 支持自定义设置cookie

!> 2020-01-23 新增, 只需要配置 `config/user-info.js` 中的 `cookies` 字段就会在发送请求时带上你的 `cookies`。

#### 格式化自定义的 cookie

![normalize-cookie.png](https://raw.githubusercontent.com/Rain120/qq-music-api/master/screenshot/normalize-cookie.png)

### 特性提示支持

![new-feature-error-tips.png](https://raw.githubusercontent.com/Rain120/qq-music-api/master/screenshot/new-feature-error-tips.png)

### 获取 Cookie

!> 目前只支持用户自己从 *QQ音乐* 获取获取 `Cookie`, 如何获取 `Cookie`, 登录 `QQ音乐`, 然后 `F12`, 找到 `Network`, 随便找一个获取数据的接口, 复制接口中 `request headers` 中的 `Cookie` 即可。

接口说明: 调用此接口, 可获取自己在 `config/user-info.js` 配置的 `Cookie` 被格式化的结果

配置信息如下:

```
const userInfo = {
	loginUin: 'qq号码',
	cookie: '',
}
```

接口地址: `/getCookie`

调用例子: `/getCookie`

示例截图:

![normalize-cookie.png](https://raw.githubusercontent.com/Rain120/qq-music-api/master/screenshot/normalize-cookie.png)

### 获取QQ音乐产品的下载地址

接口说明: 调用此接口, 可获取QQ音乐标准产品下载链接

接口地址: `/downloadQQMusic`

调用例子: `/downloadQQMusic`

示例截图:

![获取QQ音乐产品的下载地址](https://raw.githubusercontent.com/Rain120/qq-music-api/master/screenshot/downloadQQMusic.png)

### 获取歌单分类

接口说明: 调用此接口, 可获取歌单分类, 包含`category`信息

接口地址: `/getSongListCategories`

调用例子: `/getSongListCategories`


<details>
  <summary>SortID</summary>

    sortId: 1, sortName: 默认
    sortId: 2, sortName: 最新
    sortId: 3, sortName: 最热
    sortId: 4, sortName: 评分
    sortId: 5, sortName: none
</details>

**歌单分类(categoryId & categoryName)**

<details>
  <summary>1. 热门</summary>

    1.1
      "categoryId": 10000000,
      "categoryName": 全部,
</details>

<details>
  <summary>2. 语种</summary>
  
    2.1
      "categoryId": 167,
      "categoryName": "英语",
    2.2
      "categoryId": 168,
      "categoryName": "韩语",
    2.3
      "categoryId": 166,
      "categoryName": "粤语",
    2.4
      "categoryId": 169,
      "categoryName": "日语",
    2.5
      "categoryId": 170,
      "categoryName": "小语种",
    2.6
      "categoryId": 203,
      "categoryName": "闽南语",
    2.7
      "categoryId": 204,
      "categoryName": "法语",
    2.8
      "categoryId": 205,
      "categoryName": "拉丁语",
</details>

<details>
  <summary>3. 流派</summary>

    3.1
      "categoryId": 6,
      "categoryName": "流行",
    3.2
      "categoryId": 15,
      "categoryName": "轻音乐",
    3.3
      "categoryId": 11,
      "categoryName": "摇滚",
    3.4
      "categoryId": 28,
      "categoryName": "民谣",
    3.5
      "categoryId": 8,
      "categoryName": "R&B",
    3.6
      "categoryId": 153,
      "categoryName": "嘻哈",
    3.7
      "categoryId": 24,
      "categoryName": "电子",
    3.8
      "categoryId": 27,
      "categoryName": "古典",
    3.9
      "categoryId": 18,
      "categoryName": "乡村",
    3.10
      "categoryId": 22,
      "categoryName": "蓝调",
    3.11
      "categoryId": 21,
      "categoryName": "爵士",
    3.12
      "categoryId": 164,
      "categoryName": "新世纪",
    3.13
      "categoryId": 25,
      "categoryName": "拉丁",
    3.14
      "categoryId": 218,
      "categoryName": "后摇",
    3.15
      "categoryId": 219,
      "categoryName": "中国传统",
    3.16
      "categoryId": 220,
      "categoryName": "世界音乐",
</details>

<details>
  <summary>4. 主题</summary>

    4.1
      "categoryId": 39,
      "categoryName": "ACG",
    4.2
      "categoryId": 136,
      "categoryName": "经典",
    4.3
      "categoryId": 146,
      "categoryName": "网络歌曲",
    4.4
      "categoryId": 133,
      "categoryName": "影视",
    4.5
      "categoryId": 141,
      "categoryName": "KTV热歌",
    4.6
      "categoryId": 131,
      "categoryName": "儿歌",
    4.7
      "categoryId": 145,
      "categoryName": "中国风",
    4.8
      "categoryId": 194,
      "categoryName": "古风",
    4.9
      "categoryId": 148,
      "categoryName": "情歌",
    4.10
      "categoryId": 196,
      "categoryName": "城市",
    4.11
      "categoryId": 197,
      "categoryName": "现场音乐",
    4.12
      "categoryId": 199,
      "categoryName": "背景音乐",
    4.13
      "categoryId": 200,
      "categoryName": "佛教音乐",
    4.14
      "categoryId": 201,
      "categoryName": "UP主",
    4.15
      "categoryId": 202,
      "categoryName": "乐器",
    4.16
      "categoryId": 14,
      "categoryName": "DJ",
</details>

<details>
  <summary>5. 心情</summary>

    5.1
      "categoryId": 52,
      "categoryName": "伤感",
    5.2
      "categoryId": 122,
      "categoryName": "安静",
    5.3
      "categoryId": 117,
      "categoryName": "快乐",
    5.4
      "categoryId": 116,
      "categoryName": "治愈",
    5.5
      "categoryId": 125,
      "categoryName": "励志",
    5.6
      "categoryId": 59,
      "categoryName": "甜蜜",
    5.7
      "categoryId": 55,
      "categoryName": "寂寞",
    5.8
      "categoryId": 126,
      "categoryName": "宣泄",
    5.9
      "categoryId": 68,
      "categoryName": "思念",
</details>

<details>
  <summary>6. 场景</summary>

    6.1
      "categoryId": 78,
      "categoryName": "睡前",
    6.2
      "categoryId": 102,
      "categoryName": "夜店",
    6.3
      "categoryId": 101,
      "categoryName": "学习",
    6.4
      "categoryId": 99,
      "categoryName": "运动",
    6.5
      "categoryId": 99,
      "categoryName": "运动",
    6.6
      "categoryId": 76,
      "categoryName": "约会",
    6.7
      "categoryId": 94,
      "categoryName": "工作",
    6.8
      "categoryId": 81,
      "categoryName": "旅行",
    6.9
      "categoryId": 103,
      "categoryName": "派对",
    6.10
      "categoryId": 222,
      "categoryName": "婚礼",
    6.11
      "categoryId": 223,
      "categoryName": "咖啡馆",
    6.12
      "categoryId": 224,
      "categoryName": "跳舞",
    6.13
      "categoryId": 16,
      "categoryName": "校园",
  </summary>
</details>

示例截图:

![获取歌单分类](https://raw.githubusercontent.com/Rain120/qq-music-api/master/screenshot/getSongListCategories.png)

### 获取歌单列表

接口说明: 调用此接口, 可获取歌单列表

参数列表:

- 必选参数

	- `categoryId`: 类别`id`, 详见 `/getSongListCategories`

- 可选参数

	- `page`: 当前页数, 默认为1

	- `limit`: 取出歌单数量, 默认为 20

	- `sortId`: 最新, 最热,评分,  默认为5

接口地址: `/getSongLists`

调用例子: `/getSongLists?categoryId=10000000`

示例截图:

**获取歌单列表**

![获取歌单列表](https://raw.githubusercontent.com/Rain120/qq-music-api/master/screenshot/getSongLists.png)

### 批量获取歌单列表

接口说明: 调用此接口, 可批量获取歌单列表

参数列表:

- 必选参数

	- `categoryIds`: 类别`id`列表, 详见 `/getSongListCategories`

- 可选参数

	- `page`: 当前页数, 默认为1

	- `limit`: 取出歌单数量, 默认为 20

	- `sortId`: 最新, 最热,评分,  默认为5

接口地址: `/batchGetSongLists`

调用例子: `/batchGetSongLists`

```body
{
  "limit": 19,
  "page": 0,
  "sortId": 5,
  "categoryIds": [167, 168]
}
```

示例截图:

**批量获取歌单列表**

![获取歌单列表](https://raw.githubusercontent.com/Rain120/qq-music-api/master/screenshot/batchGetSongLists.png)

**获取歌单列表-带参数**

![获取歌单列表-带参数](https://raw.githubusercontent.com/Rain120/qq-music-api/master/screenshot/getSongLists-params.png)

### 获取歌单详情

接口说明: 调用此接口, 可获取歌单详情

参数列表:

- 必选参数

	- `disstid`: 歌单`id`

接口地址: `/getSongListDetail`

调用例子: `/getSongListDetail?disstid=7011264340`

示例截图:

![获取歌单详情](https://raw.githubusercontent.com/Rain120/qq-music-api/master/screenshot/getSongListDetail.png)

### 获取MV标签

接口说明: 调用此接口, 可获取MV标签

接口地址: `/getMvByTag`

调用例子: `/getMvByTag`

示例截图:

![获取MV标签](https://raw.githubusercontent.com/Rain120/qq-music-api/master/screenshot/getMvByTag.png)

### 获取MV播放信息

接口说明: 调用此接口, 可获取MV播放信息

参数列表:

- 必选参数

	- `vid`: `video id`

接口地址: `/getMvPlay`

调用例子: `/getMvPlay?vid=u00222le4ox`

示例截图:

![获取MV播放信息](https://raw.githubusercontent.com/Rain120/qq-music-api/master/screenshot/getMvPlay.png)

### 获取歌手MV

接口说明: 调用此接口, 可获取歌手MV

参数列表:

- 必选参数

	- `singermid`: 歌手`id`

- 可选参数

	- `order`: 当前MV类型, 默认为`time`

		- `listen`: 歌手专辑音乐MV

		- `time`: 粉丝上传MV视频

	- `limit`: 取出歌单数量, 默认为5

接口地址: `/getSingerMV`

调用例子: `/getSingerMV?singermid=0025NhlN2yWrP4&order=all&limit=5`

示例截图:

![获取歌手MV - default](https://raw.githubusercontent.com/Rain120/qq-music-api/master/screenshot/getSingerMv-default.png)

![获取歌手MV - belong](https://raw.githubusercontent.com/Rain120/qq-music-api/master/screenshot/getSingerMv-listen.png)

![获取歌手MV - fans](https://raw.githubusercontent.com/Rain120/qq-music-api/master/screenshot/getSingerMv-time.png)

### 获取歌手热门歌曲

接口说明: 调用此接口, 可获取歌手热门歌曲

参数列表:

- 必选参数

	- `singermid`: 歌手`id`

- 可选参数

	- `page`: 页数, 默认为0

	- `limit`: 取出歌单数量, 默认为5

接口地址: `/getSingerHotsong`

调用例子: `/getSingerHotsong?singermid=0025NhlN2yWrP4&limit=10&page=2`

示例截图:

![获取歌手热门歌曲](https://raw.githubusercontent.com/Rain120/qq-music-api/master/screenshot/getSingerHotsong.png)

### 获取相似歌手

接口说明: 调用此接口, 可获取相似歌手

参数列表:

- 必选参数

	- `singermid`: 歌手`id`

接口地址: `/getSimilarSinger`

调用例子: `/getSimilarSinger?singermid=0025NhlN2yWrP4`

示例截图:

![获取相似歌手](https://raw.githubusercontent.com/Rain120/qq-music-api/master/screenshot/getSimilarSinger.png)

### 获取歌手信息

接口说明: 调用此接口, 可获取歌手信息

参数列表:

- 必选参数

	- `singermid`: 歌手`id`

接口地址: `/getSingerDesc`

调用例子: `/getSingerDesc?singermid=0025NhlN2yWrP4`

示例截图:

![获取歌手信息](https://raw.githubusercontent.com/Rain120/qq-music-api/master/screenshot/getSingerDesc.png)

### 获取歌手列表

接口说明: 调用此接口, 可获取歌手列表

参数列表:

- 可选参数

  <details>
    <summary>area 默认是 -100</summary>
    
        "id": -100,
        "name": "全部"
        "id": 200,
        "name": "内地"
        
        "id": 2,
        "name": "港台"
        
        "id": 5,
        "name": "欧美"
        
        "id": 4,
        "name": "日本"
        
        "id": 3,
        "name": "韩国"
        
        "id": 6,
        "name": "其他"
  </details>

  <details>
    <summary>genre 默认是 -100</summary>   

      "id": -100,
      "name": "全部"
      
      "id": 1,
      "name": "流行"
      
      "id": 6,
      "name": "嘻哈"
      
      "id": 2,
      "name": "摇滚"
      
      "id": 4,
      "name": "电子"
      
      "id": 3,
      "name": "民谣"
      
      "id": 8,
      "name": "R&B"
      
      "id": 10,
      "name": "民歌"
      
      "id": 9,
      "name": "轻音乐"
      
      "id": 5,
      "name": "爵士"
      
      "id": 14,
      "name": "古典"
      
      "id": 25,
      "name": "乡村"
      
      "id": 20,
      "name": "蓝调"
  </details>

  <details>
    <summary>index 默认是 -100</summary>

      "id": -100,
      "name": "热门"
      
      "id": 1,
      "name": "A"
      
      "id": 2,
      "name": "B"
      
      "id": 3,
      "name": "C"
      
      "id": 4,
      "name": "D"
      
      "id": 5,
      "name": "E"
      
      "id": 6,
      "name": "F"
      
      "id": 7,
      "name": "G"
      
      "id": 8,
      "name": "H"
      
      "id": 9,
      "name": "I"
      
      "id": 10,
      "name": "J"
      
      "id": 11,
      "name": "K"
      
      "id": 12,
      "name": "L"
      
      "id": 13,
      "name": "M"
      
      "id": 14,
      "name": "N"
      
      "id": 15,
      "name": "O"
      
      "id": 16,
      "name": "P"
      
      "id": 17,
      "name": "Q"
      
      "id": 18,
      "name": "R"
      
      "id": 19,
      "name": "S"
      
      "id": 20,
      "name": "T"
      
      "id": 21,
      "name": "U"
      
      "id": 22,
      "name": "V"
      
      "id": 23,
      "name": "W"
      
      "id": 24,
      "name": "X"
      
      "id": 25,
      "name": "Y"
      
      "id": 26,
      "name": "Z"
      
      "id": 27,
      "name": "#"
  </details>

  <details>
    <summary>sex 默认是 -100</summary>

      "id": -100,
      "name": "全部"
      
      "id": 0,
      "name": "男"
      
      "id": 1,
      "name": "女"
      
      "id": 2,
      "name": "组合"
  </details>

接口地址: `/getSingerList`

调用例子: `/getSingerList`
调用例子: `/getSingerList?area=200&sex=2&index=3&genre=2`

示例截图:

![获取歌手列表](https://raw.githubusercontent.com/Rain120/qq-music-api/master/screenshot/getSingerList.png)

### 获取歌手被关注数量信息

接口说明: 调用此接口, 可获取歌手被关注数量信息

参数列表:

- 必选参数

	- `singermid`: 歌手`id`

接口地址: `/getSingerStarNum`

调用例子: `/getSingerStarNum?singermid=0025NhlN2yWrP4`

示例截图:

![获取歌手被关注数量信息](https://raw.githubusercontent.com/Rain120/qq-music-api/master/screenshot/getSingerStarNum.png)

### 获取电台列表

接口说明: 调用此接口, 可获取电台列表, 分类

接口地址: `/getRadioLists`

调用例子: `/getRadioLists`

示例截图:

![获取电台列表](https://raw.githubusercontent.com/Rain120/qq-music-api/master/screenshot/getRadioLists.png)

### 获取专辑

接口说明: 调用此接口, 可获取专辑信息(专辑列表、详情)

参数列表:

- 必选参数

	- `albummid`: 专辑`id`

接口地址: `/getAlbumInfo`

调用例子: `/getAlbumInfo?albummid=0016l2F430zMux`

示例截图:

![获取专辑](https://raw.githubusercontent.com/Rain120/qq-music-api/master/screenshot/getAlbumInfo.png)

### 获取数字专辑

接口说明: 调用此接口, 可获取数字专辑, 轮播图`banner`, 专辑列表等信息, 详见[API结构图](#API结构图)

接口地址: `/getDigitalAlbumLists`

调用例子: `/getDigitalAlbumLists`

示例截图:

![获取数字专辑](https://raw.githubusercontent.com/Rain120/qq-music-api/master/screenshot/getDigitalAlbumLists.png)

### 获取歌曲歌词

接口说明: 调用此接口, 可获取歌曲歌词

参数列表:

- 必选参数

	- `songmid`: 专辑`id`

- 可选参数

	- `isFormat`: 是否格式化歌词, 默认值为 `false`

接口地址: `/getLyric`

调用例子: `/getLyric?songmid=003rJSwm3TechU`

示例截图:

![获取歌曲歌词 - 未格式化](https://raw.githubusercontent.com/Rain120/qq-music-api/master/screenshot/getLyric.png)

![获取歌曲歌词 - 格式化](https://raw.githubusercontent.com/Rain120/qq-music-api/master/screenshot/getLyric-parse.png)

### 获取MV

接口说明: 调用此接口, 可获取MV以及其Tag信息

参数列表:

- 必选参数

	- `area_id`: 区域`id`, 默认值为全部(15)

<details>
  <summary>Area</summary>

    "area": [
      {
        "id": 15,
        "name": "全部"
      },
      {
        "id": 16,
        "name": "内地"
      },
      {
        "id": 17,
        "name": "港台"
      },
      {
        "id": 18,
        "name": "欧美"
      },
      {
        "id": 19,
        "name": "韩国"
      },
      {
        "id": 20,
        "name": "日本"
      }
    ]
</details>

`version_id`: 版本`id`, 默认值为全部(7)

<details>
  <summary>Version</summary>

    "version": [
      {
        "id": 7,
        "name": "全部"
      },
      {
        "id": 8,
        "name": "MV"
      },
      {
        "id": 9,
        "name": "现场"
      },
      {
        "id": 10,
        "name": "翻唱"
      },
      {
        "id": 11,
        "name": "舞蹈"
      },
      {
        "id": 12,
        "name": "影视"
      },
      {
        "id": 13,
        "name": "综艺"
      },
      {
        "id": 14,
        "name": "儿歌"
      }
    ]
</details>

- 可选参数

	- `page`: 当前页数, 默认为1

	- `limit`: 取出歌单数量, 默认为 20

接口地址: `/getMv`

调用例子: `/getMv`

示例截图:

![获取MV](https://raw.githubusercontent.com/Rain120/qq-music-api/master/screenshot/getMv.png)

### 获取新碟信息

接口说明: 调用此接口, 可获取新碟信息

参数列表:

- 可选参数

	- `page`: 当前页数, 默认为 1

	- `limit`: 取出歌单数量, 默认为 20

接口地址: `/getNewDisks`

调用例子: `/getNewDisks`

示例截图:

![获取新碟信息](https://raw.githubusercontent.com/Rain120/qq-music-api/master/screenshot/getNewDisks.png)

### 获取歌手专辑

接口说明: 调用此接口, 可获取歌手专辑

参数列表:

- 必选参数

	- `singermid`: 歌手`id`

- 可选参数

	- `page`: 当前页数, 默认为1

	- `limit`: 取出歌单数量, 默认为 20

接口地址: `/getSingerAlbum`

调用例子: `/getSingerAlbum?singermid=0025NhlN2yWrP4`

示例截图:

![获取歌手专辑](https://raw.githubusercontent.com/Rain120/qq-music-api/master/screenshot/getSingerAlbum.png)

### 获取歌曲相关信息

接口说明: 调用此接口, 可获取歌曲相关信息

参数列表:

- 必选参数

	- `songmid`: 歌曲`id`

接口地址: `/getSongInfo`

调用例子: `/getSongInfo?songmid=0025NhlN2yWrP4`

示例截图:

![获取歌曲相关信息](https://raw.githubusercontent.com/Rain120/qq-music-api/master/screenshot/getSongInfo.png)

### 批量获取歌曲相关信息

接口说明: 调用此接口, 可批量获取歌曲相关信息

参数列表:

- 必选参数
```
songs: [
  [songmid, songid]
]
```

其中 `songid`可以不传

接口地址: `/batchGetSongInfo`

调用例子: `/batchGetSongInfo`

```body
{
  "songs": [
    ["001CLC7W2Gpz4J"],
    ["0025NhlN2yWrP4"]
  ]
}
```

示例截图:

![获取歌曲相关信息](https://raw.githubusercontent.com/Rain120/qq-music-api/master/screenshot/batchGetSongInfo.png)

### 获取歌曲播放链接

接口说明: 调用此接口, 可获取歌曲播放链接

参数列表:

- 必选参数

- `songmid`: 歌曲`id`, 多个播放链接使用 `,`分隔

- `resType`: 仅返回播放链接, 默认是 `play`。`[all | play]`

- `quality`: 播放品质, 默认是 128。`[m4a | 128 | 320 | ape | flac]`

- `mediaId`: 可选。使用歌曲详情中的 `file.media_mid`；当它与 `songmid` 不同时，QQ vkey filename 需要同时包含两者。

接口地址: `/getMusicPlay/:songmid`（仍兼容旧的 `?songmid=` query）

调用例子:

示例截图:

#### 获取单个播放链接

例子: `/getMusicPlay/0025NhlN2yWrP4`

![获取单个播放链接](https://raw.githubusercontent.com/Rain120/qq-music-api/master/screenshot/getMusicPlay.png)

#### 获取多个播放链接

例子: `/getMusicPlay/001yNIo41SJjuC,001wPuVc4ZiMhj?resType=play`

![获取多个歌曲播放链接](https://raw.githubusercontent.com/Rain120/qq-music-api/master/screenshot/just-get-play-url.png)

#### 获取多个播放链接

例子: `/getMusicPlay/001yNIo41SJjuC,001wPuVc4ZiMhj?resType=all`

![获取接口所有数据](https://raw.githubusercontent.com/Rain120/qq-music-api/master/screenshot/get-play-all-data.png)

#### 歌曲品质

例子: `/getMusicPlay/001yNIo41SJjuC?resType=play&quality=m4a`

扫码登录后，该接口会优先使用当前 `qqmusic_session` 对应的登录凭证取得音源。同源浏览器自动携带 HttpOnly cookie；跨来源 transport 可传 `cookie=qqmusic_session%3D<opaque-token>`，但不得记录或分享含该参数的完整 URL。没有 opaque session 时仍保留既有 legacy 行为。

![song-quality-128.png](https://raw.githubusercontent.com/Rain120/qq-music-api/master/screenshot/song-quality-128.png)

![song-quality-m4a.png](https://raw.githubusercontent.com/Rain120/qq-music-api/master/screenshot/song-quality-m4a.png)

### 获取搜索热词

接口说明: 调用此接口, 可获取搜索热词

接口地址: `/getHotkey`

调用例子: `/getHotkey`

示例截图:

![获取搜索热词](https://raw.githubusercontent.com/Rain120/qq-music-api/master/screenshot/gethotkey.png)

### 获取关键字搜索提示

接口说明: 调用此接口, 可获取获取关键字搜索提示

参数列表:

- 必选参数

	- `key`: 搜索关键字

接口地址: `/getSmartbox`

调用例子: `/getSmartbox?key=周杰伦`

示例截图:

![获取获取关键字搜索提示](https://raw.githubusercontent.com/Rain120/qq-music-api/master/screenshot/getSmartbox.png)

### 获取搜索结果

接口说明: 调用此接口, 可获取获取搜索结果

参数列表(部分参数待注释):

- 必选参数

	- `key`: 搜索关键字

	- ~~`catZhida`: 默认值为1~~

		~~1. `0` 表示歌曲~~

		~~2. `2` 表示歌手~~

		~~3. `3` 表示专辑~~

	- `remoteplace`: 默认值为 `song`

		1. 单曲: `song`

		2. 专辑: `album`

		3. MV: `mv`

		4. 歌单: `playlist`

		5. 用户: `user`

		6. 歌词: `lyric`

- 可选参数

	- `page`: 当前页数, 默认为 `1`

	- `limit`: 取出歌单数量, 默认为 `10`

接口地址: `/getSearchByKey`

调用例子: `/getSearchByKey?key=周杰伦`

示例截图:

![获取获取搜索结果](https://raw.githubusercontent.com/Rain120/qq-music-api/master/screenshot/getSearchByKey.png)

### 获取首页推荐

接口说明: 调用此接口, 可获取首页推荐

接口地址: `/getRecommend`

调用例子: `/getRecommend`

示例截图:

![获取首页推荐](https://raw.githubusercontent.com/Rain120/qq-music-api/master/screenshot/getRecommend.png)

### 获取排行榜单列表

接口说明: 调用此接口, 可获取排行榜单列表

- 可选参数

	- `page`: 当前页数, 默认为 `1`

	- `limit`: 取出歌单数量, 默认为 `10`

接口地址: `/getTopLists`

调用例子: `/getTopLists`

示例截图:

![获取排行榜单列表](https://raw.githubusercontent.com/Rain120/qq-music-api/master/screenshot/getTopLists.png)

### 获取排行榜单详情

接口说明: 调用此接口, 可获取排行榜单详情

- 可选参数

	- `topId`: 榜单`id`

	- `page`: 当前页数, 默认为1

	- `limit`: 取出歌单数量, 默认为 10

接口地址: `/getRanks`

调用例子: `/getRanks`

示例截图:

![获取排行榜单详情](https://raw.githubusercontent.com/Rain120/qq-music-api/master/screenshot/getRanks.png)

### 获取评论信息(cmd代表的意思没太弄明白)

接口说明: 调用此接口, 可获取评论信息

- 必选参数

	- `id`: 专辑或者歌单请求结果的`id`

- 可选参数

	- `rootcommentid`: 榜单`id`

	- `cid`: 

	- `pagenum`: 当前页数, 默认为 `0`

	- `pagesize`: 取出评论数量, 默认为 `25`

	- `cmd`: 

	- `reqtype`: 

	- `biztype`: 


接口地址: `/getComments`

调用例子: `/getComments?id=8220&rootcommentid=album_8220_1003310416_1558068713`

示例截图:

![获取评论信息 - id获取](https://raw.githubusercontent.com/Rain120/qq-music-api/master/screenshot/getComments-id.png)

![获取评论信息](https://raw.githubusercontent.com/Rain120/qq-music-api/master/screenshot/getComments.png)

![获取评论信息 - 带params](https://raw.githubusercontent.com/Rain120/qq-music-api/master/screenshot/getComments-param.png)

### 获取歌曲 + 专辑 图片

接口说明: 调用此接口, 可获取票务信息

- 必选参数

  - `id`: 专辑或者歌单请求结果的`id`

- 可选参数

  - `size`: 图片大小, 默认 `300x300`

  - `maxAge`: 图片过期时间, 默认 `12 mins = 2592000ms`

接口地址: `/getImageUrl`

调用例子: `/getImageUrl?id=000MkMni19ClKG` or `/getImageUrl?id=000MkMni19ClKG&size=500x500`

示例截图:

![获取歌曲id](https://raw.githubusercontent.com/Rain120/qq-music-api/master/screenshot/get-song-id.png)

![获取歌曲图片地址](https://raw.githubusercontent.com/Rain120/qq-music-api/master/screenshot/get-song-image.png)

![歌曲图片地址](https://raw.githubusercontent.com/Rain120/qq-music-api/master/screenshot/song-image.png)

![获取专辑id](https://raw.githubusercontent.com/Rain120/qq-music-api/master/screenshot/get-song-album-id.png)

![获取歌曲专辑地址](https://raw.githubusercontent.com/Rain120/qq-music-api/master/screenshot/get-album-image.png)

![歌曲专辑地址](https://raw.githubusercontent.com/Rain120/qq-music-api/master/screenshot/album-image.png)

### 获取票务信息

接口说明: 调用此接口, 可获取票务信息

接口地址: `/getTicketInfo`

调用例子: `/getTicketInfo`

示例截图:

![获取票务信息](https://raw.githubusercontent.com/Rain120/qq-music-api/master/screenshot/getTicketInfo.png)

### QQ 音乐原生扫码登录

扫码登录支持 QQ 音乐 App 与微信两条通道，直接返回上游 QR 图片，不需要服务器生成二维码。App 通道目前为 PNG，微信通道目前为 JPEG，调用方必须使用 data URL 自带的 MIME type。

| 接口 | 参数 | 返回 |
| --- | --- | --- |
| `/login/qr/key` | 可选 `channel=mobile\|wechat` | `data.unikey`，短期 QR 工作阶段 key |
| `/login/qr/create` | `key` | `data.qrimg`，MIME type 依上游图片嗅探 |
| `/login/qr/check` | `key` | `800` 过期/失败、`801` 等待、`802` 已扫描、`803` 已确认 |
| `/login/status` | cookie（浏览器自动携带） | `data.profile`；未登录时 `data` 为空 |
| `/user/detail` | cookie | 当前用户信息 |
| `/user/playlist` | 可选 `uid`、cookie | 自建和收藏歌单 |
| `/user/liked-songs` | 可选 `offset`、`limit`（最大 100）、cookie | 内建「我喜欢」歌曲分页 |
| `/user/albums` | 可选 `offset`、`limit`（最大 100，默认 20）、cookie | 收藏的专辑分页 |
| `/getMusicPlay/:songmid` | `quality`、cookie | 使用当前扫码登录态取得播放链接 |
| `/logout` | cookie | 清除当前登录态，并同步删除注入仓库中的记录 |

`qr/check` 成功时会设置 HttpOnly `qqmusic_session`，并在响应的 `cookie` 字段返回同一个 opaque session 值，供跨来源 transport 保存。该值不包含 QQ 音乐凭证；`musickey`、MQTT token 和 Android 装置上下文不会写入一般日志或响应。用户资料中的账号 ID 只会作为 profile 字段返回。

`/user/playlist` 分别读取自建项目与收藏歌单后合并去重。内建「我喜欢」集合的 `dirId: 201` 不是普通歌单 ID，`/user/liked-songs` 会使用登录凭证的 `encryptUin` 调用专用接口；调用方不得把 `201` 或其 `tid` 猜成通用 `disstid`。

`/user/albums` 不走 `musicu.fcg`，而是 `fav/fcgi-bin/fcg_get_profile_order_asset.fcg`（`reqtype=2`）。2026-08-08 实测：`music.musicasset.AlbumFavRead/CgiGetAlbumFavInfo` 存在但在任何入参与客户端标识下都返回 `80000` 与全零结构，即使账号已收藏专辑也一样，因此该码不能当成「没有数据」。这支 CGI 接受原生扫码凭证，其 `reqtype=3` 返回的收藏歌单与 musicu 完全一致，不带 cookie 时降为 `4000`。响应中的 `albumlist`／`totalalbum`／`has_more` 是上游拼写，控制器会改写成 `albums`／`total`／`more` 后再交给调用方；分页参数 `sin`／`ein` 是闭区间下标。

登录态播放沿用 auth 专用 `createAuthHttpClient` 调用 `musicu.fcg`，不会自行建立 axios client，也不会依赖或修改共用 `src/util/request.ts` 的全局 defaults。

服务只允许一个并行 QR。上游拒绝（包括安全数字码 `50006`）会保留为 `upstreamCode`，并返回 `retryAfterMs` / `Retry-After`，调用方应等待后重新出码。

#### 实际验收与故障诊断

2026-08-04 使用正式 auth service 完成真实扫码：`801 waiting → 802 scanned → 803 confirmed`；credential exchange 与 `GetLoginUserInfo` 均返回 HTTP 200 / code 0。测试账号返回了有效 profile，但上游昵称字段为空，调用方不应把昵称当作登录成功的唯一判断条件。

2026-08-05 的 G4 已确认：QQ Match Data 搜索正常、可用音源可以播放／快进／暂停，自动 QRC 歌词正常。部分歌曲的 320 → 128 fallback 均收到 HTTP 200、global code 0、module code 0，但 `purl` 为空；QQ 响应没有提供会员、地区或版权原因，因此服务只能描述为「上游未提供播放 URL」，不能把它命名为下架，也不能在会员与 IP 限制之间做确定判断。若需进一步排查，只收脱敏 response body；不得分享 `qqmusic_session`、完整音源 URL、curl 或 HAR。

本次 QIMEI 实际响应的安全结构如下，原值不得写入日志：

```json
{
  "code": 0,
  "data": "<JSON string>",
  "parsedData": {
    "code": 0,
    "data": {
      "q16": "<string, length 36>",
      "q36": "<string, length 36>"
    }
  }
}
```

因此 `QIMEI response missing q16/q36` 不能直接判断为上游格式变更。更新后应先确认 Node／Docker 已重启，再用上述结构化摘要检查外层与内层响应；但重启并不保证修复。

#### `-30002` 根因：全局 axios 默认值污染（2026-08-05 已修复）

2026-08-05 的 G3 复验中，正式 service 重启后收到 HTTP 200、outer code `-30002`、outer data `undefined`；而同环境的独立 probe（稳定装置与 fresh device）以及 production／probe request builder 与 HTTP client 的 2×2 交叉验证，全部取得 outer／inner code 0 与长度 36 的 q16／q36。差异不在装置、不在请求构造、也不在 HTTP client，而在**进程**：

- `src/util/request.ts` 当时在 import 阶段改写全局 `axios.defaults`，其中 `axios.defaults.headers.post['Content-Type']` 被设为 `application/x-www-form-urlencoded;charset=UTF-8;text/plain;`（供既有 y.qq.com／c.y.qq.com service 使用）。
- `createAuthHttpClient()` 内部的 `axios.create()` 会在**调用当下**快照全局默认值。
- 于是 auth client 是在该模块之前还是之后建立，纯粹由 `src/app.ts` 的 import 图决定。之后建立时，QIMEI 的 JSON body 被声明为 form-urlencoded，上游返回 HTTP 200、outer code `-30002` 且没有 `data`。

同一进程、同一分钟内用 loopback echo server 复现的对照：

```json
{"label":"client-created-before-util-request","sent":"application/json"}
{"label":"client-created-after-util-request","sent":"application/x-www-form-urlencoded;charset=UTF-8;text/plain;"}
```

这解释了独立 probe 为何总是成功（它从不 import `src/util/request.ts`）、为何重启无效（import 顺序是确定的）、以及为何 2026-08-04 通过而次日不通过（import 图变了）。

最初的修复在 auth 一侧：`services/auth/httpClient.ts` 每次请求都自行钉住 `Content-Type: application/json`（仅在带 body 时）与 `responseType: 'json'`，不再继承宿主默认值。针对 npm 包嵌入 Electron 或 Node 宿主的场景，`src/util/request.ts` 现在也使用包私有 Axios 实例保存旧版 QQ 请求默认值，导入本包不再改写宿主共享的 `axios.defaults`。`tests/services.auth-http-client.test.ts` 与 `tests/util.request.test.ts` 分别用 loopback echo server 验证 auth 请求契约和 legacy 请求隔离。`-30002` 仍只作为安全数字码保留，不赋予官方错误名称。

#### Android device context 与建立 session 前的退避

`services/auth/deviceContext.ts` 提供可注入、可测试且可配置存储位置的 device context repository：

| 项目 | 行为 |
| --- | --- |
| 默认路径 | `.auth-state/qq-device.json`（权限 0600，已 gitignore） |
| 覆盖路径 | 环境变量 `QQ_AUTH_STATE_PATH` |
| 关闭持久化 | `QQ_AUTH_STATE_PATH=memory` |
| 写盘失败 | 降级为进程内上下文，不阻断登录 |
| 存储内容 | 仅装置识别值与 device session；**不含 `musickey`、MQTT token 或任何用户凭证** |

QIMEI 与 device session 因此跨进程重启复用（重启后日志为 `source: 'restored'` 与 `qimei-result source: 'cache'`，不再重新注册装置）。多实例部署请各自指定 `QQ_AUTH_STATE_PATH`，不要共用同一份装置身份。

建立 QR session 之前的失败（QIMEI 或 GetSession）会套用指数退避：首次返回 502 + `Retry-After`，body 附安全数字码 `upstreamCode`；随后的请求返回 429，避免用户连点打出连续 500 或连续冲击上游。

日志只记录外层／内层 code、数据类型与 q16／q36 长度。不得硬读 probe 的 `test-results`，也不要记录 QIMEI、完整响应 body、QR ID、cookie、token、`musickey`、MQTT token 或 Android 装置值。

`GetSession.data.session.uid` 在真实响应中可能是数字，service 会将数字或字符串正规化为内部字符串；不要恢复为只接受字符串的解析方式。

auth session 默认仍使用进程内仓库，因此普通服务重启、水平扩容或请求落到另一个实例时不会共享登录态。可信嵌入方可在加载 npm 包后立即调用 `configureAuthSessionRepository({ kind, load, save })`：仓库保存的是 opaque token 对应的完整 credential、Android device 与 `expiresAt`，必须由宿主加密，不能进入 renderer、一般 JSON 文件或日志。恢复时会重新校验全部字段并丢弃超过 24 小时 TTL 的记录；仓库读取、解密或写入失败时降级为内存行为，不阻断重新扫码。

Folia 采用 Electron 主进程 `safeStorage` 加密后写入 `electron-store`；renderer 的 `localStorage` 继续只保存 opaque `qqmusic_session`。Linux 若只能使用 Electron 的 `basic_text` 后端则拒绝写入凭证，以免把 `musickey` 伪装成“已加密”状态。

#### 容器部署下的运行时约定

Folia 的 `folia-qq-api` 镜像用 `npm run build:js` 的 JavaScript 产物运行（`node dist/src/app.js`），不在容器里跑 `ts-node`：

| 项目 | 容器内取值 |
| --- | --- |
| 端口 | `PORT=3000`，只经 gateway 的 `/qq/` 暴露 |
| 装置状态 | `QQ_AUTH_STATE_PATH=/app/.auth-state/qq-device.json`，挂具名卷 |
| 根文件系统 | 只读；`/tmp` 为 tmpfs，装置状态卷是唯一可写路径 |
| 运行用户 | `node`（非 root），`no-new-privileges` |
| 健康检查 | `GET /login/status`，只读进程内会话状态，不会建立 QR 或注册装置 |

因为运行时是 `--omit=dev` 安装，`src/` 里 import 的每个包都必须在 `dependencies`；`tests/runtime.dependencies.test.ts` 会在这条约束被破坏时失败。装置状态卷被删除后下次启动会重新注册装置，属于预期行为。
