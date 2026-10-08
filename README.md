# 晴初 · 媒体观察

本地中文 AI 资讯与选题工作台。收集公开 RSS/Atom，保留原文和发布时间，用已登录的 Codex CLI 整理中文摘要、推荐理由、创作角度与口播开头。

适合关注 AI 视频、短剧、配音剪辑、Agent 和开源工具的创作者。源码使用 MIT 许可证；第三方依赖各自保留许可证。

## 功能

- 17 个默认免费 RSS/Atom 来源，可添加、暂停、归档和恢复。
- 按主题阅读、收藏、中文标题与摘要缓存、相似报道去重。
- 今日机会与继续跟进：同一 URL 不跨日重复推荐，保留真实发布日期。
- JSON 与 Markdown 简报；基于来源生成可预览、采用的中文草稿。
- 后台任务进度、取消、失败保留已有成果、站内通知。
- 将 Codex 主动公开网页研究导入同一资料库，并保留证据与覆盖限制。

## 快速开始

需要 Node.js 24+、npm 和联网环境。中文整理及草稿需要可用的 Codex CLI 与 ChatGPT 登录；仅收集 RSS 和规则报告无需模型。

```sh
git clone https://github.com/qingchu9909/media-monitor.git
cd media-monitor
npm ci
npm run build
npm start
```

打开 <http://127.0.0.1:4318/>。默认绑定本机地址，面向单机使用。

## 配置 Codex

确认命令可用并完成你自己的账号登录：

```sh
codex --version
codex login
codex login status
```

后台从 PATH 查找 `codex`。如果装在其它位置，启动时指定绝对路径：

```sh
MEDIA_MONITOR_CODEX=/absolute/path/to/codex npm start
```

网页“运行与通知”会显示实际能力和错误。安装 Codex App 不代表后台一定能找到 CLI；`未找到 Codex CLI` 时应检查可执行路径。CLI 版本还须支持 `server/codex-runner.mjs` 使用的结构化输出及执行选项。模型仍联网，受账号可用额度和服务限制约束。

## 日常使用

网页点“更新并生成选题”，或运行：

```sh
npm run refresh
```

流程：固定免费来源采集 → 中文转换 → 读取候选证据 → Codex 分析 → 保存简报与站内通知。一次提交后等待终态，遇到超时先在“运行与通知”确认已有任务。

网页按钮只刷新固定来源和已有资料。主动搜索需要在 Codex 中打开本项目，要求它依照 [免费研究流程](docs/free-research.md) 搜索公开网页、核对原文、保存 schemaVersion 1 输入，再执行：

```sh
npm run research:import -- data/research-input/example.json
npm run refresh
```

`example.json` 是你准备的实际研究文件，不随仓库附带。简报合同见 [格式说明](docs/brief-format.md)。

其它命令：

```sh
npm run collect                    # 仅采集免费 RSS
npm run report -- --out data/reports/latest.md
npm run status
npm test
npm run build
```

开发：先运行 `npm start` 提供 API，另开终端运行 `npm run dev`。Vite 将 `/api` 转发到 4318。

## 费用、数据与边界

公开 RSS 和网页研究不依赖 AIsa。Codex 使用你已有账号的可用额度，不代表无限或离线模型。

代码保留可选的历史 AIsa 适配器，`npm ci` 会安装其 CLI 依赖；普通 `refresh` 不执行付费 X 请求。无需登录、充值或订阅 AIsa 即可使用免费路线。不要把源码中的可选接入误认为已采集数据或免费云模型。

引文命中只证明来源写过。厂商效果和社区经验需要另行实测；中文翻译与选题建议不等于事实已独立核实。未知发布时间、互动数保持未知，不生成虚构 X 热度。

所有数据库、研究材料、草稿与简报保存在本机 `data/`，默认不提交 Git。通知默认为站内通知，没有配置手机、邮件或社交平台推送，也不会自动发布内容。电脑关机、睡眠、网络或额度不可用时无法保证定时采集。

## macOS 后台服务与定时任务

```sh
npm run service:start
npm run service:status
npm run service:stop
```

这些命令注册当前目录的登录后常驻服务，日志在 `.runtime/`。同名服务若属于另一目录会拒绝覆盖。服务注册时保存 PATH；确保该 PATH 可找到 Codex。`service:stop` 停止本次服务，下次登录仍可能自启；取消登录自启需移出 `~/Library/LaunchAgents/com.qingchu.media-monitor.plist`。

每日 Codex 自动化需要在自己的 Codex App 中另行配置。本仓库不会创建计划任务或复制作者账号设置，也没有部署全天候服务器。其它系统使用 `npm start`，macOS 服务脚本不适用。

## 开源快照

此次开源包含应用源码、测试与通用使用文档，未包含作者本机数据库、草稿、凭据、运行日志及旧提交历史。原作者机器近期存在后台找不到 Codex CLI 的故障；它不影响 RSS 采集，中文整理需要先完成以上配置。测试和构建通过不代表你的账号、网络或全部来源已验证。

贡献前请阅读 [CONTRIBUTING.md](CONTRIBUTING.md)。安全问题请按 [SECURITY.md](SECURITY.md) 处理，第三方组件见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
