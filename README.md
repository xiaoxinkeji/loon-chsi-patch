# loon-chsi-patch

Loon 插件集合，用于**定位并改写**学信网/支付宝链路里出现的毕业时间字段。

两个插件配套使用：先嗅探确认真实接口与字段名，再开改写。

```
Loon/Plugin/
├── chsi-sniffer.plugin          只记录不改写
└── chsi-graduate-date.plugin    改写毕业时间
scripts/
├── chsi_sniffer.js
└── chsi_patch.js
```

## 前置：MitM 证书

插件能不能生效，**完全取决于 MitM 能不能解密**。这一步没做对，后面全部白搭。

1. Loon → 配置 → MitM → 生成 CA 证书 → 安装到系统
2. iOS：**设置 → 通用 → 关于本机 → 证书信任设置 → 打开完全信任**
3. Loon → MitM → 开启「HTTP 解密」，主机名列表要包含插件声明的 hostname

只装描述文件不开「完全信任」，所有 HTTPS 直接 `-1202`。

## 插件一：学信网流量嗅探

先跑它。作用是把命中的请求记下来，用来回答三个问题：

- 学信网页面到底请求了哪些接口
- 响应是不是明文 JSON / HTML
- 毕业时间的真实字段名长什么样

参数：

| 参数 | 默认 | 说明 |
|---|---|---|
| URL 关键字 | `chsi` | 命中哪些请求，普通关键字或正则源文本 |
| 片段长度 | `600` | 每条记录保留的正文字符数 |
| 保留条数 | `30` | 超出丢弃最旧的 |

查看结果：插件页手动执行 **「导出嗅探结果」**，记录会复制到剪贴板 + 打印到日志。

`dateKeys` 一栏是脚本从正文里挖出来的 `键名 = 日期` 配对，直接抄进改写插件的「额外字段键名」。

## 插件二：学信网毕业时间改写

参数：

| 参数 | 默认 | 说明 |
|---|---|---|
| 启用改写 | `true` | 总开关 |
| URL 关键字 | `chsi` | 命中哪些请求 |
| 目标毕业时间 | `2028-06-30` | 写回的日期串，**格式要与页面一致** |
| 额外字段键名 | 空 | 英文逗号分隔，追加到内置键表 |
| 激进模式 | `false` | 把所有 `YYYY-MM-DD` 一并替换，会误伤 |
| HTML 改写 | `true` | 替换内联 JSON 串值 + 注入 DOM 改写脚本 |
| 改写后通知 | `true` | 系统通知报告替换处数 |
| 调试日志 | `false` | 打印每次命中的详情 |

改写按 Content-Type 分流：

| 类型 | 策略 |
|---|---|
| `json` | 递归遍历改键名命中项；解析失败退回内联串值替换 |
| `html` | 内联 JSON 串值替换 → 注入 DOM 脚本（含 MutationObserver，兜住前端渲染后再写入的值） |
| 其他 | JSON 试解析 → 内联替换 → 激进模式下做日期正则替换 |

内置键名表：`byrq` `graduationDate` `graduateDate` `graduation` `graduate` `endDate` `endTime` `byTime` `graduateTime` `xxjsrq` `jssj` `xjsj` `bysj` `finishDate` `expectedGraduationDate` 毕业时间 毕业年月 预计毕业时间

手动执行 **「参数自检」** 会在日志里打印当前配置并跑一遍样例 JSON + HTML，确认改写逻辑生效再上真机。

## 安装

```
https://raw.githubusercontent.com/xiaoxinkeji/loon-chsi-patch/main/Loon/Plugin/chsi-sniffer.plugin
https://raw.githubusercontent.com/xiaoxinkeji/loon-chsi-patch/main/Loon/Plugin/chsi-graduate-date.plugin
```

Loon → 配置 → 插件 → 右上角 `+` → URL 导入。

也可以用主配置 `[Plugin]` 引用：

```
[Plugin]
https://raw.githubusercontent.com/xiaoxinkeji/loon-chsi-patch/main/Loon/Plugin/chsi-sniffer.plugin, tag=学信网流量嗅探, enabled=true
https://raw.githubusercontent.com/xiaoxinkeji/loon-chsi-patch/main/Loon/Plugin/chsi-graduate-date.plugin, tag=学信网毕业时间改写, enabled=true
```

## 要求

Loon **3.5.1 (983)+**（插件参数、`script(...)` 新语法均需此版本）。

## 关于能改到什么

这条链路的可行边界，说清楚比含糊过去有用：

| 层 | 客户端可见 | 备注 |
|---|---|---|
| 学信网 WebView 页面渲染 | 是 | 明文 HTML/JSON，可改 |
| 学信网接口响应 | 是（若未业务加密） | 可改 |
| 支付宝 mPaaS 业务报文 | 通常否 | 会话密钥二次加密，Loon 拆不开 |
| 服务端权威学籍判定 | 否 | 实名/学籍库/人脸，服务端对服务端 |

**客户端能改到的只有「你手机上显示什么」。** 学历核验的生效点在服务端，客户端改写不改变服务端拿到的真实学籍数据。若认证确实依赖客户端截图上传，改截图内容技术上成立，但截图会与服务端二次核验的真实数据对不上。

自建 fixture（本地 mock 服务端 + 自签 CA）先跑通整条链路，是验证改写逻辑正确性最快的办法。
