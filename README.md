# loon-chsi-patch

Loon 插件集合，用于**定位并改写**学信网链路里出现的毕业时间字段。

设计前提是**认证以客户端截图上传为准**：判定点在你手机屏幕上，所以改写目标是「让渲染后的页面显示成想要的样子」。

这意味着**只需要 MitM 学信网域名，支付宝自己的流量不用碰** —— 插件的 `[Mitm]` 已去掉 alipay 相关 hostname，也就不存在支付宝那边「请关闭 VPN」的拦截。

两个插件配套使用：先嗅探确认真实接口与字段名，再开改写。

```
Loon/Plugin/
├── chsi-sniffer.plugin          只记录不改写
└── chsi-graduate-date.plugin    改写毕业时间（面向截图）
scripts/
├── chsi_sniffer.js
└── chsi_patch.js
frida/
└── vpn_detect_bypass.js         越狱设备绕过 VPN/代理环境检测
tests/
└── run_local_tests.js
```

## 前置：MitM 证书

插件能不能生效，**完全取决于 MitM 能不能解密**。这一步没做对，后面全部白搭。

1. Loon → 配置 → MitM → 生成 CA 证书 → 安装到系统
2. iOS：**设置 → 通用 → 关于本机 → 证书信任设置 → 打开完全信任**
3. Loon → MitM → 开启「HTTP 解密」，主机名列表要包含插件声明的 hostname

只装描述文件不开「完全信任」，所有 HTTPS 直接 `-1202`。

## 前置：App 提示「请关闭 VPN」

MitM 必须接管流量，iOS 上接管流量只能靠 VPN（NEPacketTunnelProvider），所以这个提示躲不开，只能绕过检测。

常见检测面与对策：

| 检测面 | 表现 | 对策 |
|---|---|---|
| `getifaddrs` 枚举到 `utun` | 最常见 | Loon 切 HTTP Proxy 模式；或 Frida 摘掉节点 |
| `sysctl` 读路由表 | 配合上一条 | Frida 屏蔽 `NET_RT_*` 查询 |
| `CFNetworkCopySystemProxySettings` | 暴露 WiFi 手动代理 | 别在系统 WiFi 里配代理 |
| `NEVPNManager` / `NEVPNConnection.status` | 读连接状态 | Frida 改返回值 |
| 出口 IP 归属变化 | 服务端侧判定 | 目标域名必须 `DIRECT`，见下 |

按顺序试：

**① 先切代理模式。** Loon 支持 `tun` / `http` / `mix`，纯 HTTP Proxy 模式不创建 `utun` 接口，能避开最常见的接口枚举检测：

```
loon://proxymode=http      切到纯 HTTP Proxy
loon://proxymode=mix       HTTP Proxy + TUN
loon://proxymode=tun       TUN Only
```

**② 别在系统 WiFi 里填代理。** 设置 → 无线局域网 → 配置代理，这个是最容易被读到的痕迹。Loon 自己接管即可。

**③ 确认出口 IP 没变。** 插件已声明 `DOMAIN-SUFFIX,chsi.com.cn,DIRECT` 与 `DOMAIN-SUFFIX,alipay.com,DIRECT`。若这些域名走了代理节点，服务端会看到异地 IP，那是另一层风控。

**④ 上 Frida。** 越狱设备注入 `frida/vpn_detect_bypass.js`：

```bash
frida -U -f <BUNDLE_ID> -l frida/vpn_detect_bypass.js --no-pause
```

脚本 hook 了 `getifaddrs`（摘掉 `utun/tun/ppp/ipsec` 节点）、`sysctl`（屏蔽路由表查询）、`CFNetworkCopySystemProxySettings` 与 `SCDynamicStoreCopyProxySettings`（抹掉代理键）、`NEVPNConnection.status`（伪装 Disconnected）、以及 `/proc/net/*` 读取。

**⑤ 换工具层。** 若目标是学信网 WebView 而非支付宝原生报文，可以不 MitM 支付宝：`$httpClient` 走 Loon 直连学信网取数据，或在 WebView 侧注入。这样支付宝全程不经过解密。

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

## 插件二：学信网毕业时间改写（面向截图）

三条改写通道：

| 通道 | 时机 | 作用 |
|---|---|---|
| A. 响应层 JSON | 数据到达时 | 递归改命中键名的值 |
| B. 响应层 HTML | 数据到达时 | 替换内联 JSON 串值 |
| C. 页面层 DOM | 页面渲染后 | 改文本节点、`input` 值、框架 state |

**截图场景 C 通道才是主力**，因为很多值是前端异步渲染后才写进 DOM 的，只改原始 HTML 会漏。

参数：

| 参数 | 默认 | 说明 |
|---|---|---|
| 启用改写 | `true` | 总开关 |
| URL 关键字 | `chsi` | 命中哪些请求 |
| 目标毕业时间 | 空 | 整串替换值，如 `2028-06-30` |
| **年份偏移** | `4` | **只换年份保留格式**，优先于上一项 |
| 标签改写对 | 空 | 格式 `标签=值\|\|标签=值`，改标签相邻的单元格 |
| 额外字段键名 | 空 | 英文逗号分隔，追加到内置键表 |
| 额外标签词 | 空 | 英文逗号分隔，判定哪些文本算毕业相关 |
| 激进模式 | `false` | 不限标签改所有日期，会误伤 |
| HTML 改写 | `true` | **截图场景必须开** |
| 观察时长秒 | `600` | 注入脚本持续改写的秒数，要覆盖到截图完成 |

### 为什么默认用年份偏移

整串替换会把 `2024年6月30日` 改成 `2028-06-30` —— 格式突变，截图里一眼假。

年份偏移只动年份：`2024年6月30日` → `2028年6月30日`，`2024-06-30` → `2028-06-30`，原格式完整保留。

### 标签改写对

学信网页面大量是「标签 + 相邻单元格」的表格结构，标签本身不含日期，改日期键名碰不到它。用 `pairs` 按标签定位：

```
学籍状态=在读||学制=4||毕业时间=2028年6月30日
```

脚本会找到标签元素，取它后面的兄弟单元格写入。

### 观察时长

学信网页面常异步加载。注入脚本带 `MutationObserver`，持续扫描直到超时。默认 600 秒足够覆盖从进页面到截完图的全过程；如果截图前停留很久，调大。

内置键名表：`byrq` `graduationDate` `graduateDate` `graduation` `graduate` `endDate` `endTime` `byTime` `graduateTime` `xxjsrq` `jssz` `jssj` `xjsj` `bysj` `finishDate` `expectedGraduationDate` 毕业时间 毕业年月 预计毕业时间

内置标签词：毕业时间 毕业年月 预计毕业 结业时间 学籍状态 入学年月 入学时间 学制

手动执行 **「参数自检」** 会在日志里打印当前配置并跑一遍样例（含中文格式 `2028年6月30日`），确认改写逻辑生效再上真机。

## 截完图要看什么

截图提交前自己先核对，这几处最容易露馅：

- **格式一致性** —— 页面上其他日期是不是同格式。用年份偏移而非整串替换可避免
- **学籍状态** —— 改了毕业时间但状态还写着「已毕业」，前后矛盾。用 `pairs` 一起改
- **入学年月与学制的算术** —— 入学 `2020` + 学制 `4` 应得毕业 `2024`。改了毕业年份后这条算术对不上，肉眼可查
- **页面顶部姓名与证件号** —— 必须与实名一致，改了必被二次核验抓到
- **截图元数据** —— 状态栏时间、运营商、电量。页面改得再真，这些也得看着合理

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

## 本地测试

仓库带了一个 mock 运行时，注入 Loon 的全局对象后直接跑脚本，不需要真机：

```bash
node tests/run_local_tests.js
```

覆盖年份偏移（含中文格式保留与负偏移）、gradDate 回退、JSON 递归改写、HTML 内联替换与注入配置、标签改写对解析、激进模式、URL 未命中跳过、二进制 Body 跳过、参数自检、嗅探记录与键名提取，共 29 项。

改脚本后重跑一遍再推仓库。

## 要求

Loon **3.5.1 (983)+**（插件参数、`script(...)` 新语法均需此版本）。

## 关于能改到什么

既然认证以客户端截图为准，判定点就在你手机屏幕上，页面改对了即可。但这张图要经得起看：

| 检查项 | 客户端能做到 | 备注 |
|---|---|---|
| 毕业时间字段 | 是 | 年份偏移保格式 |
| 学籍状态等标签字段 | 是 | 用 `pairs` |
| 姓名 / 证件号 | **不建议动** | 必须与实名一致，改了必被抓 |
| 入学年月与学制的算术自洽 | 需手工核对 | 改了毕业年份后容易前后矛盾 |
| 截图元数据（时间/运营商/电量） | 客户端无关 | 页面再真，这些也得合理 |

页面本身的字段改写，插件已经做完。剩下那几项是**提交前自己核对**的事——工具帮不上，看的是你细不细。

若后续发现认证结果其实由服务端下发（而非截图判定），插件仍然可用（A/B 通道改接口数据），但那时生效点就不在客户端了。先用嗅探插件确认一次。

自建 fixture（本地 mock 服务端 + 自签 CA）先跑通整条链路，是验证改写逻辑正确性最快的办法。
