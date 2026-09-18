/**
 * Gaiiiaudio - Popup Controller
 */

const $ = (sel) => document.querySelector(sel);

let activeTab = null;
let currentWindowId = null;
let tabs = [];
let rules = [];
let windowScope = 'current'; // 'current' | 'all'
let searchQuery = '';
let boosterEnabled = false;
let boostState = { boostedTabId: null, boostedGain: 1.0 };
let boostSessionActiveForTab = null;
let tabOverrideCache = new Map(); // tabId -> has an active session override

document.addEventListener('DOMContentLoaded', init);

async function init() {
  const uiPrefs = await chrome.storage.local.get(['uiWindowScope', 'uiSearchQuery']);
  windowScope = uiPrefs.uiWindowScope === 'all' ? 'all' : 'current';
  searchQuery = uiPrefs.uiSearchQuery || '';
  $('#mixerSearch').value = searchQuery;
  $('#btnWindowScope').textContent = windowScope === 'current' ? 'CETTE FENETRE' : 'TOUTES LES FENETRES';
  $('#btnWindowScope').classList.toggle('active', windowScope === 'all');

  setupNavigation();
  setupRulesForm();
  setupRulesImportExport();
  setupToolbar();
  setupHeaderActions();
  setupBoosterControls();
  await refreshAll();

  chrome.tabs.onCreated.addListener(refreshAll);
  chrome.tabs.onRemoved.addListener(refreshAll);
  chrome.tabs.onUpdated.addListener(refreshAll);
  chrome.tabs.onActivated.addListener(refreshAll);
}

function setupToolbar() {
  const search = $('#mixerSearch');
  search.addEventListener('input', async () => {
    searchQuery = search.value.trim().toLowerCase();
    await chrome.storage.local.set({ uiSearchQuery: searchQuery });
    renderMixer();
  });

  const scopeBtn = $('#btnWindowScope');
  scopeBtn.addEventListener('click', async () => {
    windowScope = windowScope === 'current' ? 'all' : 'current';
    scopeBtn.textContent = windowScope === 'current' ? 'CETTE FENETRE' : 'TOUTES LES FENETRES';
    scopeBtn.classList.toggle('active', windowScope === 'all');
    await chrome.storage.local.set({ uiWindowScope: windowScope });
    await refreshAll();
  });

  $('#btnCloseDuplicates').addEventListener('click', async () => {
    const idsToClose = findDuplicateTabIds(tabs);
    if (!idsToClose.length) return;
    if (!confirm(`Fermer ${idsToClose.length} onglet(s) en double (meme URL) ? Un exemplaire de chaque est conserve.`)) return;
    await chrome.tabs.remove(idsToClose);
    await refreshAll();
  });

  $('#btnResetAllOverrides').addEventListener('click', async () => {
    const withOverride = tabs.filter(t => tabOverrideCache.get(t.id));
    if (!withOverride.length) return;
    if (!confirm(`Retablir la regle (ou 100%) sur ${withOverride.length} onglet(s) ?`)) return;
    await Promise.all(withOverride.map(t =>
      chrome.tabs.sendMessage(t.id, { type: 'CLEAR_OVERRIDE' }).catch(() => {})
    ));
    await refreshAll();
  });
}

// Groups tabs by exact URL; keeps the active tab (or the oldest by id) in
// each group and returns the ids of the rest, to close.
function findDuplicateTabIds(tabList) {
  const groups = new Map();
  for (const t of tabList) {
    if (!t.url) continue;
    if (!groups.has(t.url)) groups.set(t.url, []);
    groups.get(t.url).push(t);
  }
  const toClose = [];
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const keeper = group.find(t => t.id === activeTab?.id) || group.reduce((a, b) => (a.id < b.id ? a : b));
    for (const t of group) if (t.id !== keeper.id) toClose.push(t.id);
  }
  return toClose;
}

function setupHeaderActions() {
  $('#btnDetach').addEventListener('click', () => {
    chrome.windows.create({
      url: chrome.runtime.getURL('popup/popup.html'),
      type: 'popup',
      width: 420,
      height: 640
    });
  });
}

function setupNavigation() {
  document.querySelectorAll('.nav-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const view = btn.dataset.view;
      document.querySelectorAll('.nav-btn').forEach(b => b.classList.toggle('active', b === btn));
      document.querySelectorAll('.view-panel').forEach(p => p.classList.toggle('active', p.id === `view-${view}`));
    });
  });
}

function extractDomain(rawUrl) {
  try {
    return new URL(rawUrl).hostname.replace(/^www\./i, '').toLowerCase();
  } catch {
    return '';
  }
}

function findMatchingRule(list, domain) {
  const matches = (list || []).filter(r =>
    r?.pattern && r.enabled !== false && domain.includes(r.pattern.trim().toLowerCase())
  );
  if (!matches.length) return null;
  matches.sort((a, b) => b.pattern.trim().length - a.pattern.trim().length);
  return matches[0];
}

function clampVolume(val) {
  const num = parseInt(val, 10);
  if (isNaN(num)) return 100;
  return Math.max(0, Math.min(100, num));
}

function sliderGradient(value) {
  return `linear-gradient(to right, var(--accent) ${value}%, var(--border) ${value}%)`;
}

function muteSvg(muted) {
  return muted
    ? `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon><line x1="23" y1="9" x2="17" y2="15"></line><line x1="17" y1="9" x2="23" y2="15"></line></svg>`
    : `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon><path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"></path></svg>`;
}

function pinSvg(pinned) {
  return `<svg width="12" height="12" viewBox="0 0 24 24" fill="${pinned ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"></path></svg>`;
}

function closeSvg() {
  return `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>`;
}

function reloadSvg() {
  return `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"></polyline><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"></path></svg>`;
}

function isolateSvg() {
  return `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"></circle><circle cx="12" cy="12" r="3"></circle></svg>`;
}

function editSvg() {
  return `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"></path><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"></path></svg>`;
}

async function refreshAll() {
  // Uses the last focused *normal* browsing window rather than the calling
  // window's own context: when this popup runs detached (its own popup-type
  // window), "current window" would otherwise resolve to itself, not the
  // browsing window the user actually wants to control.
  const win = await chrome.windows.getLastFocused({ windowTypes: ['normal'] });
  currentWindowId = win.id;
  const [current] = await chrome.tabs.query({ active: true, windowId: currentWindowId });
  activeTab = current || null;

  const query = { url: ['http://*/*', 'https://*/*'] };
  if (windowScope === 'current') query.windowId = currentWindowId;
  tabs = await chrome.tabs.query(query);

  const stored = await chrome.storage.local.get(['rules', 'boosterEnabled']);
  rules = stored.rules || [];
  boosterEnabled = Boolean(stored.boosterEnabled);

  try {
    boostState = await chrome.runtime.sendMessage({ type: 'GET_BOOST_STATE' });
  } catch {
    boostState = { boostedTabId: null, boostedGain: 1.0 };
  }
  boostSessionActiveForTab = (boostState.boostedTabId && boostState.boostedTabId === activeTab?.id)
    ? boostState.boostedTabId
    : null;

  await renderMixer();
  renderRulesList();
  updateBoosterView();
}

// ===== MIXEUR =====
let renderToken = 0;

async function renderMixer() {
  const myToken = ++renderToken;
  const container = $('#mixerList');
  const emptyEl = $('#mixerEmpty');
  container.innerHTML = '';
  tabOverrideCache = new Map();

  const dupBtn = $('#btnCloseDuplicates');
  const dupCount = findDuplicateTabIds(tabs).length;
  dupBtn.classList.toggle('hidden', dupCount === 0);
  dupBtn.textContent = `FERMER LES DOUBLONS (${dupCount})`;

  const filtered = searchQuery
    ? tabs.filter(t => (t.title || '').toLowerCase().includes(searchQuery) || (t.url || '').toLowerCase().includes(searchQuery))
    : tabs;

  if (!filtered.length) {
    emptyEl.classList.remove('hidden');
    emptyEl.querySelector('.empty-text').textContent = tabs.length ? 'AUCUN RESULTAT' : 'AUCUN ONGLET DETECTE';
    $('#btnResetAllOverrides').disabled = true;
    return;
  }
  emptyEl.classList.add('hidden');

  const sorted = [...filtered].sort((a, b) => {
    if (windowScope === 'all' && a.windowId !== b.windowId) {
      if (a.windowId === currentWindowId) return -1;
      if (b.windowId === currentWindowId) return 1;
      return a.windowId - b.windowId;
    }
    if (a.id === activeTab?.id) return -1;
    if (b.id === activeTab?.id) return 1;
    if (a.audible && !b.audible) return -1;
    if (!a.audible && b.audible) return 1;
    return 0;
  });

  let lastWindowId = null;
  let windowIndex = 0;
  for (const tab of sorted) {
    let sep = null;
    if (windowScope === 'all' && tab.windowId !== lastWindowId) {
      lastWindowId = tab.windowId;
      windowIndex++;
      sep = document.createElement('div');
      sep.className = 'window-separator';
      sep.textContent = tab.windowId === currentWindowId ? 'FENETRE ACTUELLE' : `FENETRE ${windowIndex}`;
    }
    const card = await createMixerCard(tab);
    // A newer renderMixer() call started while we were awaiting the content
    // script's response: abandon this stale pass instead of appending into
    // a container a fresher render has already rebuilt.
    if (myToken !== renderToken) return;
    if (sep) container.appendChild(sep);
    container.appendChild(card);
  }

  const hasAnyOverride = [...tabOverrideCache.values()].some(Boolean);
  $('#btnResetAllOverrides').disabled = !hasAnyOverride;
}

async function createMixerCard(tab) {
  const domain = extractDomain(tab.url || '');
  const matchedRule = findMatchingRule(rules, domain);

  let state = { domain, override: null, ruleVolume: matchedRule?.volume ?? null };
  let reachable = true;
  try {
    state = await chrome.tabs.sendMessage(tab.id, { type: 'GET_STATE' });
  } catch {
    reachable = false;
  }

  tabOverrideCache.set(tab.id, state.override !== null);

  const currentVolume = state.override ?? matchedRule?.volume ?? 100;
  const isMuted = currentVolume === 0;
  const liveState = { volume: isMuted ? (matchedRule?.volume || 100) : currentVolume, muted: isMuted };

  const card = document.createElement('div');
  card.className = 'mixer-card';
  if (tab.id === activeTab?.id) card.classList.add('active-tab');
  if (!reachable) card.classList.add('unreachable');

  const topRow = document.createElement('div');
  topRow.className = 'card-top';

  const meta = document.createElement('div');
  meta.className = 'tab-meta';

  const favWrap = document.createElement('div');
  favWrap.className = 'mixer-favicon-wrap';
  if (tab.favIconUrl) {
    const fav = document.createElement('img');
    fav.className = 'mixer-favicon';
    fav.src = tab.favIconUrl;
    fav.onerror = () => fav.remove();
    favWrap.appendChild(fav);
  }

  const textCol = document.createElement('div');
  textCol.className = 'tab-text-col';
  const title = document.createElement('span');
  title.className = 'tab-title';
  title.textContent = tab.title || domain || 'Onglet sans nom';
  title.title = tab.title || '';
  textCol.appendChild(title);
  if (domain) {
    const domainLabel = document.createElement('span');
    domainLabel.className = 'tab-domain';
    domainLabel.textContent = domain;
    textCol.appendChild(domainLabel);
  }
  meta.append(favWrap, textCol);

  if (tab.audible) {
    const audibleDot = document.createElement('span');
    audibleDot.className = 'audible-dot';
    audibleDot.title = 'En cours de lecture';
    meta.appendChild(audibleDot);
  }

  if (!reachable) {
    const badge = document.createElement('span');
    badge.className = 'badge-dot';
    badge.title = 'Onglet non accessible : page chargee avant l\'extension. Recharge la page pour l\'activer.';
    meta.appendChild(badge);
  }

  const actions = document.createElement('div');
  actions.className = 'card-actions';

  const pinBtn = document.createElement('button');
  pinBtn.className = 'btn-icon-subtle' + (matchedRule ? ' is-pinned' : '');
  pinBtn.title = matchedRule ? `Retirer la regle "${matchedRule.pattern}"` : `Fixer une regle pour ${domain}`;
  pinBtn.innerHTML = pinSvg(Boolean(matchedRule));
  pinBtn.disabled = !domain;
  pinBtn.addEventListener('click', async () => {
    if (matchedRule) {
      rules = rules.filter(r => r.id !== matchedRule.id);
    } else {
      rules.unshift({ id: 'rule_' + Date.now(), pattern: domain, volume: liveState.volume, enabled: true });
    }
    await chrome.storage.local.set({ rules });
    await refreshAll();
  });

  const muteBtn = document.createElement('button');
  muteBtn.className = 'btn-icon-subtle' + (isMuted ? ' is-muted' : '');
  muteBtn.title = isMuted ? 'Retablir le son' : 'Couper le son';
  muteBtn.innerHTML = muteSvg(isMuted);
  muteBtn.disabled = !reachable;

  const isolateBtn = document.createElement('button');
  isolateBtn.className = 'btn-icon-subtle';
  isolateBtn.title = 'Isoler cet onglet (couper le son de tous les autres)';
  isolateBtn.innerHTML = isolateSvg();
  isolateBtn.disabled = !reachable;
  isolateBtn.addEventListener('click', async () => {
    const others = tabs.filter(t => t.id !== tab.id);
    await Promise.all(others.map(t =>
      chrome.tabs.sendMessage(t.id, { type: 'SET_VOLUME', value: 0 }).catch(() => {})
    ));
    await refreshAll();
  });

  actions.append(pinBtn, muteBtn, isolateBtn);

  if (!reachable) {
    const reloadBtn = document.createElement('button');
    reloadBtn.className = 'btn-icon-subtle';
    reloadBtn.title = 'Recharger l\'onglet pour activer le controle';
    reloadBtn.innerHTML = reloadSvg();
    reloadBtn.addEventListener('click', () => chrome.tabs.reload(tab.id));
    actions.appendChild(reloadBtn);
  }

  topRow.append(meta, actions);

  const bottomRow = document.createElement('div');
  bottomRow.className = 'card-bottom';

  const slider = document.createElement('input');
  slider.type = 'range';
  slider.className = 'editorial-slider';
  slider.min = '0';
  slider.max = '100';
  slider.value = String(isMuted ? 0 : currentVolume);
  slider.style.background = sliderGradient(isMuted ? 0 : currentVolume);
  slider.disabled = !reachable;

  const directWrap = document.createElement('div');
  directWrap.className = 'direct-input-wrap';
  const directInput = document.createElement('input');
  directInput.type = 'text';
  directInput.className = 'direct-input';
  directInput.value = String(isMuted ? 0 : currentVolume);
  directInput.disabled = !reachable;
  const unitSuffix = document.createElement('span');
  unitSuffix.className = 'unit-suffix';
  unitSuffix.textContent = '%';
  directWrap.append(directInput, unitSuffix);

  bottomRow.append(slider, directWrap);

  let ruleFooter = null;
  if (matchedRule) {
    ruleFooter = document.createElement('div');
    ruleFooter.className = 'card-rule-footer';
    const isOverridden = state.override !== null && state.override !== matchedRule.volume;
    const ruleText = document.createElement('span');
    ruleText.textContent = isOverridden
      ? `Regle: ${matchedRule.volume}% . Override actif`
      : `Regle: ${matchedRule.volume}%`;
    ruleFooter.appendChild(ruleText);

    if (isOverridden) {
      const btnGroup = document.createElement('div');
      btnGroup.className = 'rule-footer-actions';

      const updateBtn = document.createElement('button');
      updateBtn.className = 'btn-restore-rule';
      updateBtn.textContent = 'Mettre a jour la regle';
      updateBtn.addEventListener('click', async () => {
        const idx = rules.findIndex(r => r.id === matchedRule.id);
        if (idx !== -1) {
          rules[idx].volume = state.override;
          await chrome.storage.local.set({ rules });
        }
        try { await chrome.tabs.sendMessage(tab.id, { type: 'CLEAR_OVERRIDE' }); } catch {}
        await refreshAll();
      });

      const restoreBtn = document.createElement('button');
      restoreBtn.className = 'btn-restore-rule';
      restoreBtn.textContent = 'Retablir regle';
      restoreBtn.addEventListener('click', async () => {
        try { await chrome.tabs.sendMessage(tab.id, { type: 'CLEAR_OVERRIDE' }); } catch {}
        await refreshAll();
      });

      btnGroup.append(updateBtn, restoreBtn);
      ruleFooter.appendChild(btnGroup);
    }
  }

  const updateVolume = async (val, forceMute = null) => {
    const clamped = clampVolume(val);
    const muted = forceMute !== null ? forceMute : clamped === 0;
    if (!muted) liveState.volume = clamped;
    liveState.muted = muted;

    const applied = muted ? 0 : liveState.volume;
    slider.value = String(applied);
    slider.style.background = sliderGradient(applied);
    directInput.value = String(applied);
    muteBtn.classList.toggle('is-muted', muted);
    muteBtn.innerHTML = muteSvg(muted);

    try { await chrome.tabs.sendMessage(tab.id, { type: 'SET_VOLUME', value: applied }); } catch {}
  };

  slider.addEventListener('input', () => updateVolume(slider.value));
  slider.addEventListener('wheel', (e) => {
    if (!reachable) return;
    e.preventDefault();
    updateVolume((liveState.muted ? 0 : liveState.volume) + (e.deltaY < 0 ? 5 : -5));
  }, { passive: false });
  directInput.addEventListener('change', () => updateVolume(directInput.value));
  directInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') directInput.blur(); });
  muteBtn.addEventListener('click', () => updateVolume(liveState.volume, !liveState.muted));

  card.append(topRow, bottomRow);
  if (state.boosted) {
    const boostNote = document.createElement('div');
    boostNote.className = 'card-rule-footer';
    boostNote.textContent = 'Booster actif : regle en pause, controle rendu au site';
    card.appendChild(boostNote);
  } else if (ruleFooter) {
    card.appendChild(ruleFooter);
  }

  return card;
}

// ===== REGLES =====
function setupRulesForm() {
  const form = $('#ruleForm');
  const domainInput = $('#ruleDomainInput');
  const volumeInput = $('#ruleVolumeInput');

  $('#btnFillCurrentDomain').addEventListener('click', () => {
    if (activeTab?.url) domainInput.value = extractDomain(activeTab.url);
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const domain = extractDomain('https://' + domainInput.value.trim().replace(/^https?:\/\//i, ''));
    const volume = clampVolume(volumeInput.value);
    if (!domain) return;

    const idx = rules.findIndex(r => r.pattern.toLowerCase() === domain.toLowerCase());
    if (idx !== -1) {
      rules[idx].volume = volume;
      rules[idx].enabled = true;
    } else {
      rules.unshift({ id: 'rule_' + Date.now(), pattern: domain, volume, enabled: true });
    }
    await chrome.storage.local.set({ rules });
    domainInput.value = '';
    await refreshAll();
  });
}

function renderRulesList() {
  const container = $('#rulesContainer');
  const counter = $('#ruleCounter');
  container.innerHTML = '';
  counter.textContent = String(rules.length);

  if (!rules.length) {
    container.innerHTML = '<span class="empty-text">AUCUNE REGLE ACTIVE</span>';
    return;
  }

  rules.forEach(r => {
    const row = document.createElement('div');
    row.className = 'rule-entry';

    const pat = document.createElement('span');
    pat.className = 'rule-pat';
    pat.textContent = r.pattern;

    const right = document.createElement('div');
    right.className = 'rule-right';
    const pct = document.createElement('span');
    pct.className = 'rule-pct';
    pct.textContent = `${r.volume}%`;

    const editBtn = document.createElement('button');
    editBtn.className = 'btn-icon-subtle';
    editBtn.innerHTML = editSvg();
    editBtn.title = 'Editer cette regle';
    editBtn.addEventListener('click', () => {
      const domainInput = $('#ruleDomainInput');
      const volumeInput = $('#ruleVolumeInput');
      domainInput.value = r.pattern;
      volumeInput.value = String(r.volume);
      domainInput.scrollIntoView({ behavior: 'smooth', block: 'center' });
      domainInput.focus();
    });

    const delBtn = document.createElement('button');
    delBtn.className = 'btn-icon-subtle';
    delBtn.innerHTML = closeSvg();
    delBtn.title = 'Supprimer';
    delBtn.addEventListener('click', async () => {
      rules = rules.filter(item => item.id !== r.id);
      await chrome.storage.local.set({ rules });
      await refreshAll();
    });

    right.append(pct, editBtn, delBtn);
    row.append(pat, right);
    container.appendChild(row);
  });
}

// ===== BOOSTER =====
function setupBoosterControls() {
  const toggle = $('#boosterToggle');
  const slider = $('#boosterSlider');
  const valDisplay = $('#boosterValDisplay');
  const resetBtn = $('#btnResetBooster');
  const errorBox = $('#boosterError');

  toggle.addEventListener('change', async () => {
    boosterEnabled = toggle.checked;
    await chrome.storage.local.set({ boosterEnabled });
    if (!boosterEnabled) {
      await chrome.runtime.sendMessage({ type: 'STOP_BOOST' }).catch(() => {});
      boostSessionActiveForTab = null;
    }
    await refreshAll();
  });

  slider.addEventListener('input', async () => {
    if (!boosterEnabled || !activeTab) return;
    const gain = clampBoost(slider.value);
    valDisplay.textContent = `${gain}%`;
    errorBox.classList.add('hidden');

    if (boostSessionActiveForTab !== activeTab.id) {
      const res = await chrome.runtime.sendMessage({ type: 'START_BOOST', tabId: activeTab.id, gain });
      if (!res?.success) {
        errorBox.textContent = res?.error || 'Boost indisponible sur cet onglet.';
        errorBox.classList.remove('hidden');
        slider.value = '100';
        valDisplay.textContent = '100%';
        return;
      }
      boostSessionActiveForTab = activeTab.id;
    } else {
      await chrome.runtime.sendMessage({ type: 'SET_BOOST_GAIN', gain }).catch(() => {});
    }
    boostState = { boostedTabId: activeTab.id, boostedGain: gain / 100 };
  });

  resetBtn.addEventListener('click', async () => {
    await chrome.runtime.sendMessage({ type: 'STOP_BOOST' }).catch(() => {});
    boostSessionActiveForTab = null;
    boostState = { boostedTabId: null, boostedGain: 1.0 };
    slider.value = '100';
    valDisplay.textContent = '100%';
    errorBox.classList.add('hidden');
  });
}

function clampBoost(val) {
  const num = parseInt(val, 10);
  if (isNaN(num)) return 100;
  return Math.max(100, Math.min(300, num));
}

function updateBoosterView() {
  const toggle = $('#boosterToggle');
  const box = $('#boosterBox');
  const tabNameEl = $('#boosterTabName');
  const slider = $('#boosterSlider');
  const valDisplay = $('#boosterValDisplay');

  toggle.checked = boosterEnabled;
  box.classList.toggle('disabled', !boosterEnabled);

  tabNameEl.textContent = activeTab ? (activeTab.title || extractDomain(activeTab.url || '') || 'Onglet actif') : 'Aucun onglet actif';

  if (boosterEnabled && activeTab && boostState.boostedTabId === activeTab.id) {
    const pct = Math.round(boostState.boostedGain * 100);
    slider.value = String(pct);
    valDisplay.textContent = `${pct}%`;
  } else {
    slider.value = '100';
    valDisplay.textContent = '100%';
  }
}

// ===== EXPORT / IMPORT =====
function sanitizeImportedRules(parsed) {
  if (!Array.isArray(parsed)) throw new Error('le fichier doit contenir une liste de regles');
  return parsed
    .filter(r => r && typeof r.pattern === 'string' && r.pattern.trim())
    .map(r => ({
      id: typeof r.id === 'string' ? r.id : 'rule_' + Date.now() + Math.random().toString(36).slice(2, 7),
      pattern: r.pattern.trim().toLowerCase(),
      volume: clampVolume(r.volume),
      enabled: r.enabled !== false
    }));
}

let feedbackTimer = null;
function showRulesFeedback(text) {
  const el = $('#rulesFeedback');
  el.textContent = text;
  el.classList.remove('hidden');
  clearTimeout(feedbackTimer);
  feedbackTimer = setTimeout(() => el.classList.add('hidden'), 3500);
}

function setupRulesImportExport() {
  $('#btnExportRules').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(rules, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'gaiiiaudio-regles.json';
    a.click();
    URL.revokeObjectURL(url);
    showRulesFeedback(`${rules.length} regle(s) exportee(s).`);
  });

  const fileInput = $('#importFileInput');
  $('#btnImportRules').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files[0];
    fileInput.value = '';
    if (!file) return;
    try {
      const imported = sanitizeImportedRules(JSON.parse(await file.text()));
      if (rules.length && !confirm(`Remplacer les ${rules.length} regle(s) actuelle(s) par les ${imported.length} regle(s) importee(s) ?`)) return;
      rules = imported;
      await chrome.storage.local.set({ rules });
      await refreshAll();
      showRulesFeedback(`${imported.length} regle(s) importee(s).`);
    } catch (err) {
      alert('Fichier invalide : ' + err.message);
    }
  });
}
