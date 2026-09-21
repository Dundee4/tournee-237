/* ============================================================
   TOURNÉES JOURNAL - Application de livraison GPS
   ============================================================ */

'use strict';

// ─── SERVICE WORKER ───────────────────────────────────────────
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () =>
    navigator.serviceWorker.register('./sw.js').catch(() => {})
  );
}

// ─── CONSTANTES ───────────────────────────────────────────────
const DAYS_FR = ['Dimanche','Lundi','Mardi','Mercredi','Jeudi','Vendredi','Samedi'];
const DAYS_SHORT = ['Di','Lu','Ma','Me','Je','Ve','Sa'];
const MONTHS_FR = ['janvier','février','mars','avril','mai','juin',
                   'juillet','août','septembre','octobre','novembre','décembre'];
const AVG_SPEED_KMH = 30;   // vitesse moyenne livraison urbaine
const STOP_TIME_MIN = 1.5;  // minutes par arrêt (sortir, déposer, remonter)
const ROAD_FACTOR = 1.3;    // secours hors ligne : vol d'oiseau × 1,3 ≈ distance routière
// Point de départ de la tournée (dépôt) : 1 Route de Saubion, 40230 Tosse
const DEPART = { adresse: '1 Route de Saubion, 40230 Tosse', lat: 43.686704, lon: -1.334836 };
const GEOCODE_DELAY = 1100; // ms entre requêtes Nominatim
const STATUT_CLIENT_LABELS = {
  actif: '',
  vacances: '🏖 Vacances',
  decede: '✝ Décédé',
  resilie: '🚫 Résilié',
  autre: '⚠️ Autre',
};

// ─── ÉTAT GLOBAL ──────────────────────────────────────────────
let state = {
  clients: [],         // [{id, nom, prenom, adresse, ville, code_postal, lat, lon, journaux[], jours[] (vide = tous les jours), statut_client, statut_commentaire, note}]
  selectedJournaux: [], // codes journal cochés à l'accueil (persistés pour confort)
  session: null,        // Session de livraison active (figée à la génération)
  geocodeRunning: false,
  geocodeStop: false,
  editingClientId: null,
  _pendingImportClients: null,
  _clientStatusTargetId: null,
  map: null,
  markers: [],
  posMarker: null,
  currentPos: null,
  routing: null,      // Instance Leaflet Routing Machine
};

// ─── STORAGE ──────────────────────────────────────────────────
const DB = {
  save() {
    try { localStorage.setItem('journal_clients', JSON.stringify(state.clients)); } catch(e){}
  },
  saveSession() {
    try { localStorage.setItem('journal_session', JSON.stringify(state.session)); } catch(e){}
  },
  saveSelection() {
    try { localStorage.setItem('journal_selected', JSON.stringify(state.selectedJournaux || [])); } catch(e){}
  },
  load() {
    try {
      const c = localStorage.getItem('journal_clients');
      if (c) state.clients = JSON.parse(c);
      const s = localStorage.getItem('journal_session');
      if (s) state.session = JSON.parse(s);
      const sel = localStorage.getItem('journal_selected');
      if (sel) state.selectedJournaux = JSON.parse(sel);
    } catch(e) { state.clients = []; state.session = null; state.selectedJournaux = []; }
  },
  // Sauvegarde horodatée avant un remplacement massif (import CSV)
  archive() {
    try {
      const key = 'journal_archive_' + new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
      localStorage.setItem(key, JSON.stringify(state.clients));
    } catch(e){}
  }
};

// ─── UTILITAIRES ──────────────────────────────────────────────
function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2 +
            Math.cos(lat1*Math.PI/180) * Math.cos(lat2*Math.PI/180) * Math.sin(dLon/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

function toast(msg, duration = 2500) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), duration);
}

function formatTime(h, m) {
  return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`;
}

function minutesToTime(totalMin) {
  const h = Math.floor(totalMin / 60) % 24;
  const m = Math.round(totalMin % 60);
  return formatTime(h, m);
}

function timeToMinutes(timeStr) {
  const [h, m] = timeStr.split(':').map(Number);
  return h * 60 + m;
}

function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
}

function journalBadges(codes) {
  return (codes || []).map(j => `<span class="journal-badge">${j}</span>`).join('');
}

// ─── DISTANCES PAR LA ROUTE (OSRM, OpenStreetMap) ─────────────
const OSRM_TABLE = 'https://router.project-osrm.org/table/v1/driving/';

async function osrmTile(pts, rows, cols) {
  const same = rows.length === cols.length && rows.every((r, i) => r === cols[i]);
  const idx = same ? rows : [...rows, ...cols];
  const coords = idx.map(i => `${pts[i].lon},${pts[i].lat}`).join(';');
  let url = `${OSRM_TABLE}${coords}?annotations=distance`;
  if (!same) {
    url += `&sources=${rows.map((_, k) => k).join(';')}` +
           `&destinations=${cols.map((_, k) => rows.length + k).join(';')}`;
  }
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 20000);
  try {
    const resp = await fetch(url, { signal: ctl.signal });
    const data = await resp.json();
    if (data.code !== 'Ok' || !data.distances) throw new Error(data.message || 'OSRM');
    return data.distances;
  } finally { clearTimeout(timer); }
}

// Matrice des distances routières (mètres) entre tous les points
async function fetchRoadMatrix(pts) {
  const n = pts.length;
  const D = Array.from({ length: n }, () => new Array(n).fill(0));
  const TILE = 50;
  const all = pts.map((_, i) => i);
  const blocks = n <= 100 ? [all] : Array.from({ length: Math.ceil(n / TILE) }, (_, k) => all.slice(k * TILE, (k + 1) * TILE));
  for (const rows of blocks) {
    for (const cols of blocks) {
      const d = await osrmTile(pts, rows, cols);
      rows.forEach((r, i) => cols.forEach((c, j) => {
        let v = d[i][j];
        if (v == null) v = haversine(pts[r].lat, pts[r].lon, pts[c].lat, pts[c].lon) * ROAD_FACTOR * 1000;
        D[r][c] = v;
      }));
    }
  }
  return D;
}

// Renvoie { sym(a,b), leg(a,b) } en km par la route, ou lève une erreur (hors ligne)
async function buildRoadDist(origin, stops) {
  const pts = [], index = new Map();
  const key = p => p.lat + ',' + p.lon;
  const add = p => { if (!index.has(key(p))) { index.set(key(p), pts.length); pts.push(p); } };
  add(origin);
  stops.forEach(s => { if (s.lat != null && s.lon != null) add(s); });
  const D = await fetchRoadMatrix(pts);
  const ki = p => index.get(key(p));
  return {
    sym: (a, b) => (D[ki(a)][ki(b)] + D[ki(b)][ki(a)]) / 2000,  // pour optimiser
    leg: (a, b) => D[ki(a)][ki(b)] / 1000,                       // sens réel du trajet
  };
}

// Renseigne la distance (km) depuis l'arrêt précédent sur chaque arrêt
function annotateLegs(ordered, from, road) {
  let prev = from;
  ordered.forEach(s => {
    if (s.lat == null || s.lon == null) { s.legKm = 0; return; }
    s.legKm = road ? road.leg(prev, s) : haversine(prev.lat, prev.lon, s.lat, s.lon) * ROAD_FACTOR;
    prev = s;
  });
}

// ─── OPTIMISATION DE TOURNÉE ──────────────────────────────────
// Nearest Neighbour avec contrainte horaire optionnelle
function optimizeRoute(stops, startLat, startLon, constraintStopId, constraintTime, startTimeStr, roadDist) {
  const dist = roadDist || ((a, b) => haversine(a.lat, a.lon, b.lat, b.lon));
  const geocoded = stops.filter(s => s.lat != null && s.lon != null);
  const notGeocoded = stops.filter(s => s.lat == null || s.lon == null);

  if (geocoded.length === 0) return stops;

  let startMin = startTimeStr ? timeToMinutes(startTimeStr) : 6 * 60;
  let constraintMin = constraintTime ? timeToMinutes(constraintTime) : null;

  // Calcule le temps estimé d'arrivée à un index dans la tournée
  function estimateArrival(orderedStops, fromLat, fromLon, fromTime) {
    let t = fromTime;
    let lat = fromLat, lon = fromLon;
    for (const s of orderedStops) {
      const d = dist({ lat, lon }, s);
      t += (d / AVG_SPEED_KMH) * 60 + STOP_TIME_MIN;
      lat = s.lat; lon = s.lon;
    }
    return t;
  }

  // Nearest neighbour classique
  function nearestNeighbour(pool, fromLat, fromLon) {
    const result = [];
    const remaining = [...pool];
    let cur = { lat: fromLat, lon: fromLon };
    while (remaining.length > 0) {
      let best = 0, bestDist = Infinity;
      for (let i = 0; i < remaining.length; i++) {
        const d = dist(cur, remaining[i]);
        if (d < bestDist) { bestDist = d; best = i; }
      }
      result.push(remaining.splice(best, 1)[0]);
      cur = result[result.length - 1];
    }
    return result;
  }

  // 2-opt : supprime les croisements dans le trajet (trajet ouvert : départ fixe, pas de retour)
  function twoOpt(route, fromLat, fromLon) {
    const path = [{ lat: fromLat, lon: fromLon }, ...route];
    const n = path.length;
    let improved = true;
    let passes = 0;
    while (improved && passes < 50) {
      improved = false;
      passes++;
      for (let i = 0; i < n - 2; i++) {
        for (let j = i + 2; j < n; j++) {
          const a = path[i], b = path[i + 1], c = path[j], d = path[j + 1];
          const before = dist(a, b) + (d ? dist(c, d) : 0);
          const after  = dist(a, c) + (d ? dist(b, d) : 0);
          if (after < before - 0.001) {
            const rev = path.slice(i + 1, j + 1).reverse();
            path.splice(i + 1, rev.length, ...rev);
            improved = true;
          }
        }
      }
    }
    return path.slice(1);
  }

  let ordered;

  if (constraintStopId && constraintMin !== null) {
    // Contrainte horaire : construire la tournée en deux phases
    const constraintStop = geocoded.find(s => s.id === constraintStopId);
    if (!constraintStop) {
      ordered = nearestNeighbour(geocoded, startLat, startLon);
    } else {
      const others = geocoded.filter(s => s.id !== constraintStopId);

      // Phase 1 : optimiser les stops AVANT la contrainte
      // On estime combien on peut faire avant d'arriver à la contrainte à temps
      const beforePool = nearestNeighbour([...others], startLat, startLon);
      const before = [];
      let cLat = startLat, cLon = startLon, cTime = startMin;

      for (const s of beforePool) {
        const distToS = dist({ lat: cLat, lon: cLon }, s);
        const tAfterS = cTime + (distToS / AVG_SPEED_KMH) * 60 + STOP_TIME_MIN;
        const distToConstraint = dist(s, constraintStop);
        const tArriveConstraint = tAfterS + (distToConstraint / AVG_SPEED_KMH) * 60;
        if (tArriveConstraint <= constraintMin) {
          before.push(s);
          cLat = s.lat; cLon = s.lon; cTime = tAfterS;
        }
      }

      // Phase 2 : stops restants après la contrainte
      const afterPool = others.filter(s => !before.find(b => b.id === s.id));
      const after = nearestNeighbour(afterPool, constraintStop.lat, constraintStop.lon);

      ordered = [...before, constraintStop, ...after];
    }
  } else {
    ordered = twoOpt(nearestNeighbour(geocoded, startLat, startLon), startLat, startLon);
  }

  // Réassigner les ordres
  ordered.forEach((s, i) => { s.order = i; });
  notGeocoded.forEach((s, i) => { s.order = ordered.length + i; });

  return [...ordered, ...notGeocoded];
}

// ─── JOURS DE LIVRAISON ───────────────────────────────────────
// client.jours = liste de jours JS (0=dimanche … 6=samedi) ; absent ou vide = tous les jours.
function livreCeJour(client, day) {
  return !client.jours || client.jours.length === 0 || client.jours.includes(day);
}

// ─── GÉOCODAGE ────────────────────────────────────────────────
async function geocodeAddress(stop) {
  const q = encodeURIComponent(`${stop.adresse}, ${stop.ville}, ${stop.code_postal}, France`);
  const url = `https://nominatim.openstreetmap.org/search?format=json&q=${q}&limit=1`;
  const resp = await fetch(url, { headers: { 'Accept-Language': 'fr' } });
  const data = await resp.json();
  if (data && data[0]) {
    stop.lat = parseFloat(data[0].lat);
    stop.lon = parseFloat(data[0].lon);
    return true;
  }
  return false;
}

// ─── IMPORT CSV ───────────────────────────────────────────────
// Mapping codes postaux par ville (zone Hossegor-Capbreton)
const CITY_CP_MAP = {
  'soorts-hossegor': '40150', 'hossegor': '40150',
  'capbreton': '40130',
  'labenne': '40530',
  'seignosse': '40510',
};

function extractCityFromAddress(adresse) {
  const lastComma = adresse.lastIndexOf(',');
  if (lastComma === -1) return { street: adresse, city: '', cp: '' };
  const street = adresse.slice(0, lastComma).trim();
  const city = adresse.slice(lastComma + 1).trim();
  const cityKey = city.toLowerCase()
    .replace(/[éèê]/g,'e').replace(/[àâ]/g,'a').replace(/[ùû]/g,'u');
  const cp = Object.entries(CITY_CP_MAP).find(([k]) => cityKey.includes(k))?.[1] || '';
  return { street, city, cp };
}

function normalizeKey(str) {
  return (str || '').trim().toLowerCase()
    .replace(/[éèê]/g,'e').replace(/[àâ]/g,'a').replace(/[ùû]/g,'u').replace(/\s+/g,' ');
}

// Un client = regroupement de toutes les lignes CSV partageant le même nom+adresse.
// Chaque ligne CSV représente un couple (client, journal) ; les journaux d'un même
// client sont fusionnés dans son tableau `journaux`.
function parseClientsCSV(text) {
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2) return null;

  const sep = lines[0].includes(';') ? ';' : ',';
  const headers = lines[0].split(sep).map(h => normalizeKey(h));

  const idx = {
    nom: headers.indexOf('nom'),
    prenom: headers.indexOf('prenom'),
    adresse: headers.indexOf('adresse'),
    ville: headers.indexOf('ville'),
    cp: Math.max(headers.indexOf('code_postal'), headers.indexOf('cp'), headers.indexOf('codepostal')),
    journal: Math.max(headers.indexOf('journal'), headers.indexOf('liste'), headers.indexOf('publication'), headers.indexOf('produit')),
    notes: Math.max(headers.indexOf('notes'), headers.indexOf('note')),
  };

  if (idx.adresse === -1) {
    const alt = headers.findIndex(h => h.includes('adr') || h.includes('rue'));
    if (alt !== -1) idx.adresse = alt;
  }

  if (idx.journal === -1) return { error: 'no-journal-column' };

  const byKey = {};
  const order = [];

  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const cols = lines[i].split(sep).map(c => c.trim().replace(/^"|"$/g,''));

    let adresseRaw = idx.adresse >= 0 ? (cols[idx.adresse] || '') : '';
    let ville = idx.ville >= 0 ? (cols[idx.ville] || '') : '';
    let cp = idx.cp >= 0 ? (cols[idx.cp] || '') : '';

    if (!ville && adresseRaw.includes(',')) {
      const extracted = extractCityFromAddress(adresseRaw);
      adresseRaw = extracted.street;
      ville = extracted.city;
      if (!cp) cp = extracted.cp;
    }

    const nom = idx.nom >= 0 ? (cols[idx.nom] || '') : '';
    const prenom = idx.prenom >= 0 ? (cols[idx.prenom] || '') : '';
    const journal = idx.journal >= 0 ? (cols[idx.journal] || '').trim() : '';
    const note = idx.notes >= 0 ? (cols[idx.notes] || '') : '';

    if (!adresseRaw || !nom) continue;

    const key = normalizeKey(nom) + '|' + normalizeKey(adresseRaw);
    if (!byKey[key]) {
      byKey[key] = {
        id: uid(),
        nom, prenom,
        adresse: adresseRaw,
        ville,
        code_postal: cp,
        lat: null,
        lon: null,
        journaux: [],
        statut_client: 'actif',
        statut_commentaire: '',
        note,
      };
      order.push(key);
    }
    if (journal && !byKey[key].journaux.includes(journal)) {
      byKey[key].journaux.push(journal);
    }
  }

  return order.map(k => byKey[k]);
}

// ─── APPLICATION ──────────────────────────────────────────────
const App = {

  init() {
    DB.load();
    setInterval(() => this.updateTourTimer(), 1000);
    document.addEventListener('visibilitychange', () => {
      const s = state.session;
      if (document.visibilityState === 'visible' && s && s.startedAt && !s.finishedAt && !s.workEndedAt) this.keepAwake(true);
    });
    this.renderHome();
    this.initGeolocation();
  },

  // ── ACCUEIL ──────────────────────────────────────────────────
  renderHome() {
    const now = new Date();
    const day = now.getDay();
    const date = now.getDate();

    document.getElementById('home-date-num').textContent = date;
    document.getElementById('home-date-day').textContent =
      `${DAYS_FR[day]} ${date} ${MONTHS_FR[now.getMonth()]} ${now.getFullYear()}`;

    const container = document.getElementById('home-routes-list');
    container.innerHTML = '';

    if (state.clients.length === 0) {
      container.innerHTML = `
        <div class="no-route">
          <span class="no-route-icon">📰</span>
          <strong>Aucun client</strong><br><br>
          <span>Allez dans <strong>Paramètres ⚙️</strong> pour importer vos adresses (CSV avec colonne journal).</span>
        </div>`;
      return;
    }

    // Tournée en cours (session déjà générée et non terminée/vidée) ?
    if (state.session && state.session.stops && state.session.stops.length) {
      const total = state.session.stops.length;
      const done = state.session.stops.filter(s => s.status !== 'pending').length;
      const card = document.createElement('div');
      card.className = 'route-card today';
      card.innerHTML = `
        <div class="route-icon">📋</div>
        <div class="route-info">
          <div class="route-name">Tournée en cours<span class="badge-today">Aujourd'hui</span></div>
          <div class="route-meta">${(state.session.selectedJournaux || []).join(', ')}</div>
          <div class="route-count">${total} arrêts · ${done}/${total} traités</div>
        </div>
        <div style="font-size:1.4rem">›</div>`;
      card.onclick = () => this.showRoute();
      container.appendChild(card);
    }

    // Checklist des journaux disponibles (clients actifs uniquement)
    const activeClients = state.clients.filter(c => (c.statut_client || 'actif') === 'actif' && livreCeJour(c, day));
    const journaux = this.getJournalCounts(activeClients);

    const sec = document.createElement('div');
    const title = document.createElement('div');
    title.className = 'section-title';
    title.style.padding = '0 4px';
    title.textContent = 'Journaux à distribuer aujourd\'hui';
    sec.appendChild(title);

    if (journaux.length === 0) {
      sec.innerHTML += `<p style="color:var(--text-2); font-size:0.9rem; padding:8px 4px;">Aucun journal actif. Importez un CSV ou vérifiez le statut de vos clients.</p>`;
      container.appendChild(sec);
      return;
    }

    const selectDiv = document.createElement('div');
    selectDiv.style.padding = '12px 8px';
    selectDiv.style.backgroundColor = 'var(--bg)';
    selectDiv.style.borderRadius = '8px';
    selectDiv.style.marginBottom = '12px';

    journaux.forEach(({ code, count }) => {
      const checked = (state.selectedJournaux || []).includes(code);
      const row = document.createElement('div');
      row.className = 'journal-check-row';
      row.innerHTML = `
        <input type="checkbox" id="journal-check-${code.replace(/[^a-z0-9]/gi,'_')}" class="journal-checkbox" data-journal="${code}" ${checked ? 'checked' : ''} style="width:18px; height:18px; margin-right:10px; cursor:pointer;">
        <label for="journal-check-${code.replace(/[^a-z0-9]/gi,'_')}" style="flex:1; cursor:pointer; margin:0;">
          <strong>${code}</strong><br>
          <span style="font-size:0.85rem; color:var(--text-2);">${count} client${count !== 1 ? 's' : ''}</span>
        </label>
      `;
      selectDiv.appendChild(row);
    });

    sec.appendChild(selectDiv);

    const launchBtn = document.createElement('button');
    launchBtn.className = 'btn-primary';
    launchBtn.textContent = '▶️ Générer la tournée';
    launchBtn.style.width = '100%';
    launchBtn.onclick = () => this.generateDailyTour();
    sec.appendChild(launchBtn);

    container.appendChild(sec);
  },

  getJournalCounts(clients) {
    const map = {};
    clients.forEach(c => (c.journaux || []).forEach(j => { map[j] = (map[j] || 0) + 1; }));
    return Object.entries(map).sort((a, b) => b[1] - a[1]).map(([code, count]) => ({ code, count }));
  },

  getJournalCodes() {
    const set = new Set();
    state.clients.forEach(c => (c.journaux || []).forEach(j => set.add(j)));
    return [...set].sort();
  },

  async generateDailyTour() {
    if (state._computing) return;
    const checked = [...document.querySelectorAll('.journal-checkbox:checked')].map(cb => cb.dataset.journal);
    if (checked.length === 0) { toast('❌ Sélectionne au moins un journal'); return; }

    state.selectedJournaux = checked;
    DB.saveSelection();

    const matching = state.clients.filter(c =>
      (c.statut_client || 'actif') === 'actif' &&
      livreCeJour(c, new Date().getDay()) &&
      (c.journaux || []).some(j => checked.includes(j))
    );

    if (matching.length === 0) { toast('❌ Aucun client actif pour ces journaux'); return; }

    const stops = matching.map(c => ({
      ...c,
      journauxDuJour: (c.journaux || []).filter(j => checked.includes(j)),
      status: 'pending',
    }));

    // Tournée dans l'ordre de la liste (ta tournée habituelle), au départ du dépôt ;
    // les kilomètres sont calculés par la route (trajet d'approche inclus).
    // L'optimisation reste disponible via le bouton 🔄 Réorganiser.
    const from = { lat: DEPART.lat, lon: DEPART.lon };
    const orderedStops = stops;
    let approx = false;
    state._computing = true;
    toast("🛣 Calcul des kilomètres par la route…", 15000);
    let road = null;
    try { road = await buildRoadDist(from, stops); } catch (e) { approx = true; }
    annotateLegs(orderedStops, from, road);
    state._computing = false;
    const km = orderedStops.reduce((sum, s) => sum + (s.legKm || 0), 0);
    toast(approx ? `⚠️ Hors ligne : ~${km.toFixed(1)} km estimés (vol d'oiseau × 1,3)`
                 : `✅ ${orderedStops.length} arrêts · ${km.toFixed(1)} km par la route`, 4000);

    state.session = {
      selectedJournaux: checked,
      stops: orderedStops,
      timeConstraint: null,
      generatedAt: new Date().toISOString(),
      kmApprox: approx,
      startedAt: null,
      workEndedAt: null,
      finishedAt: null,
    };

    DB.saveSession();
    this.showCurrentStop();
  },

  showCurrentStop() {
    if (!state.session) return;
    const idx = state.session.stops.findIndex(s => s.status === 'pending');
    if (idx >= 0) {
      this.showStop(idx);
    } else {
      this.showRoute();
    }
  },

  // ── ÉCRAN CARTE ──────────────────────────────────────────────
  showRoute() {
    if (!state.session) return;
    showScreen('screen-route');
    document.getElementById('route-screen-title').textContent = 'Tournée du jour';
    this.updateRouteStats();
    this.renderStopsList();
    this.initMap();
  },

  updateRouteStats() {
    if (!state.session) return;
    const stops = state.session.stops;
    const done = stops.filter(s => s.status !== 'pending').length;
    const total = stops.length;
    const pct = total > 0 ? Math.round(done / total * 100) : 0;

    document.getElementById('map-count').textContent = `${done}/${total}`;
    document.getElementById('map-progress').style.width = pct + '%';

    const remaining = stops.filter(s => s.status === 'pending').length;
    const kmLeft = stops.filter(s => s.status === 'pending').reduce((sum, s) => sum + (s.legKm || 0), 0);
    const eta = remaining * STOP_TIME_MIN + (kmLeft / AVG_SPEED_KMH) * 60;
    if (remaining > 0) {
      document.getElementById('map-eta').textContent =
        `~${Math.round(eta)}min · ${kmLeft.toFixed(1)} km${state.session.kmApprox ? '*' : ''}`;
    } else {
      document.getElementById('map-eta').textContent = '✓ Terminé';
    }
    document.getElementById('route-screen-sub').textContent = `${remaining} restants`;
    this.renderTourBar();
  },

  // ── CHRONO DE TOURNÉE ────────────────────────────────────────
  formatDuration(ms) {
    const total = Math.max(0, Math.round(ms / 1000));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    const pad = n => String(n).padStart(2, '0');
    return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
  },

  tourElapsedMs() {
    const s = state.session;
    if (!s || !s.startedAt) return 0;
    const end = new Date(s.finishedAt || s.workEndedAt || Date.now());
    return end - new Date(s.startedAt);
  },

  // Met à jour la barre de chrono (écran carte + écran arrêt)
  renderTourBar() {
    const s = state.session;
    ['tour-bar-route', 'tour-bar-stop'].forEach(id => {
      const bar = document.getElementById(id);
      if (!bar) return;
      if (!s) { bar.innerHTML = ''; return; }
      const allDone = s.stops.length > 0 && s.stops.every(x => x.status !== 'pending');
      if (s.finishedAt) {
        bar.innerHTML = `<span>🏁 Terminée en <strong>${this.formatDuration(this.tourElapsedMs())}</strong> · <span class="tour-km">${this.trackKmText()}</span></span>`;
      } else if (!s.startedAt) {
        bar.innerHTML = `<button class="tour-btn tour-btn-start" onclick="App.startTour()">▶ Démarrer la tournée</button>`;
      } else if (allDone) {
        bar.innerHTML = `<span>⏱ <span class="tour-timer">${this.formatDuration(this.tourElapsedMs())}</span> · <span class="tour-km">${this.trackKmText()}</span></span>
          <button class="tour-btn tour-btn-cancel" onclick="App.cancelTour()">✕ Annuler</button>
          <button class="tour-btn tour-btn-finish" onclick="App.finishTour()">🏁 Terminer la tournée</button>`;
      } else {
        bar.innerHTML = `<span>⏱ <span class="tour-timer">${this.formatDuration(this.tourElapsedMs())}</span> · <span class="tour-km">${this.trackKmText()}</span></span>
          <button class="tour-btn tour-btn-cancel" onclick="App.cancelTour()">✕ Annuler</button>`;
      }
    });
  },

  updateTourTimer() {
    const s = state.session;
    if (!s || !s.startedAt || s.finishedAt || s.workEndedAt) return;
    const txt = this.formatDuration(this.tourElapsedMs());
    document.querySelectorAll('.tour-timer').forEach(el => { el.textContent = txt; });
    const kmTxt = this.trackKmText();
    document.querySelectorAll('.tour-km').forEach(el => { el.textContent = kmTxt; });
  },

  // ── ENREGISTREMENT GPS (kilomètres réellement parcourus) ─────
  trackKmText() {
    const s = state.session;
    const km = s && s.track ? s.track.km : 0;
    const wait = !state.currentPos && !(s && s.track && s.track.points.length) ? ' (GPS…)' : '';
    return `🚗 ${km.toFixed(1)} km${wait}`;
  },

  recordTrackPoint(pos) {
    const s = state.session;
    if (!s || !s.startedAt || s.finishedAt || s.workEndedAt || !s.track) return;
    const c = pos.coords;
    if (c.accuracy > 50) return;                       // position trop imprécise
    const tr = s.track;
    const t = pos.timestamp || Date.now();
    const last = tr.points[tr.points.length - 1];
    if (!last) { tr.points.push([+c.latitude.toFixed(6), +c.longitude.toFixed(6), t]); return; }
    const d = haversine(last[0], last[1], c.latitude, c.longitude);   // km
    if (d < 0.015) return;                             // < 15 m : bruit GPS à l'arrêt
    const dtH = (t - last[2]) / 3600000;
    if (dtH > 0 && d / dtH > 150) return;              // saut aberrant (> 150 km/h)
    tr.km += d;
    tr.points.push([+c.latitude.toFixed(6), +c.longitude.toFixed(6), t]);
    const now = Date.now();
    if (!this._trackSavedAt || now - this._trackSavedAt > 10000) {
      this._trackSavedAt = now;
      DB.saveSession();
    }
  },

  // Garde l'écran allumé pendant la tournée pour que le GPS continue d'enregistrer
  async keepAwake(on) {
    try {
      if (on) {
        if ('wakeLock' in navigator && !this._wakeLock) {
          this._wakeLock = await navigator.wakeLock.request('screen');
          this._wakeLock.addEventListener('release', () => { this._wakeLock = null; });
        }
      } else if (this._wakeLock) {
        await this._wakeLock.release();
        this._wakeLock = null;
      }
    } catch (e) {}
  },

  exportTrackGPX() {
    const s = state.session;
    if (!s || !s.track || s.track.points.length === 0) { toast('Aucun trajet enregistré'); return; }
    const day = new Date(s.startedAt).toISOString().slice(0, 10);
    const pts = s.track.points.map(p =>
      `      <trkpt lat="${p[0]}" lon="${p[1]}"><time>${new Date(p[2]).toISOString()}</time></trkpt>`).join('\n');
    const gpx = `<?xml version="1.0" encoding="UTF-8"?>\n` +
      `<gpx version="1.1" creator="Tournée 237" xmlns="http://www.topografix.com/GPX/1/1">\n` +
      `  <trk>\n    <name>Tournée 237 ${day} — ${s.track.km.toFixed(1)} km</name>\n    <trkseg>\n${pts}\n    </trkseg>\n  </trk>\n</gpx>\n`;
    const blob = new Blob([gpx], { type: 'application/gpx+xml' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `trajet-tournee-237-${day}.gpx`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    toast('📥 Trajet exporté (GPX)');
  },

  startTour() {
    if (!state.session || state.session.startedAt) return;
    state.session.startedAt = new Date().toISOString();
    state.session.track = { points: [], km: 0 };
    if (state.currentPos) {
      state.session.track.points.push([+state.currentPos.lat.toFixed(6), +state.currentPos.lon.toFixed(6), Date.now()]);
    }
    this.keepAwake(true);
    DB.saveSession();
    this.renderTourBar();
    toast('▶ Tournée démarrée');
  },

  // Annule le chrono (démarré par erreur) sans toucher aux livraisons
  cancelTour() {
    const s = state.session;
    if (!s || !s.startedAt || s.finishedAt) return;
    if (!confirm('Annuler le chrono ? Les livraisons déjà faites sont conservées.')) return;
    s.startedAt = null;
    s.workEndedAt = null;
    s.track = null;
    this.keepAwake(false);
    DB.saveSession();
    this.renderTourBar();
    toast('⏹ Chrono annulé');
  },

  finishTour() {
    const s = state.session;
    if (!s || s.finishedAt) return;
    s.finishedAt = s.workEndedAt || new Date().toISOString();
    this.keepAwake(false);
    DB.saveSession();
    this.renderTourBar();

    const delivered = s.stops.filter(x => x.status === 'delivered').length;
    const notDelivered = s.stops.length - delivered;
    const ms = this.tourElapsedMs();
    // Trajet d'approche = du bouton Démarrer à la 1re validation ; livraison = ensuite jusqu'au dernier arrêt
    const firstDoneMs = Math.min(...s.stops.filter(x => x.doneAt).map(x => new Date(x.doneAt).getTime()));
    const startMs = new Date(s.startedAt).getTime();
    const approachMs = isFinite(firstDoneMs) ? Math.max(0, firstDoneMs - startMs) : 0;
    const deliveryMs = Math.max(0, ms - approachMs);
    document.getElementById('tour-summary-duration').textContent = this.formatDuration(ms);
    document.getElementById('tour-summary-detail').innerHTML =
      `${s.stops.length} arrêts · ✅ ${delivered} livrés · ❌ ${notDelivered} non livrés<br>` +
      `Trajet jusqu'au 1er arrêt : ${this.formatDuration(approachMs)} · Livraison : ${this.formatDuration(deliveryMs)}<br>` +
      `Moyenne : ${this.formatDuration(deliveryMs / Math.max(1, s.stops.length))} par arrêt (livraison)<br>` +
      `Distance prévue : ${s.stops.reduce((sum, x) => sum + (x.legKm || 0), 0).toFixed(1)} km${s.kmApprox ? ' (estimée*)' : ' par la route'}<br>` +
      (s.track && s.track.points.length > 1
        ? `<strong>Distance parcourue (GPS) : ${s.track.km.toFixed(1)} km</strong>`
        : `Distance GPS : aucun trajet enregistré`);
    document.getElementById('btn-export-gpx').style.display = s.track && s.track.points.length > 1 ? 'block' : 'none';
    this.openModal('modal-tour-summary');
  },

  renderStopsList() {
    if (!state.session) return;
    const list = document.getElementById('stops-list');
    list.innerHTML = '';
    const stops = state.session.stops;
    const currentIdx = stops.findIndex(s => s.status === 'pending');

    const pending = stops.map((s, i) => ({ s, i })).filter(x => x.s.status === 'pending');
    const traites = stops.map((s, i) => ({ s, i }))
      .filter(x => x.s.status !== 'pending')
      .sort((a, b) => new Date(a.s.doneAt || 0) - new Date(b.s.doneAt || 0));

    const addItem = ({ s, i }) => {
      const isCurrent = i === currentIdx;
      const isDone = s.status !== 'pending';
      const item = document.createElement('div');
      item.className = 'stop-item' +
        (isCurrent ? ' current' : '') +
        (isDone ? (s.status === 'delivered' ? ' delivered' : ' failed') : '');

      const canMove = s.status === 'pending';
      const firstPendingIdx = pending.length > 0 ? pending[0].i : -1;
      const statusIcon = s.status === 'delivered' ? '✅' : s.status === 'failed_client' ? '⚠️' : '❌';

      item.innerHTML = `
        <div class="stop-num">${i + 1}</div>
        <div class="stop-info">
          <div class="stop-name">${s.nom || s.adresse}</div>
          <div class="stop-addr">${s.adresse}${s.ville ? ', ' + s.ville : ''}</div>
          ${(s.journauxDuJour && s.journauxDuJour.length) ? `<div class="journal-badges">${journalBadges(s.journauxDuJour)}</div>` : ''}
        </div>
        ${canMove && i !== firstPendingIdx ? `<button class="stop-move-top-btn" onclick="event.stopPropagation();App.moveStopToTop(${i})">⬆ Premier</button>` : ''}
        ${isDone ? `<div class="stop-status-icon">${statusIcon}</div>` : ''}
      `;
      item.onclick = () => this.showStop(i);
      list.appendChild(item);
    };

    const addSection = (label, items) => {
      if (items.length === 0) return;
      const hdr = document.createElement('div');
      hdr.className = 'stops-section-header';
      hdr.textContent = label;
      list.appendChild(hdr);
      items.forEach(addItem);
    };

    addSection(`📋 À livrer (${pending.length})`, pending);
    addSection(`✅ Traités (${traites.length})`, traites);

    if (currentIdx >= 0) {
      const allItems = list.querySelectorAll('.stop-item.current');
      allItems.forEach(el => el.scrollIntoView({ behavior: 'smooth', block: 'nearest' }));
    }
  },

  moveStopToTop(idx) {
    if (!state.session) return;
    const stops = state.session.stops;
    const firstPendingIdx = stops.findIndex(s => s.status === 'pending');
    if (firstPendingIdx < 0 || idx <= firstPendingIdx) return;
    const [moved] = stops.splice(idx, 1);
    stops.splice(firstPendingIdx, 0, moved);
    DB.saveSession();
    this.renderStopsList();
    this.updateMap && this.updateMap();
    const list = document.getElementById('stops-list');
    list.scrollTop = 0;
  },

  // ── CARTE LEAFLET ─────────────────────────────────────────────
  initMap() {
    if (!state.map) {
      state.map = L.map('map', { zoomControl: true, attributionControl: false });
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19
      }).addTo(state.map);
      // Fix Leaflet icon path
      delete L.Icon.Default.prototype._getIconUrl;
      L.Icon.Default.mergeOptions({
        iconRetinaUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png',
        iconUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png',
        shadowUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png',
      });
    }

    // Nettoyer les anciens marqueurs
    state.markers.forEach(m => m.remove());
    state.markers = [];

    if (!state.session) return;
    const stops = state.session.stops;
    const geocoded = stops.filter(s => s.lat);
    if (geocoded.length === 0) {
      if (state.currentPos) {
        state.map.setView([state.currentPos.lat, state.currentPos.lon], 14);
      }
      return;
    }

    const currentIdx = stops.findIndex(s => s.status === 'pending');

    geocoded.forEach((s, _) => {
      const origIdx = stops.indexOf(s);
      const isCurrent = origIdx === currentIdx;
      const isDone = s.status !== 'pending';

      const color = isDone ? (s.status === 'delivered' ? '#2e7d32' : '#c62828') :
                   isCurrent ? '#1565c0' : '#757575';

      const markerHtml = `
        <div style="background:${color}; color:white; border-radius:50%; width:28px; height:28px;
          display:flex; align-items:center; justify-content:center; font-size:11px; font-weight:700;
          border:2px solid white; box-shadow:0 2px 6px rgba(0,0,0,0.3);">
          ${origIdx + 1}
        </div>`;

      const icon = L.divIcon({ html: markerHtml, className: '', iconSize: [28,28], iconAnchor: [14,14] });
      const marker = L.marker([s.lat, s.lon], { icon }).addTo(state.map);
      marker.on('click', () => this.showStop(origIdx));
      state.markers.push(marker);
    });

    // Centrer sur l'arrêt actuel ou tous les stops
    if (currentIdx >= 0 && stops[currentIdx] && stops[currentIdx].lat) {
      state.map.setView([stops[currentIdx].lat, stops[currentIdx].lon], 15);
    } else {
      const bounds = L.latLngBounds(geocoded.map(s => [s.lat, s.lon]));
      state.map.fitBounds(bounds, { padding: [20, 20] });
    }

    // Position GPS
    this.updatePosMarker();

    // Invalider la taille (fix pour les layouts flex)
    setTimeout(() => state.map && state.map.invalidateSize(), 100);

    // Afficher les trajets optimisés
    this.drawRoute();
  },

  drawRoute() {
    if (!state.session || !state.map) return;

    // Supprimer le routing précédent
    if (state.routing) {
      state.map.removeControl(state.routing);
      state.routing = null;
    }

    const stops = state.session.stops.filter(s => s.lat && s.lon && s.status === 'pending');
    if (stops.length < 2) return;

    // Construire les waypoints
    const waypoints = stops.map(s => L.latLng(s.lat, s.lon));

    // Créer le routing avec OSRM (gratuit et public)
    state.routing = L.Routing.control({
      waypoints: waypoints,
      router: L.Routing.osrmv1({ serviceUrl: 'https://router.project-osrm.org/route/v1' }),
      show: false,
      addWaypoints: false,
      draggableWaypoints: false,
      fitSelectedRoutes: false,
      lineOptions: {
        styles: [{ color: '#1565c0', opacity: 0.7, weight: 4 }]
      }
    }).addTo(state.map);
  },

  goToCurrentStop() {
    if (!state.session) return;
    const idx = state.session.stops.findIndex(s => s.status === 'pending');
    if (idx >= 0 && state.session.stops[idx].lat) {
      const s = state.session.stops[idx];
      state.map && state.map.setView([s.lat, s.lon], 16);
    }
  },

  updatePosMarker() {
    if (!state.currentPos || !state.map) return;
    if (state.posMarker) state.posMarker.remove();
    const icon = L.divIcon({
      html: `<div style="background:#1e88e5; border:3px solid white; border-radius:50%; width:16px; height:16px; box-shadow:0 0 0 4px rgba(30,136,229,0.3)"></div>`,
      className: '', iconSize: [16,16], iconAnchor: [8,8]
    });
    state.posMarker = L.marker([state.currentPos.lat, state.currentPos.lon], { icon }).addTo(state.map);
  },

  // ── DÉTAIL D'UN ARRÊT ─────────────────────────────────────────
  showStop(idx) {
    if (!state.session) return;
    state.session.currentStopIdx = idx;
    DB.saveSession();

    const stop = state.session.stops[idx];
    const total = state.session.stops.length;

    document.getElementById('stop-progress-text').textContent = `${idx+1} / ${total}`;
    this.renderTourBar();
    document.getElementById('stop-addr').textContent = stop.adresse;
    document.getElementById('stop-city').textContent = `${stop.code_postal || ''} ${stop.ville || ''}`.trim();
    document.getElementById('stop-name').textContent = stop.nom || '';
    document.getElementById('stop-note-input').value = stop.note || '';

    const journauxEl = document.getElementById('stop-journaux');
    if (journauxEl) journauxEl.innerHTML = journalBadges(stop.journauxDuJour || stop.journaux || []);

    // Afficher la note en évidence si elle existe
    const noteDisplay = document.getElementById('stop-note-display');
    if (stop.note) {
      noteDisplay.textContent = '📝 ' + stop.note;
      noteDisplay.classList.add('visible');
    } else {
      noteDisplay.textContent = '';
      noteDisplay.classList.remove('visible');
    }

    // Contrainte horaire ?
    const badge = document.getElementById('stop-constraint-badge');
    if (state.session.timeConstraint && state.session.timeConstraint.stopId === stop.id) {
      badge.style.display = 'flex';
      document.getElementById('stop-constraint-text').textContent =
        `Arrivée souhaitée à ${state.session.timeConstraint.time}`;
    } else {
      badge.style.display = 'none';
    }

    showScreen('screen-stop');
  },

  markStop(status) {
    if (!state.session) return;
    const idx = state.session.currentStopIdx;
    if (idx == null) return;
    const stop = state.session.stops[idx];
    stop.status = status;
    stop.note = document.getElementById('stop-note-input').value;
    stop.doneAt = new Date().toISOString();
    DB.saveSession();

    if (status === 'failed_client') {
      this.promptClientStatus(stop);
    }

    const msg = status === 'delivered' ? '✅ Livré !' :
                status === 'failed_client' ? '⚠️ Non livré — statut client' : '❌ Non livré';
    toast(msg);

    // Passer au suivant
    const nextIdx = state.session.stops.findIndex((s, i) => i > idx && s.status === 'pending');
    if (nextIdx >= 0) {
      this.showStop(nextIdx);
    } else {
      const anyPending = state.session.stops.findIndex(s => s.status === 'pending');
      if (anyPending >= 0) {
        this.showStop(anyPending);
      } else {
        // Fin du temps de travail = dernier arrêt validé (le trajet retour n'est pas compté)
        if (state.session.startedAt && !state.session.workEndedAt) {
          state.session.workEndedAt = stop.doneAt;
          this.keepAwake(false);
          DB.saveSession();
        }
        toast('🎉 Dernier arrêt fait — appuie sur « Terminer la tournée »', 4000);
        this.updateRouteStats();
        this.backToRoute();
      }
    }
  },

  // ── STATUT CLIENT (déclenché depuis "pas livré - raison client") ──
  promptClientStatus(stop) {
    state._clientStatusTargetId = stop.id;
    document.getElementById('client-status-name').textContent = stop.nom || stop.adresse;
    document.getElementById('client-status-select').value = 'vacances';
    document.getElementById('client-status-comment').value = '';
    this.openModal('modal-client-status');
  },

  saveClientStatus() {
    const id = state._clientStatusTargetId;
    const client = state.clients.find(c => c.id === id);
    if (client) {
      client.statut_client = document.getElementById('client-status-select').value;
      client.statut_commentaire = document.getElementById('client-status-comment').value.trim();
      DB.save();
      toast('✅ Statut client mis à jour');
    }
    this.closeModal('modal-client-status');
  },

  skipStop() {
    if (!state.session) return;
    const idx = state.session.currentStopIdx;
    if (idx == null) return;

    // Déplacer cet arrêt à la fin des pending
    const stop = state.session.stops.splice(idx, 1)[0];
    const lastPendingIdx = state.session.stops.reduce((last, s, i) => s.status === 'pending' ? i : last, -1);
    state.session.stops.splice(lastPendingIdx + 1, 0, stop);
    DB.saveSession();
    toast('⏭ Arrêt déplacé plus tard');

    const nextIdx = state.session.stops.findIndex(s => s.status === 'pending');
    if (nextIdx >= 0) {
      this.showStop(nextIdx);
    } else {
      this.backToRoute();
    }
  },

  openNavigation() {
    if (!state.session) return;
    const idx = state.session.currentStopIdx;
    const stop = state.session.stops[idx];
    if (!stop) return;

    const q = encodeURIComponent(`${stop.adresse}, ${stop.code_postal || ''} ${stop.ville || ''}`);
    // Essayer Google Maps en priorité, fallback sur maps universel
    const url = `https://www.google.com/maps/dir/?api=1&destination=${q}&travelmode=driving`;
    window.open(url, '_blank');
  },

  backToRoute() {
    if (state.session && state.session.currentStopIdx != null) {
      // Sauvegarder la note avant de partir
      const stop = state.session.stops[state.session.currentStopIdx];
      if (stop) stop.note = document.getElementById('stop-note-input').value;
      DB.saveSession();
    }
    this.updateRouteStats();
    this.renderStopsList();
    this.initMap();
    showScreen('screen-route');
  },

  // ── RÉORGANISER ──────────────────────────────────────────────
  async reorganize() {
    if (!state.session || state._computing) return;

    const pending = state.session.stops.filter(s => s.status === 'pending');
    const done = state.session.stops.filter(s => s.status !== 'pending');

    if (pending.length === 0) { toast('Plus rien à réorganiser'); return; }

    // Point de départ : GPS, sinon dernier arrêt traité (là où je suis), sinon 1er arrêt restant
    const lastDone = done
      .filter(s => s.lat != null && s.lon != null && s.doneAt)
      .sort((a, b) => new Date(b.doneAt) - new Date(a.doneAt))[0];
    const firstPending = pending.find(s => s.lat != null && s.lon != null);
    const anchor = lastDone || firstPending;
    const from = state.currentPos || (anchor ? { lat: anchor.lat, lon: anchor.lon } : null);
    if (!from) { toast('Position GPS non disponible'); return; }

    const nowD = new Date();
    const nowStr = formatTime(nowD.getHours(), nowD.getMinutes());

    state._computing = true;
    toast("🛣 Calcul de l'itinéraire par la route…", 15000);
    let road = null, approx = false;
    try { road = await buildRoadDist(from, pending); } catch (e) { approx = true; }

    const constraint = state.session.timeConstraint;
    const optimized = optimizeRoute(
      pending,
      from.lat, from.lon,
      constraint ? constraint.stopId : null,
      constraint ? constraint.time : null,
      nowStr,
      road ? road.sym : null
    );
    annotateLegs(optimized, from, road);
    state._computing = false;
    if (approx) state.session.kmApprox = true;

    state.session.stops = [...done, ...optimized];
    DB.saveSession();

    const kmLeft = optimized.reduce((sum, s) => sum + (s.legKm || 0), 0);
    toast(approx ? `⚠️ Hors ligne : réorganisée, ~${kmLeft.toFixed(1)} km restants (estimé)`
                 : `🔄 Réorganisée : ${kmLeft.toFixed(1)} km restants par la route`, 4000);
    this.renderStopsList();
    this.initMap();
  },

  // ── CONTRAINTE HORAIRE ────────────────────────────────────────
  setTimeConstraint() {
    const idx = state.session ? state.session.currentStopIdx : null;
    if (idx == null) return;
    const stop = state.session.stops[idx];
    const existing = state.session.timeConstraint;
    document.getElementById('constraint-time').value =
      existing && existing.stopId === stop.id ? existing.time : '09:00';
    this.openModal('modal-constraint');
  },

  saveConstraint() {
    const time = document.getElementById('constraint-time').value;
    const idx = state.session ? state.session.currentStopIdx : null;
    if (idx == null || !time) return;
    const stop = state.session.stops[idx];
    state.session.timeConstraint = { stopId: stop.id, time };
    DB.saveSession();
    toast(`⏰ Contrainte : arriver à ${time}`);
    this.closeModal('modal-constraint');
    this.showStop(idx);
  },

  clearConstraint() {
    state.session && (state.session.timeConstraint = null);
    DB.saveSession();
    this.closeModal('modal-constraint');
    const idx = state.session ? state.session.currentStopIdx : null;
    if (idx != null) this.showStop(idx);
    toast('Contrainte supprimée');
  },

  // ── PARAMÈTRES ────────────────────────────────────────────────
  showSettings() {
    const total = state.clients.length;
    const geocoded = state.clients.filter(c => c.lat).length;

    document.getElementById('setting-clients-count').textContent = `${total} client${total !== 1 ? 's' : ''}`;
    document.getElementById('setting-geocode-status').textContent =
      total > 0 ? `${geocoded}/${total}` : '';
    showScreen('screen-settings');
  },

  resetSession() {
    if (!confirm('Réinitialiser la session ? Tous les statuts seront perdus.')) return;
    state.session = null;
    DB.saveSession();
    toast('Session réinitialisée');
  },

  // Charge la liste fournie (extraite du PDF de distribution) avec les
  // coordonnées GPS déjà calculées. À remplacer par un vrai import CSV dès
  // que le fichier nettoyé est disponible.
  restoreArchive() {
    if (state.clients.length > 0 &&
        !confirm(`Remplacer les ${state.clients.length} clients actuels par la liste fournie (99 clients géocodés) ?`)) {
      return;
    }
    fetch('./archive-clients.json', { cache: 'no-store' })
      .then(r => r.json())
      .then(clients => {
        if (state.clients.length > 0) DB.archive();
        state.clients = clients;
        state.session = null;
        DB.save();
        DB.saveSession();
        toast(`✅ ${clients.length} clients restaurés depuis l'archive`);
        this.showSettings();
      })
      .catch(() => toast('❌ Impossible de charger l\'archive'));
  },

  exportBackup() {
    if (state.clients.length === 0) { toast('Aucune donnée à exporter'); return; }
    const blob = new Blob([JSON.stringify(state.clients, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `clients-backup-${new Date().toISOString().slice(0,10)}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    toast('💾 Sauvegarde téléchargée');
  },

  goHome() {
    this.renderHome();
    showScreen('screen-home');
  },

  // ── IMPORT CSV ────────────────────────────────────────────────
  showImportCSV() {
    document.getElementById('csv-preview').style.display = 'none';
    document.getElementById('csv-file-input').value = '';
    state._pendingImportClients = null;
    this.openModal('modal-csv');

    document.getElementById('csv-file-input').onchange = function() {
      const file = this.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = e => {
        const clients = parseClientsCSV(e.target.result);
        const preview = document.getElementById('csv-preview');
        if (!clients || clients.error) {
          preview.innerHTML = '⚠️ Colonne "journal" introuvable ou aucune adresse détectée. Vérifiez le format.';
          preview.style.display = 'block';
          state._pendingImportClients = null;
          return;
        }
        const journaux = [...new Set(clients.flatMap(c => c.journaux))];
        preview.innerHTML = `✅ <strong>${clients.length} clients</strong> détectés, <strong>${journaux.length} journal(aux)</strong> : ${journaux.join(', ')}` +
          (state.clients.length > 0
            ? `<br><span style="color:#c62828">⚠️ Ceci remplacera les ${state.clients.length} clients actuels (une sauvegarde locale sera faite automatiquement).</span>`
            : '');
        preview.style.display = 'block';
        state._pendingImportClients = clients;
      };
      reader.readAsText(file);
    };
  },

  importCSV() {
    const clients = state._pendingImportClients;
    if (!clients || clients.length === 0) { toast('⚠️ Choisissez un fichier CSV valide'); return; }

    if (state.clients.length > 0 &&
        !confirm(`Remplacer les ${state.clients.length} clients actuels par les ${clients.length} nouveaux ? Une sauvegarde locale sera conservée.`)) {
      return;
    }

    if (state.clients.length > 0) DB.archive();

    state.clients = clients;
    state.session = null;
    DB.save();
    DB.saveSession();
    toast(`✅ ${clients.length} clients importés !`);
    this.closeModal('modal-csv');
    this.renderHome();
  },

  // ── GESTION DES CLIENTS ────────────────────────────────────────
  showManageClients() {
    state.editingClientId = null;
    this.renderClientsList();
    this.openModal('modal-addresses');
  },

  renderClientsList() {
    const searchTerm = document.getElementById('address-search').value.toLowerCase();
    const filtered = state.clients.filter(c =>
      !searchTerm || c.nom.toLowerCase().includes(searchTerm) || c.adresse.toLowerCase().includes(searchTerm)
    );

    const html = filtered.map(c => {
      const statutLabel = STATUT_CLIENT_LABELS[c.statut_client] || '';
      return `
      <div style="padding:10px; border-bottom:1px solid var(--border); display:flex; justify-content:space-between; align-items:center;">
        <div style="flex:1;">
          <strong>${c.nom}${c.prenom ? ' ' + c.prenom : ''}</strong>
          ${statutLabel ? `<span class="client-status-badge ${c.statut_client}">${statutLabel}</span>` : ''}<br>
          <span style="font-size:0.85rem; color:var(--text-2);">${c.adresse}, ${c.code_postal} ${c.ville}</span><br>
          <span style="font-size:0.78rem; color:var(--text-2);">${(c.journaux||[]).join(', ') || 'Aucun journal'}</span>
        </div>
        <button class="btn-sm" onclick="App.editClient('${c.id}')" style="margin-right:6px;">✏️</button>
      </div>
    `;
    }).join('');

    document.getElementById('addresses-list-modal').innerHTML = html || '<p style="padding:10px; color:var(--text-2);">Aucun client trouvé</p>';
  },

  filterClients() {
    this.renderClientsList();
  },

  renderJournalCheckboxes(selected) {
    const container = document.getElementById('addr-journaux');
    const known = this.getJournalCodes();
    container.innerHTML = '';
    known.forEach(code => {
      const safeId = 'jcb-' + code.replace(/[^a-z0-9]/gi, '_');
      const row = document.createElement('label');
      row.className = 'journal-check-row';
      row.innerHTML = `<input type="checkbox" value="${code}" id="${safeId}" ${selected.includes(code) ? 'checked' : ''} style="width:18px;height:18px;margin-right:10px;"> ${code}`;
      container.appendChild(row);
    });
    const addRow = document.createElement('div');
    addRow.style.marginTop = '8px';
    addRow.innerHTML = `<input type="text" class="form-input" id="addr-journal-new" placeholder="+ Nouveau code journal">`;
    container.appendChild(addRow);
  },

  renderJoursCheckboxes(selected) {
    const container = document.getElementById('addr-jours');
    const all = !selected || selected.length === 0;
    container.innerHTML = '';
    [1, 2, 3, 4, 5, 6, 0].forEach(d => {
      const row = document.createElement('label');
      row.className = 'journal-check-row';
      row.innerHTML = `<input type="checkbox" value="${d}" ${all || selected.includes(d) ? 'checked' : ''} style="width:18px;height:18px;margin-right:10px;"> ${DAYS_FR[d]}`;
      container.appendChild(row);
    });
  },

  showAddClientForm() {
    state.editingClientId = null;
    document.getElementById('edit-address-title').textContent = 'Ajouter un client';
    document.getElementById('addr-name').value = '';
    document.getElementById('addr-prenom').value = '';
    document.getElementById('addr-address').value = '';
    document.getElementById('addr-city').value = '';
    document.getElementById('addr-postal').value = '';
    document.getElementById('addr-statut').value = 'actif';
    document.getElementById('addr-statut-comment').value = '';
    this.renderJournalCheckboxes([]);
    this.renderJoursCheckboxes([]);
    document.getElementById('btn-delete-address').style.display = 'none';

    this.closeModal('modal-addresses');
    this.openModal('modal-edit-address');
  },

  editClient(clientId) {
    const client = state.clients.find(c => c.id === clientId);
    if (!client) return;

    state.editingClientId = clientId;
    document.getElementById('edit-address-title').textContent = 'Modifier le client';
    document.getElementById('addr-name').value = client.nom;
    document.getElementById('addr-prenom').value = client.prenom || '';
    document.getElementById('addr-address').value = client.adresse;
    document.getElementById('addr-city').value = client.ville;
    document.getElementById('addr-postal').value = client.code_postal;
    document.getElementById('addr-statut').value = client.statut_client || 'actif';
    document.getElementById('addr-statut-comment').value = client.statut_commentaire || '';
    this.renderJournalCheckboxes(client.journaux || []);
    this.renderJoursCheckboxes(client.jours || []);

    document.getElementById('btn-delete-address').style.display = 'block';
    this.closeModal('modal-addresses');
    this.openModal('modal-edit-address');
  },

  saveClient() {
    const nom = document.getElementById('addr-name').value.trim();
    const prenom = document.getElementById('addr-prenom').value.trim();
    const adresse = document.getElementById('addr-address').value.trim();
    const ville = document.getElementById('addr-city').value.trim();
    const code_postal = document.getElementById('addr-postal').value.trim();
    const statut_client = document.getElementById('addr-statut').value;
    const statut_commentaire = document.getElementById('addr-statut-comment').value.trim();
    const journaux = [...document.querySelectorAll('#addr-journaux input[type=checkbox]:checked')].map(cb => cb.value);
    const newJournalInput = document.getElementById('addr-journal-new');
    const newJournal = newJournalInput ? newJournalInput.value.trim() : '';
    if (newJournal && !journaux.includes(newJournal)) journaux.push(newJournal);
    const joursCoches = [...document.querySelectorAll('#addr-jours input[type=checkbox]:checked')].map(cb => parseInt(cb.value, 10));
    if (joursCoches.length === 0) { toast('❌ Coche au moins un jour de livraison'); return; }
    const jours = joursCoches.length === 7 ? [] : joursCoches;

    if (!nom || !adresse || !ville || !code_postal) {
      toast('❌ Nom, adresse, ville et code postal sont obligatoires');
      return;
    }

    if (state.editingClientId) {
      const client = state.clients.find(c => c.id === state.editingClientId);
      if (client) {
        Object.assign(client, { nom, prenom, adresse, ville, code_postal, statut_client, statut_commentaire, journaux, jours });
      }
      DB.save();
      toast('✏️ Client modifié');
      this.closeModal('modal-edit-address');
      this.showManageClients();
    } else {
      const client = {
        id: uid(), nom, prenom, adresse, ville, code_postal,
        lat: null, lon: null, journaux, jours, statut_client, statut_commentaire, note: '',
      };
      state.clients.push(client);
      DB.save();
      this.closeModal('modal-edit-address');
      this.showManageClients();
      toast('📍 Client ajouté, géocodage en cours...');
      geocodeAddress(client).then(ok => {
        DB.save();
        toast(ok ? '✅ Client géocodé' : '⚠️ Géocodage échoué (réessayez depuis Paramètres)');
        this.renderClientsList();
      }).catch(() => {
        toast('⚠️ Géocodage échoué (réessayez depuis Paramètres)');
      });
    }
  },

  deleteClient() {
    if (!state.editingClientId) return;
    if (!confirm('Supprimer ce client définitivement ?')) return;

    state.clients = state.clients.filter(c => c.id !== state.editingClientId);
    state.editingClientId = null;
    DB.save();
    toast('❌ Client supprimé');
    this.closeModal('modal-edit-address');
    this.showManageClients();
  },

  // ── GÉOCODAGE ─────────────────────────────────────────────────
  showGeocodeAll() {
    const total = state.clients.length;
    const done = state.clients.filter(c => c.lat).length;

    document.getElementById('geocode-status-text').textContent =
      total === 0 ? 'Aucune adresse à géocoder. Importez d\'abord un CSV.' :
      `${done}/${total} adresses géocodées`;
    document.getElementById('geocode-bar').style.width = total > 0 ? (done/total*100) + '%' : '0%';
    document.getElementById('geocode-count').textContent = '';
    document.getElementById('btn-start-geocode').disabled = (total === 0);
    state.geocodeStop = false;
    this.openModal('modal-geocode');
  },

  async startGeocode() {
    const toGeocode = state.clients.filter(c => !c.lat);
    const total = state.clients.length;

    if (toGeocode.length === 0) { toast('Tout est déjà géocodé !'); return; }

    state.geocodeRunning = true;
    state.geocodeStop = false;
    document.getElementById('btn-start-geocode').disabled = true;
    document.getElementById('btn-stop-geocode').textContent = '⏹ Stop';

    let done = state.clients.filter(c => c.lat).length;
    let errors = 0;

    for (const client of toGeocode) {
      if (state.geocodeStop) break;

      document.getElementById('geocode-status-text').textContent =
        `Géocodage : ${client.adresse}, ${client.ville}`;
      document.getElementById('geocode-count').textContent =
        `${done}/${total} faits · ${errors} erreurs`;
      document.getElementById('geocode-bar').style.width = (done/total*100) + '%';

      try {
        const ok = await geocodeAddress(client);
        if (ok) done++; else errors++;
      } catch(e) { errors++; }

      DB.save();
      await new Promise(r => setTimeout(r, GEOCODE_DELAY));
    }

    state.geocodeRunning = false;
    document.getElementById('geocode-status-text').textContent = `Terminé ! ${done}/${total} géocodés`;
    document.getElementById('btn-start-geocode').disabled = false;
    document.getElementById('btn-stop-geocode').textContent = '✕';
    document.getElementById('setting-geocode-status').textContent = `${done}/${total}`;
  },

  stopGeocode() {
    if (state.geocodeRunning) {
      state.geocodeStop = true;
      document.getElementById('geocode-status-text').textContent = 'Arrêt en cours...';
    } else {
      this.closeModal('modal-geocode');
    }
  },

  // ── MODALS ────────────────────────────────────────────────────
  openModal(id) {
    document.getElementById(id).classList.remove('hidden');
  },

  closeModal(id) {
    document.getElementById(id).classList.add('hidden');
  },

  // ── GÉOLOCALISATION ───────────────────────────────────────────
  initGeolocation() {
    if (!navigator.geolocation) return;
    navigator.geolocation.watchPosition(
      pos => {
        state.currentPos = { lat: pos.coords.latitude, lon: pos.coords.longitude };
        this.recordTrackPoint(pos);
        if (state.map) this.updatePosMarker();
      },
      () => {},
      { enableHighAccuracy: true, maximumAge: 10000, timeout: 30000 }
    );
  },
};

// ─── FERMER MODAL EN CLIQUANT L'OVERLAY ──────────────────────
document.querySelectorAll('.modal-overlay').forEach(overlay => {
  overlay.addEventListener('click', e => {
    if (e.target === overlay) {
      const id = overlay.id;
      // Ne pas fermer si géocodage en cours
      if (id === 'modal-geocode' && state.geocodeRunning) return;
      App.closeModal(id);
    }
  });
});

// ─── DÉMARRAGE ────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => App.init());
