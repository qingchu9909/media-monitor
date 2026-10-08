import test from 'node:test';
import assert from 'node:assert/strict';
import { freeSourceAdditions, sourceCatalogEntries } from '../server/source-catalog.mjs';
import { validatePublicUrl } from '../server/public-fetch.mjs';

test('recommendations retain original identities and cannot produce duplicate or unsafe source URLs', () => {
  const originalIds = ['openai', 'huggingface', 'github', 'arxiv', 'claude-code-releases', 'gemini-cli-releases', 'comfyui-releases'];
  assert.deepEqual(sourceCatalogEntries.slice(0, originalIds.length).map(entry => entry.id), originalIds);
  assert.equal(new Set(sourceCatalogEntries.map(entry => entry.id)).size, sourceCatalogEntries.length);
  assert.equal(new Set(sourceCatalogEntries.map(entry => entry.url)).size, sourceCatalogEntries.length);
  for (const entry of sourceCatalogEntries) {
    assert.doesNotThrow(() => validatePublicUrl(entry.url), entry.id);
    assert.ok(entry.name && entry.platform && entry.description, entry.id);
  }
});

test('new feed recommendations expose observed nonempty counts and distinguish official, media and community publishers', () => {
  for (const entry of freeSourceAdditions) {
    assert.ok(Number.isInteger(entry.verifiedItemCount) && entry.verifiedItemCount > 0, entry.id);
    assert.ok(Number.isFinite(Date.parse(entry.verifiedAt)), entry.id);
    assert.ok(['official', 'media', 'community'].includes(entry.publisherType), entry.id);
    assert.ok(['en', 'zh'].includes(entry.language), entry.id);
    assert.doesNotThrow(() => validatePublicUrl(entry.homepageUrl), entry.id);
  }
  const community = freeSourceAdditions.filter(entry => entry.publisherType === 'community');
  assert.ok(community.length > 0);
  assert.ok(community.every(entry => /未经核验/.test(entry.description)));
  const video = freeSourceAdditions.find(entry => entry.platform === 'YouTube');
  assert.match(video.url, /channel_id=UC[\w-]{22}$/);
  assert.match(video.description, /不含字幕/);
  assert.match(video.description, /404/);
});
