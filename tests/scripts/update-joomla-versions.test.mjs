// Tests of scripts/update-joomla-versions.mjs: which Joomla versions the playground offers after new releases.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareVersions, pickVersions } from '../../scripts/update-joomla-versions.mjs';

const release = (tag_name, prerelease = false) => ({ tag_name, prerelease, draft: false });

test('the default is Latest, the other one the newest stable release of the major version below it', () => {
  const releases = [release('6.2.1'), release('6.3.0-rc1', true), release('6.2.0'), release('5.4.11'), release('5.4.10'), release('4.4.14')];

  assert.deepEqual(pickVersions(releases, '6.2.1'), { default: '6.2.1', versions: ['6.2.1', '5.4.11'] });
});

test('changes nothing without new releases', () => {
  const releases = [release('6.2.0'), release('5.4.10')];

  assert.deepEqual(pickVersions(releases, '6.2.0'), { default: '6.2.0', versions: ['6.2.0', '5.4.10'] });
});

test('a new major version replaces the oldest one', () => {
  const releases = [release('7.0.0'), release('6.2.3'), release('5.4.12')];

  assert.deepEqual(pickVersions(releases, '7.0.0'), { default: '7.0.0', versions: ['7.0.0', '6.2.3'] });
});

test('a release candidate of the next major version changes nothing', () => {
  const releases = [release('7.0.0-rc1', true), release('6.2.3'), release('5.4.12')];

  assert.deepEqual(pickVersions(releases, '6.2.3'), { default: '6.2.3', versions: ['6.2.3', '5.4.12'] });
});

test('when Latest is no stable release, the newest stable release is the default', () => {
  const releases = [release('6.2.1'), release('5.4.11')];

  assert.deepEqual(pickVersions(releases, 'some-tag'), { default: '6.2.1', versions: ['6.2.1', '5.4.11'] });
});

test('compares versions numerically', () => {
  assert.ok(compareVersions('5.4.10', '5.4.9') > 0);
  assert.ok(compareVersions('6.0.0', '5.10.0') > 0);
});
