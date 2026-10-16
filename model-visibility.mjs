// OpenCode Web UI stores model selector preferences separately from provider configuration.
export const modelPreferenceKey = 'opencode.global.dat:model';

export function readModelPreferences(storage) {
  const raw = storage.getItem(modelPreferenceKey);
  const value = raw === null ? { user: [], recent: [], variant: {} } : JSON.parse(raw);
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Array.isArray(value.user)) throw new Error('Invalid model preferences');
  return value;
}

export function modelVisible(preferences, providerID, modelID) {
  // The last explicit choice wins, as in OpenCode. Custom models without a release date are visible by default.
  const choice = preferences.user.findLast(item => item?.providerID === providerID && item.modelID === modelID)?.visibility;
  return choice !== 'hide';
}

export function saveModelVisibility(storage, providerID, choices, remove = false) {
  saveModelVisibilityBatch(storage, [{ providerID, choices, remove }]);
}

export function saveModelVisibilityBatch(storage, groups) {
  if (!Array.isArray(groups) || groups.length > 100 || groups.some(group => !group || typeof group.providerID !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,62}$/.test(group.providerID) || !Array.isArray(group.choices) || group.choices.length > 2000 || group.choices.some(item => !item || typeof item.modelID !== 'string' || !item.modelID || item.modelID.length > 128 || typeof item.visible !== 'boolean'))) throw new Error('Invalid model visibility');
  const preferences = readModelPreferences(storage);
  let user = preferences.user;
  for (const { providerID, choices, remove } of groups) {
    const updates = new Map(choices.map(item => [item.modelID, item.visible ? 'show' : 'hide']));
    user = user.filter(item => item?.providerID !== providerID || !remove && !updates.has(item.modelID));
    if (!remove) for (const [modelID, visibility] of updates) user.push({ providerID, modelID, visibility });
  }
  // Read at commit time to preserve changes to other providers, recent models and variants.
  storage.setItem(modelPreferenceKey, JSON.stringify({ ...preferences, user }));
}
