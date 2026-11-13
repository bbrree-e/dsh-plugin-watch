# 插件版本体检（dsh-plugin-watch）

给 DeepSeek Harness 用的小插件：每天核对一次各个配置里装的插件有没有新版本，
在 **设置 → 插件 → 版本** 里一眼看出版本状态，还能一键更新。

## 做什么

- **每天一次**核对：启动时如果距上次超过 22 小时就补一次，之后每小时醒一次。
- **自动认新插件**：每次体检都重新读 profile 的 `package.json`，新装的下次自动出现，不需要改代码。
- **版本来源**：npm 装的比 registry 的 `latest`；GitHub 装的（`github:` / `git+https://…`）比仓库 `main`（或 `master`）分支的 `package.json`。
- **一键更新**：每个有新版本的行尾有「更新」按钮，装完下次开客户端生效。
- **带闸自动安装**：只在凌晨 4–6 点、一天最多一次、只装补丁号变化、只装 npm 来源；装前备份配置；**不自动重启**。

## 状态怎么读

| 状态 | 意思 |
|---|---|
| 已是最新 | 已装版本 ≥ 远端最新版 |
| 有新版本 | 远端有更新的版本 |
| 没装上 | 依赖里写着，但 `node_modules` 找不到 |
| 查询失败 | 网络或 registry 出问题 |
| 查不到 | 远端没给出可用版本号 |
| 本地目录 | `link:` / `file:` 装的，没有远端可比 |

## 它不做什么

- 不自动重启客户端。
- 不判断版本兼容性，也不看 changelog。
- 主次版本号变了（比如 1.5.6 → 1.6.0）、或者来自 GitHub 的，只提醒不自动装。

## 装法

把整个目录放进工作区，在 DSH 里让插件管理器安装这个本地目录即可（它会写进 profile 的依赖里）。

## 数据

- 报告缓存在 `~/.dsh/plugin-watch/report.json`
- 自动安装记录和历史：`auto.json`、`history.json`
- 装之前的备份：`~/.dsh/plugin-watch/backup/<时间>-<配置名>/`

## 接口

- `GET  /dsh-plugin-watch/status` — 读缓存结果（含计划与历史）
- `POST /dsh-plugin-watch/refresh` — 立刻体检一次
- `POST /dsh-plugin-watch/update` — 装某一个插件，`{ profile, name, version }`

## 结构

```
index.js           宿主半边：体检、版本比对、自动安装、路由
client.js          网页半边：「设置 → 插件 → 版本」分页
cordis.patch.yml   插件注册
locale/*.json      插件列表里的标题和说明
docs/DETAIL.md     插件详情页
icon.svg           图标
```

## 许可

MIT，见 [LICENSE](LICENSE)。
