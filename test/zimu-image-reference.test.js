import test from 'node:test';
import assert from 'node:assert/strict';
import { parseScript } from '../server/lib/rtf.js';
import { mapScriptImages } from '../server/lib/project.js';
import { mapPages } from '../web/src/pages/importPlan.js';
import { findImageByReference } from '../shared/imageReference.js';

const imageName = 'IMG_4399_2.JPG';
const references = ['IMG_4399_2.JPG', '4399_2.JPG', '4399.JPG', 'IMG_4399_2', '4399_2', '4399'];

test('parses full and abbreviated #pic# image references', () => {
  const text = references.map((reference, index) => `page ${index + 1}\n#pic#${reference}`).join('\n');
  assert.deepEqual(
    parseScript(text).map((page) => page.imageNo),
    references,
  );
});

test('matches IMG_4399_2.JPG through every supported fallback', () => {
  for (const reference of references) {
    assert.equal(findImageByReference(reference, [imageName]), imageName, reference);
  }
});

test('prefers an exact reference over a weaker duplicate-suffix fallback', () => {
  const images = ['IMG_4399_2.JPG', 'IMG_4399.JPG'];
  assert.equal(findImageByReference('4399', images), 'IMG_4399.JPG');
  assert.equal(findImageByReference('4399_2', images), 'IMG_4399_2.JPG');
});

test('server import and browser preview use the same matching result', () => {
  const parsed = references.map((imageNo) => ({ imageNo, blocks: [[imageNo]] }));
  assert.deepEqual(
    mapScriptImages(parsed, [imageName]).map((page) => page.image),
    references.map(() => imageName),
  );

  const file = { name: imageName };
  assert.deepEqual(
    mapPages(parsed, [file]).map((page) => page.image?.name),
    references.map(() => imageName),
  );
});

test('keeps ordinal fallback for unmatched numeric references', () => {
  const images = ['cover.JPG', 'ending.JPG'];
  assert.equal(mapScriptImages([{ imageNo: '2', blocks: [] }], images)[0].image, 'ending.JPG');
  assert.equal(mapPages([{ imageNo: '2', blocks: [] }], images.map((name) => ({ name })))[0].note, 'ordinal');
});
