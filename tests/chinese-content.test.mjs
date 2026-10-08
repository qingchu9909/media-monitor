import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { chineseContent, isMissingSummary, isReadableChinese, useChineseContent } from '../src/chinese-content.js';

const article = extra => ({ id: 'video-guide', url: 'https://example.org/video-guide', title: 'New video editing workflow', summary: 'This guide explains how creators can edit and export their video projects.', ...extra });
const translated = extra => ({ status: 'ready', titleZh: '视频剪辑与导出工作流', summaryZh: '这份指南介绍创作者如何剪辑视频并导出作品。', ...extra });

test('a Chinese tag or long Chinese prefix cannot expose an English paragraph in default content', () => {
  for (const summary of ['中文 This guide explains how creators can edit and export their video projects.', `${'中文说明。'.repeat(30)} This guide explains how creators can edit and export their video projects.`]) {
    assert.equal(isReadableChinese(summary), false);
    const out = chineseContent(article({ title: '中文视频工作流', summary }));
    assert.equal(out.isReadable, false);
    assert.equal(out.needsTranslation, true);
    assert.equal(out.summary, '');
  }
});

test('title and summary each need readable Chinese even when a cache or editorial label says ready', () => {
  const input = article();
  for (const value of [translated({ summaryZh: input.summary }), translated({ titleZh: input.title }), translated({ summaryZh: '' })]) {
    const out = chineseContent({ ...input, translation: value });
    assert.equal(out.needsTranslation, true);
    assert.equal(out.isReadable, false);
    assert.notEqual(out.title, input.title);
    assert.notEqual(out.summary, input.summary);
  }
  const partial = chineseContent({ ...input, analysis: { titleZh: '已经写好的中文选题标题', summaryZh: input.summary } });
  assert.equal(partial.needsTranslation, true);
  assert.equal(partial.summary, '');
});

test('changed source fields invalidate cached Chinese instead of displaying an old translation', () => {
  const input = article();
  const cached = translated({ originalTitle: input.title, originalSummary: input.summary, originalContent: '' });
  assert.equal(chineseContent(input, { [input.url]: cached }).isReadable, true);
  const changed = chineseContent({ ...input, summary: 'A different version of the guide.' }, { [input.url]: cached });
  assert.equal(changed.isReadable, false);
  assert.equal(changed.translationReason, 'source-changed');
  assert.equal(changed.summary, '');
});

test('RSS link placeholders are missing evidence, not successful Chinese summaries', () => {
  for (const summary of ['', '点击查看原文>', 'Read more...', 'https://example.org/article']) {
    assert.equal(isMissingSummary(summary), true);
    const out = chineseContent(article({ title: '视频编辑的新用法', summary }));
    assert.equal(out.summaryMissing, true);
    assert.equal(out.isReadable, false);
    assert.equal(out.needsTranslation, false);
    assert.equal(out.kind, 'incomplete');
    assert.equal(out.summary, '来源未提供有效摘要，可打开原文查看。');
  }
});

test('default hook rendering retains Chinese title and full Chinese summary without source-language fallback', () => {
  const input = article({ translation: translated({ summaryZh: '这份指南介绍创作者如何剪辑视频并导出作品。'.repeat(6) }) });
  function Probe() {
    const out = useChineseContent(input);
    return React.createElement('article', null, React.createElement('h3', null, out.title), React.createElement('p', { className: 'expanded' }, out.summary));
  }
  const html = renderToStaticMarkup(React.createElement(Probe));
  assert.match(html, /视频剪辑与导出工作流/);
  assert.doesNotMatch(html, /This guide|New video/);
  assert.equal((html.match(/导出作品/g) || []).length, 6);
});

test('product names remain usable in natural Chinese and research evidence never acquires a factuality badge', () => {
  assert.equal(isReadableChinese('OpenAI 发布面向开发者的新工具'), true);
  const input = article({ research: { titleZh: '公开网页的视频指南', summaryZh: '网页介绍了视频编辑的工作流程。', verification: 'original-page' } });
  const out = chineseContent(input);
  assert.equal(out.kind, 'research');
  assert.equal(out.isReadable, true);
  assert.equal(out.verified, undefined);
});

test('Reddit navigation-only summaries remain explicitly missing in the Chinese display', () => {
  for (const summary of [
    'submitted by /u/robomar_ai_art [link] [comments]',
    'submitted by /u/iiTzMYUNG [link] [comments]',
    'https://preview.redd.it/video.png submitted by /u/author [link] [comments]',
    '<p>submitted by <a href="https://reddit.com/u/author">/u/author</a> [link] [comments]</p>',
  ]) {
    assert.equal(isMissingSummary(summary), true);
    const out = chineseContent(article({ summary, translation: translated({ summaryZh: '来源未提供有效摘要，可打开原文查看。' }) }));
    assert.equal(out.summaryMissing, true);
    assert.equal(out.isReadable, false);
    assert.equal(out.needsTranslation, false);
    assert.equal(out.summary, '来源未提供有效摘要，可打开原文查看。');
  }
  assert.equal(isMissingSummary('Minimax H3 all local 5060 Ti 64gb ram submitted by /u/apoke890 [link] [comments]'), false);
  assert.equal(isMissingSummary('The author describes a video editing method. submitted by /u/author [link] [comments]'), false);
});
