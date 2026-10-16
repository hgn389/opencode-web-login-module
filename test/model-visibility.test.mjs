import { test } from 'node:test';
import assert from 'node:assert/strict';
import { modelPreferenceKey, readModelPreferences, modelVisible, saveModelVisibility, saveModelVisibilityBatch } from '../model-visibility.mjs';

function memory(value) {
  const data = new Map(value === undefined ? [] : [[modelPreferenceKey, typeof value === 'string' ? value : JSON.stringify(value)]]);
  return { getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value) };
}

test('visibility uses the native preference format and preserves unrelated settings and models', () => {
  const storage = memory({ user: [{ providerID: 'router', modelID: 'one', visibility: 'show' }, { providerID: 'other', modelID: 'one', visibility: 'hide' }], recent: [{ providerID: 'other', modelID: 'one' }], variant: { 'other/one': 'high' }, extra: 1 });
  saveModelVisibility(storage, 'router', [{ modelID: 'one', visible: false }, { modelID: 'two', visible: true }]);
  const saved = readModelPreferences(storage);
  assert.equal(modelVisible(saved, 'router', 'one'), false);
  assert.equal(modelVisible(saved, 'router', 'two'), true);
  assert.equal(modelVisible(saved, 'other', 'one'), false);
  assert.deepEqual(saved.recent, [{ providerID: 'other', modelID: 'one' }]);
  assert.deepEqual(saved.variant, { 'other/one': 'high' }); assert.equal(saved.extra, 1);
});

test('updates merge with the latest preferences and replace duplicate explicit choices', () => {
  const storage = memory();
  saveModelVisibility(storage, 'router', [{ modelID: 'a:b', visible: false }, { modelID: 'a:b', visible: true }]);
  saveModelVisibility(storage, 'other', [{ modelID: 'a:b', visible: false }]);
  saveModelVisibility(storage, 'router', [{ modelID: 'new', visible: false }]);
  const saved = readModelPreferences(storage);
  assert.equal(saved.user.length, 3);
  assert.equal(modelVisible(saved, 'router', 'a:b'), true);
  assert.equal(modelVisible(saved, 'router', 'new'), false);
  assert.equal(modelVisible(saved, 'other', 'a:b'), false);
});

test('removing a provider removes only its visibility preferences', () => {
  const storage = memory({ user: [{ providerID: 'router', modelID: 'one', visibility: 'show' }, { providerID: 'other', modelID: 'one', visibility: 'hide' }], recent: [], variant: {} });
  saveModelVisibility(storage, 'router', [], true);
  assert.deepEqual(readModelPreferences(storage).user, [{ providerID: 'other', modelID: 'one', visibility: 'hide' }]);
});

test('bulk visibility spans providers with shared model IDs using a single storage write', () => {
  const initial = { user: [{ providerID: 'other', modelID: 'coder', visibility: 'show' }], recent: [], variant: { 'other/coder': 'high' } };
  const storage = memory(initial), setItem = storage.setItem; let writes = 0;
  storage.setItem = (key, value) => { writes++; setItem(key, value); };
  saveModelVisibilityBatch(storage, [
    { providerID: 'first', choices: [{ modelID: 'coder', visible: false }] },
    { providerID: 'second', choices: [{ modelID: 'coder', visible: true }] },
  ]);
  const preferences = readModelPreferences(storage);
  assert.equal(writes, 1);
  assert.equal(modelVisible(preferences, 'first', 'coder'), false);
  assert.equal(modelVisible(preferences, 'second', 'coder'), true);
  assert.equal(modelVisible(preferences, 'other', 'coder'), true);
  assert.deepEqual(preferences.variant, initial.variant);
  const before = storage.getItem(modelPreferenceKey);
  assert.throws(() => saveModelVisibilityBatch(storage, [
    { providerID: 'first', choices: [{ modelID: 'coder', visible: true }] },
    { providerID: 'invalid/id', choices: [{ modelID: 'coder', visible: false }] },
  ]));
  assert.equal(writes, 1); assert.equal(storage.getItem(modelPreferenceKey), before);
  storage.setItem = () => { throw new Error('Quota exceeded'); };
  assert.throws(() => saveModelVisibilityBatch(storage, [{ providerID: 'first', choices: [{ modelID: 'coder', visible: true }] }]));
  assert.equal(storage.getItem(modelPreferenceKey), before);
});

test('malformed native preferences and invalid changes never overwrite existing browser data', () => {
  for (const value of ['{', 'null', '[]', '{}', '{"user":{}}']) {
    const storage = memory(value);
    assert.throws(() => saveModelVisibility(storage, 'router', [{ modelID: 'one', visible: false }]));
    assert.equal(storage.getItem(modelPreferenceKey), value);
  }
  const storage = memory();
  for (const [id, choices] of [['bad/id', []], ['router', [{ modelID: '', visible: false }]], ['router', [{ modelID: 'one', visible: 'hide' }]]]) assert.throws(() => saveModelVisibility(storage, id, choices));
  assert.equal(storage.getItem(modelPreferenceKey), null);
  assert.throws(() => saveModelVisibility({ getItem: () => null, setItem() { throw new Error('Quota exceeded'); } }, 'router', [{ modelID: 'one', visible: false }]));
});
