# 网站中文简报格式

写入 `data/briefs/YYYY-MM-DD.json`。只记录实际核验过的内容；网站首页自动读取最新可用日期，历史日期可以切换。不是把 RSS 标题替换成假中文，也不是对全历史自动翻译。

```json
{
  "date": "2026-09-12",
  "title": "今天值得关注的内容",
  "generatedAt": "2026-09-12T04:00:00.000Z",
  "status": "reviewed",
  "generationMethod": "Codex 核对原文后整理",
  "summary": "当日简洁综述",
  "highlights": [{
    "url": "https://example.com/article",
    "titleZh": "中文标题",
    "summaryZh": "原文能够支持的事实摘要",
    "whyItMatters": "编辑判断：为什么值得关注",
    "sourceName": "来源名称",
    "publishedAt": "2026-09-12T02:00:00.000Z",
    "firstRecommendedDate": "2026-09-12",
    "newToBrief": true
  }],
  "ideas": [{
    "title": "可以做的选题",
    "angle": "具体创作角度，属于建议",
    "hook": "可直接修改使用的口播开头",
    "sourceUrls": ["https://example.com/article"]
  }],
  "coverage": ["本次成功来源及时间范围"],
  "caveats": ["未覆盖来源、未确认事实、厂商宣传等限制"]
}
```

示例 URL 仅解释格式，不能直接写进真实简报。高亮必须引用本机数据库的规范原始 URL，以便卡片关联。未知发布时间使用 `null`；已知未来日期或窗口外内容不纳入当日热点。没有互动数据不生成热度分。可同时保存 Markdown 到 `data/reports/YYYY-MM-DD-brief.md`。

接口：`GET /api/briefs` 列表；`GET /api/briefs/:date` 详情与 Markdown；`GET /api/state` 附 `analysisByUrl` 和 `latestBrief`。不存在简报时明确空态，不回退为假生成结果。

`firstRecommendedDate` 是该原始 URL 首次出现在已保存日简报中的日期，`newToBrief` 表示是否在本日首次入选；这两个字段不代替 `publishedAt`。页面默认展示本日新增，往日已推荐的条目放在“继续跟进”，下载文稿也逐条标明。旧简报缺少这两个字段时，由已有更早日期的日简报推导，不读取历史备份子目录，也不把阅读或收藏动作当作推荐日期。
