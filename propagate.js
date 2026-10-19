/**
 * Repeat a target correction across segments with the same source text.
 * One applyBatch or undoBatch result is one atomic revision.
 */

function normalizeSource(text) {
  return String(text == null ? '' : text).trim().replace(/\s+/g, ' ');
}

function segmentId(index) {
  return 's' + index;
}

function ensureMeta(count, existing) {
  const out = [];
  for (let i = 0; i < count; i++) {
    const prev = Array.isArray(existing) ? existing[i] : null;
    const id = prev && typeof prev.id === 'string' && prev.id ? prev.id : segmentId(i);
    out.push({
      id,
      propagatedFrom: prev && prev.propagatedFrom ? String(prev.propagatedFrom) : null,
      propagatedAt: prev && Number(prev.propagatedAt) > 0 ? Number(prev.propagatedAt) : null
    });
  }
  return out;
}

function targetText(doc, index) {
  return doc.targets[index] == null ? '' : String(doc.targets[index]);
}

function sameSourceIndexes(sources, sourceIndex) {
  const list = sources || [];
  const needle = normalizeSource(list[sourceIndex]);
  if (!needle) return [];
  const indexes = [];
  for (let i = 0; i < list.length; i++) {
    if (normalizeSource(list[i]) === needle) indexes.push(i);
  }
  return indexes;
}

function nextRepeatIndex(indexes, currentIndex) {
  if (!indexes || !indexes.length) return -1;
  const at = indexes.indexOf(currentIndex);
  if (at < 0) return indexes[0];
  return indexes[(at + 1) % indexes.length];
}

function listMatches(doc, sourceIndex) {
  const sources = doc.sources || [];
  const needle = normalizeSource(sources[sourceIndex]);
  if (!needle) return [];
  const proposed = String(doc.newTarget == null ? '' : doc.newTarget).trim();
  const matches = [];
  for (let i = 0; i < sources.length; i++) {
    if (i === sourceIndex) continue;
    if (normalizeSource(sources[i]) !== needle) continue;
    const currentTarget = targetText(doc, i);
    if (currentTarget.trim() === proposed) continue;
    matches.push({
      index: i,
      id: (doc.meta[i] && doc.meta[i].id) || segmentId(i),
      segmentNumber: i + 1,
      sourceText: String(sources[i] || ''),
      currentTarget,
      proposedTarget: proposed,
      checked: doc.status[i] === 'checked'
    });
  }
  return matches;
}

function summarizeRepeats(doc, sourceIndex, newTarget) {
  const matches = listMatches({
    sources: doc.sources,
    targets: doc.targets,
    status: doc.status,
    meta: doc.meta,
    newTarget
  }, sourceIndex);
  let checked = 0;
  let unchecked = 0;
  matches.forEach((match) => {
    if (match.checked) checked += 1;
    else unchecked += 1;
  });
  return { total: matches.length, checked, unchecked, indexes: matches.map((match) => match.index) };
}

function resolveScope(opts) {
  if (opts.mode === 'auto') return 'all';
  if (opts.scope === 'checked' || opts.scope === 'unchecked' || opts.scope === 'all') return opts.scope;
  return 'all';
}

function inScope(checked, scope) {
  if (scope === 'checked') return checked;
  if (scope === 'unchecked') return !checked;
  return true;
}

function indexSet(list) {
  const set = new Set();
  (list || []).forEach((item) => {
    const index = Number(item);
    if (Number.isInteger(index)) set.add(index);
  });
  return set;
}

function pendingRepeatIndexes(order, sourceIndex, targets, proposed, reviewed) {
  const proposedText = String(proposed == null ? '' : proposed).trim();
  const done = indexSet(reviewed);
  return (order || []).filter((index) => {
    if (index === sourceIndex || done.has(index)) return false;
    const current = targets && targets[index] != null ? String(targets[index]).trim() : '';
    return current !== proposedText;
  });
}

function nextUntreatedIndex(order, cursor, pending) {
  const list = order || [];
  const allowed = new Set(pending || []);
  if (!list.length || !allowed.size) return -1;
  const start = list.indexOf(cursor);
  const from = start < 0 ? 0 : start + 1;
  for (let step = 0; step < list.length; step++) {
    const index = list[(from + step) % list.length];
    if (allowed.has(index)) return index;
  }
  return -1;
}

function reviewPosition(order, index) {
  const at = (order || []).indexOf(index);
  return at < 0 ? 0 : at + 1;
}

function applyBatch(doc, opts) {
  const scope = resolveScope(opts);
  const newTarget = String(opts.newTarget == null ? '' : opts.newTarget);
  const matches = listMatches({
    sources: doc.sources,
    targets: doc.targets,
    status: doc.status,
    meta: doc.meta,
    newTarget
  }, opts.sourceIndex);
  const targets = (doc.targets || []).map((item) => String(item == null ? '' : item));
  const meta = ensureMeta((doc.sources || []).length, doc.meta);
  const status = (doc.status || []).map((item) => (item === 'checked' ? 'checked' : ''));
  while (status.length < targets.length) status.push('');
  const sourceId = meta[opts.sourceIndex] ? meta[opts.sourceIndex].id : segmentId(opts.sourceIndex);
  const changes = [];
  const only = opts.mode === 'auto' || !Array.isArray(opts.onlyIndexes) ? null : indexSet(opts.onlyIndexes);
  const exclude = opts.mode === 'auto' ? new Set() : indexSet(opts.excludeIndexes);

  for (const match of matches) {
    if (only && !only.has(match.index)) continue;
    if (exclude.has(match.index)) continue;
    if (!inScope(match.checked, scope)) continue;
    const live = targets[match.index] == null ? '' : String(targets[match.index]);
    if (live.trim() === newTarget.trim()) continue;
    changes.push({
      id: match.id,
      index: match.index,
      previousTarget: live,
      previousStatus: status[match.index] === 'checked' ? 'checked' : '',
      previousMeta: {
        id: meta[match.index].id,
        propagatedFrom: meta[match.index].propagatedFrom,
        propagatedAt: meta[match.index].propagatedAt
      }
    });
    targets[match.index] = newTarget;
    meta[match.index] = {
      id: meta[match.index].id,
      propagatedFrom: sourceId,
      propagatedAt: opts.now || Date.now()
    };
  }

  return { targets, meta, status, changes, matches, sourceId, scope };
}

function undoBatch(targets, meta, statusOrRevision, revisionMaybe) {
  let status = statusOrRevision;
  let revision = revisionMaybe;
  if (statusOrRevision && Array.isArray(statusOrRevision.changes)) {
    revision = statusOrRevision;
    status = [];
  }
  const nextTargets = (targets || []).map((item) => String(item == null ? '' : item));
  const nextMeta = ensureMeta(nextTargets.length, meta);
  const nextStatus = (status || []).map((item) => (item === 'checked' ? 'checked' : ''));
  while (nextStatus.length < nextTargets.length) nextStatus.push('');
  const changes = revision && Array.isArray(revision.changes) ? revision.changes : [];
  for (const change of changes) {
    const index = Number(change.index);
    if (!Number.isInteger(index) || index < 0 || index >= nextTargets.length) continue;
    nextTargets[index] = change.previousTarget == null ? '' : String(change.previousTarget);
    const prev = change.previousMeta || {};
    nextMeta[index] = {
      id: prev.id || nextMeta[index].id,
      propagatedFrom: prev.propagatedFrom || null,
      propagatedAt: prev.propagatedAt || null
    };
    if (change.previousStatus === 'checked' || change.previousStatus === '') {
      nextStatus[index] = change.previousStatus === 'checked' ? 'checked' : '';
    }
  }
  return { targets: nextTargets, meta: nextMeta, status: nextStatus };
}

function undoRevisions(targets, meta, status, revisions) {
  const list = Array.isArray(revisions) ? revisions.slice().reverse() : [];
  let state = {
    targets: targets || [],
    meta: meta || [],
    status: status || []
  };
  list.forEach((revision) => {
    state = undoBatch(state.targets, state.meta, state.status, revision);
  });
  return state;
}

module.exports = {
  normalizeSource,
  segmentId,
  ensureMeta,
  sameSourceIndexes,
  nextRepeatIndex,
  listMatches,
  summarizeRepeats,
  pendingRepeatIndexes,
  nextUntreatedIndex,
  reviewPosition,
  applyBatch,
  undoBatch,
  undoRevisions
};
