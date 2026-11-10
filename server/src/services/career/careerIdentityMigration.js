"use strict";

// Identity repair changes the catalog key, never the earned gameplay outcome.
// Reward claim and delivery custody is separately owned by careerRewardRuntime.
function migrateGoals(stored, definitions) {
  const goals = structuredClone(stored || {});
  const migrated = [];
  for (const definition of definitions) {
    const aliases = definition.legacyIDs || [];
    if (!aliases.some(id => Object.hasOwn(goals, id))) continue;
    const candidates = [definition.id, ...aliases].filter(id => Object.hasOwn(goals, id)).map(id => {
      const row = goals[id];
      if (row?.goalID !== id || !Number.isSafeInteger(row.progress) || row.progress < 0 || row.progress > definition.target ||
          row.source?.kind !== definition.source.kind || typeof row.source.id !== "string" || !row.source.id ||
          row.goalSymbol && definition.symbol && row.goalSymbol !== definition.symbol ||
          !Number.isSafeInteger(row.completedAtMs) || row.completedAtMs < 0 ||
          row.completedAtMs > 0 && row.progress !== definition.target) throw new Error("CAREER_ALIAS_STATE_INVALID");
      return row;
    });
    if (new Set(candidates.map(row => row.source.id)).size > 1) throw new Error("CAREER_ALIAS_SOURCE_CONFLICT");
    const progress = Math.max(...candidates.map(row => row.progress));
    const dates = candidates.map(row => row.completedAtMs).filter(value => value > 0);
    const next = { ...candidates[0], goalID: definition.id, progress,
      completedAtMs: dates.length ? Math.min(...dates) : 0 };
    goals[definition.id] = next;
    for (const alias of aliases) delete goals[alias];
    migrated.push(next);
  }
  return { goals, migrated };
}

function migrateProgress(state, definitions) {
  if (state?.version > 2) throw new Error("CAREER_PROGRESS_VERSION_UNSUPPORTED");
  let goals = structuredClone(state?.goals || {});
  const migrated = [];
  if ((state?.version || 1) < 2) {
    const rotated = definitions.filter(row => row.previousClientID);
    const keys = new Set(rotated.flatMap(row => [row.previousClientID, row.id]));
    const bySource = new Map(rotated.map(row => [`mission-evidence:${row.source.metric}:v1`, row]));
    const semanticRows = new Map();
    for (const key of keys) {
      const stored = goals[key];
      if (!stored) continue;
      const definition = bySource.get(stored.source?.id);
      if (!definition || stored.source?.kind !== definition.source.kind || stored.goalID !== key ||
          !Number.isSafeInteger(stored.progress) || stored.progress < 0 || stored.progress > definition.target ||
          !Number.isSafeInteger(stored.completedAtMs) || stored.completedAtMs < 0 ||
          stored.completedAtMs > 0 && stored.progress !== definition.target ||
          stored.goalSymbol && stored.goalSymbol !== definition.symbol) throw new Error("CAREER_SEMANTIC_SOURCE_CONFLICT");
      const previous = semanticRows.get(definition.id);
      const dates = [previous?.completedAtMs, stored.completedAtMs].filter(value => value > 0);
      semanticRows.set(definition.id, { ...stored, goalID: definition.id, goalSymbol: definition.symbol,
        progress: Math.max(previous?.progress || 0, stored.progress), completedAtMs: dates.length ? Math.min(...dates) : 0 });
    }
    // Move the cycle as one batch; writing one destination at a time would
    // overwrite another lesson's still-unmigrated receipt.
    for (const key of keys) delete goals[key];
    for (const [id, row] of semanticRows) { goals[id] = row; migrated.push(row); }
  }
  const aliases = migrateGoals(goals, definitions);
  return { version: 2, goals: aliases.goals, migrated: [...migrated, ...aliases.migrated] };
}

module.exports = { migrateGoals, migrateProgress };
