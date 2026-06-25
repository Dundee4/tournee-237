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
const GEOCODE_DELAY = 1100; // ms entre requêtes Nominatim

// ─── ÉTAT GLOBAL ──────────────────────────────────────────────
let state = {
  routes: [],         // [{id, name, weekdays[], monthdays[], startTime, stops:[]}]
  session: null,      // Session de livraison active
  geocodeRunning: false,
  geocodeStop: false,
  editingRouteId: null,
  map: null,
  markers: [],
  posMarker: null,
  currentPos: null,
  routing: null,      // Instance Leaflet Routing Machine
};

// ─── STORAGE ──────────────────────────────────────────────────
const DB = {
  save() {
    try { localStorage.setItem('journal_routes', JSON.stringify(state.routes)); } catch(e){}
  },
  saveSession() {
    try { localStorage.setItem('journal_session', JSON.stringify(state.session)); } catch(e){}
  },
  load() {
    try {
      const r = localStorage.getItem('journal_routes');
      if (r) state.routes = JSON.parse(r);
      const s = localStorage.getItem('journal_session');
      if (s) state.session = JSON.parse(s);
    } catch(e) { state.routes = []; state.session = null; }
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

// ─── OPTIMISATION DE TOURNÉE ──────────────────────────────────
// Nearest Neighbour avec contrainte horaire optionnelle
function optimizeRoute(stops, startLat, startLon, constraintStopId, constraintTime, startTimeStr) {
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
      const dist = haversine(lat, lon, s.lat, s.lon);
      t += (dist / AVG_SPEED_KMH) * 60 + STOP_TIME_MIN;
      lat = s.lat; lon = s.lon;
    }
    return t;
  }

  // Nearest neighbour classique
  function nearestNeighbour(pool, fromLat, fromLon) {
    const result = [];
    const remaining = [...pool];
    let curLat = fromLat, curLon = fromLon;
    while (remaining.length > 0) {
      let best = 0, bestDist = Infinity;
      for (let i = 0; i < remaining.length; i++) {
        const d = haversine(curLat, curLon, remaining[i].lat, remaining[i].lon);
        if (d < bestDist) { bestDist = d; best = i; }
      }
      result.push(remaining.splice(best, 1)[0]);
      curLat = result[result.length-1].lat;
      curLon = result[result.length-1].lon;
    }
    return result;
  }

  // 2-opt : supprime les croisements dans le trajet
  function twoOpt(route) {
    let best = [...route];
    let improved = true;
    let passes = 0;
    while (improved && passes < 50) {
      improved = false;
      passes++;
      for (let i = 0; i < best.length - 2; i++) {
        for (let j = i + 2; j < best.length; j++) {
          const a = best[i], b = best[i + 1];
          const c = best[j], d = best[(j + 1) % best.length];
          if (!a.lat || !b.lat || !c.lat || !d.lat) continue;
          const before = haversine(a.lat, a.lon, b.lat, b.lon) +
                         haversine(c.lat, c.lon, d.lat, d.lon);
          const after  = haversine(a.lat, a.lon, c.lat, c.lon) +
                         haversine(b.lat, b.lon, d.lat, d.lon);
          if (after < before - 0.001) {
            best = [
              ...best.slice(0, i + 1),
              ...best.slice(i + 1, j + 1).reverse(),
              ...best.slice(j + 1)
            ];
            improved = true;
          }
        }
      }
    }
    return best;
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
        const distToS = haversine(cLat, cLon, s.lat, s.lon);
        const tAfterS = cTime + (distToS / AVG_SPEED_KMH) * 60 + STOP_TIME_MIN;
        const distToConstraint = haversine(s.lat, s.lon, constraintStop.lat, constraintStop.lon);
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
    ordered = twoOpt(nearestNeighbour(geocoded, startLat, startLon));
  }

  // Réassigner les ordres
  ordered.forEach((s, i) => { s.order = i; });
  notGeocoded.forEach((s, i) => { s.order = ordered.length + i; });

  return [...ordered, ...notGeocoded];
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

function parseCSV(text, filename) {
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2) return null;

  // Détecter le séparateur
  const sep = lines[0].includes(';') ? ';' : ',';
  const headers = lines[0].split(sep).map(h => h.trim().toLowerCase()
    .replace(/[éèê]/g,'e').replace(/[àâ]/g,'a').replace(/[ùû]/g,'u'));

  const idx = {
    nom: headers.indexOf('nom'),
    adresse: headers.indexOf('adresse'),
    ville: headers.indexOf('ville'),
    cp: Math.max(headers.indexOf('code_postal'), headers.indexOf('cp'), headers.indexOf('codepostal')),
    tournee: Math.max(headers.indexOf('tournee'), headers.indexOf('route')),
    notes: Math.max(headers.indexOf('notes'), headers.indexOf('note')),
    produit: Math.max(headers.indexOf('produit'), headers.indexOf('publication')),
  };

  // Si colonne adresse absente, chercher une alternative
  if (idx.adresse === -1) {
    const alt = headers.findIndex(h => h.includes('adr') || h.includes('rue'));
    if (alt !== -1) idx.adresse = alt;
  }

  // Nom de tournée par défaut = nom du fichier sans extension
  const defaultTournee = filename
    ? filename.replace(/\.[^/.]+$/, '').replace(/_/g, ' ')
    : '1';

  const stops = [];
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const cols = lines[i].split(sep).map(c => c.trim().replace(/^"|"$/g,''));

    let adresseRaw = idx.adresse >= 0 ? (cols[idx.adresse] || '') : cols[0] || '';
    let ville = idx.ville >= 0 ? (cols[idx.ville] || '') : '';
    let cp = idx.cp >= 0 ? (cols[idx.cp] || '') : '';

    // Extraire la ville depuis l'adresse si pas de colonne séparée
    if (!ville && adresseRaw.includes(',')) {
      const extracted = extractCityFromAddress(adresseRaw);
      adresseRaw = extracted.street;
      ville = extracted.city;
      if (!cp) cp = extracted.cp;
    }

    // Combiner notes + produit dans le champ note
    const noteRaw = idx.notes >= 0 ? (cols[idx.notes] || '') : '';
    const produit = idx.produit >= 0 ? (cols[idx.produit] || '') : '';
    const note = [noteRaw, produit].filter(Boolean).join(' · ');

    const tourneeVal = idx.tournee >= 0 ? (cols[idx.tournee] || '') : '';

    const stop = {
      id: uid(),
      nom: idx.nom >= 0 ? (cols[idx.nom] || '') : '',
      adresse: adresseRaw,
      ville,
      code_postal: cp,
      tournee: tourneeVal || defaultTournee,
      lat: null,
      lon: null,
      note,
      order: i - 1,
    };
    if (stop.adresse) stops.push(stop);
  }
  return stops;
}

// ─── APPLICATION ──────────────────────────────────────────────
const App = {

  init() {
    DB.load();
    loadPreloadedDataIfNeeded();
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

    if (state.routes.length === 0) {
      container.innerHTML = `
        <div class="no-route">
          <span class="no-route-icon">📰</span>
          <strong>Aucune tournée configurée</strong><br><br>
          <span>Allez dans <strong>Paramètres ⚙️</strong> pour importer vos adresses et créer vos tournées.</span>
        </div>`;
      return;
    }

    // Tournées du jour en tête
    const todayRoutes = state.routes.filter(r => this.isRouteToday(r, day, date));
    const otherRoutes = state.routes.filter(r => !this.isRouteToday(r, day, date));

    if (todayRoutes.length > 0) {
      const sec = document.createElement('div');
      sec.innerHTML = `<div class="section-title" style="padding:0 4px">Aujourd'hui</div>`;
      todayRoutes.forEach(r => sec.appendChild(this.makeRouteCard(r, true)));
      container.appendChild(sec);
    }

    if (otherRoutes.length > 0) {
      const sec = document.createElement('div');
      sec.innerHTML = `<div class="section-title" style="padding:0 4px; margin-top:8px">Toutes les tournées</div>`;
      otherRoutes.forEach(r => sec.appendChild(this.makeRouteCard(r, false)));
      container.appendChild(sec);
    }
  },

  isRouteToday(route, weekday, monthday) {
    return (route.weekdays && route.weekdays.includes(weekday)) ||
           (route.monthdays && route.monthdays.includes(monthday));
  },

  makeRouteCard(route, isToday) {
    const card = document.createElement('div');
    card.className = 'route-card' + (isToday ? ' today' : '');

    // Session en cours ?
    const hasSession = state.session && state.session.routeId === route.id;
    const done = hasSession ? state.session.stops.filter(s => s.status !== 'pending').length : 0;
    const total = route.stops ? route.stops.length : 0;

    const daysLabel = this.formatDaysLabel(route);

    card.innerHTML = `
      <div class="route-icon">📋</div>
      <div class="route-info">
        <div class="route-name">${route.name}${isToday ? '<span class="badge-today">Aujourd\'hui</span>' : ''}</div>
        <div class="route-meta">${daysLabel}</div>
        <div class="route-count">${total} adresses${hasSession ? ` · ${done}/${total} livrés` : ''}</div>
      </div>
      <div style="font-size:1.4rem">›</div>
    `;
    card.onclick = () => this.startRoute(route.id);
    return card;
  },

  formatDaysLabel(route) {
    const wd = (route.weekdays || []).map(d => DAYS_SHORT[d]).join(', ');
    const md = (route.monthdays || []).sort((a,b)=>a-b).slice(0,5).join(', ') +
               ((route.monthdays || []).length > 5 ? '...' : '');
    const parts = [];
    if (wd) parts.push(wd);
    if (md) parts.push(`${md} du mois`);
    return parts.join(' · ') || 'Aucun jour défini';
  },

  // ── DÉMARRER UNE TOURNÉE ─────────────────────────────────────
  startRoute(routeId) {
    const route = state.routes.find(r => r.id === routeId);
    if (!route) return;

    // Reprendre session existante ?
    if (state.session && state.session.routeId === routeId) {
      this.showRoute();
      return;
    }

    // Nouvelle session — ordre fixé, pas d'auto-optimisation
    const stops = (route.stops || []).map(s => ({ ...s, status: 'pending' }));
    state.session = { routeId, stops, timeConstraint: null };

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
    showScreen('screen-route');
    const route = state.routes.find(r => r.id === state.session.routeId);
    if (!route) return;

    document.getElementById('route-screen-title').textContent = route.name;
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
    const eta = remaining * STOP_TIME_MIN;
    document.getElementById('map-sub') && (document.getElementById('map-sub').textContent = '');
    if (remaining > 0) {
      document.getElementById('map-eta').textContent = `~${Math.round(eta)}min`;
    } else {
      document.getElementById('map-eta').textContent = '✓ Terminé';
    }
    document.getElementById('route-screen-sub').textContent = `${remaining} restants`;
  },

  renderStopsList() {
    if (!state.session) return;
    const list = document.getElementById('stops-list');
    list.innerHTML = '';
    const stops = state.session.stops;
    const currentIdx = stops.findIndex(s => s.status === 'pending');

    const pending   = stops.map((s, i) => ({ s, i })).filter(x => x.s.status === 'pending');
    const delivered = stops.map((s, i) => ({ s, i })).filter(x => x.s.status === 'delivered');
    const failed    = stops.map((s, i) => ({ s, i })).filter(x => x.s.status === 'failed');

    const addItem = ({ s, i }) => {
      const isCurrent = i === currentIdx;
      const item = document.createElement('div');
      item.className = 'stop-item' +
        (isCurrent ? ' current' : '') +
        (s.status === 'delivered' ? ' delivered' : '') +
        (s.status === 'failed' ? ' failed' : '');

      const canMove = s.status === 'pending';
      const firstPendingIdx = pending.length > 0 ? pending[0].i : -1;

      item.innerHTML = `
        <div class="stop-num">${i + 1}</div>
        <div class="stop-info">
          <div class="stop-name">${s.nom || s.adresse}</div>
          <div class="stop-addr">${s.adresse}${s.ville ? ', ' + s.ville : ''}</div>
        </div>
        ${canMove && i !== firstPendingIdx ? `<button class="stop-move-top-btn" onclick="event.stopPropagation();App.moveStopToTop(${i})">⬆ Premier</button>` : ''}
        ${!canMove ? `<div class="stop-status-icon">${s.status === 'delivered' ? '✅' : '❌'}</div>` : ''}
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
    addSection(`✅ Livrés (${delivered.length})`, delivered);
    addSection(`❌ Non livrés (${failed.length})`, failed);

    if (currentIdx >= 0) {
      const allItems = list.querySelectorAll('.stop-item');
      allItems.forEach(el => {
        if (el.querySelector('.stop-num') && el.classList.contains('current')) {
          el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }
      });
    }
  },

  moveStopToTop(idx) {
    if (!state.session) return;
    const stops = state.session.stops;
    // Trouver le premier stop pending
    const firstPendingIdx = stops.findIndex(s => s.status === 'pending');
    if (firstPendingIdx < 0 || idx <= firstPendingIdx) return;
    // Extraire le stop et l'insérer avant le premier pending
    const [moved] = stops.splice(idx, 1);
    stops.splice(firstPendingIdx, 0, moved);
    DB.saveSession();
    this.renderStopsList();
    this.updateMap();
    // Scroll en haut de la liste
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
    const done = state.session.stops.filter(s => s.status !== 'pending').length;

    document.getElementById('stop-progress-text').textContent = `${idx+1} / ${total}`;
    document.getElementById('stop-addr').textContent = stop.adresse;
    document.getElementById('stop-city').textContent = `${stop.code_postal || ''} ${stop.ville || ''}`.trim();
    document.getElementById('stop-name').textContent = stop.nom || '';
    document.getElementById('stop-note-input').value = stop.note || '';

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

    const msg = status === 'delivered' ? '✅ Livré !' : '❌ Non livré';
    toast(msg);

    // Passer au suivant
    const nextIdx = state.session.stops.findIndex((s, i) => i > idx && s.status === 'pending');
    if (nextIdx >= 0) {
      this.showStop(nextIdx);
    } else {
      // Vérifier si il y en a avant
      const anyPending = state.session.stops.findIndex(s => s.status === 'pending');
      if (anyPending >= 0) {
        this.showStop(anyPending);
      } else {
        toast('🎉 Tournée terminée !', 4000);
        this.updateRouteStats();
        this.backToRoute();
      }
    }
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
  reorganize() {
    if (!state.session) return;
    const route = state.routes.find(r => r.id === state.session.routeId);

    const pending = state.session.stops.filter(s => s.status === 'pending');
    const done = state.session.stops.filter(s => s.status !== 'pending');

    if (pending.length === 0) { toast('Plus rien à réorganiser'); return; }

    const from = state.currentPos || (pending[0].lat ? { lat: pending[0].lat, lon: pending[0].lon } : null);
    if (!from) { toast('Position GPS non disponible'); return; }

    const constraint = state.session.timeConstraint;
    const optimized = optimizeRoute(
      pending,
      from.lat, from.lon,
      constraint ? constraint.stopId : null,
      constraint ? constraint.time : null,
      route ? route.startTime : null
    );

    state.session.stops = [...done, ...optimized];
    DB.saveSession();

    toast('🔄 Tournée réorganisée !');
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
    const routeCount = state.routes.length;
    const totalStops = state.routes.reduce((n, r) => n + (r.stops ? r.stops.length : 0), 0);
    const geocoded = state.routes.reduce((n, r) => n + (r.stops ? r.stops.filter(s => s.lat).length : 0), 0);

    document.getElementById('setting-routes-count').textContent = `${routeCount} tournée${routeCount !== 1 ? 's' : ''}`;
    document.getElementById('setting-geocode-status').textContent =
      totalStops > 0 ? `${geocoded}/${totalStops}` : '';
    showScreen('screen-settings');
  },

  resetSession() {
    if (!confirm('Réinitialiser la session ? Tous les statuts seront perdus.')) return;
    state.session = null;
    DB.saveSession();
    toast('Session réinitialisée');
  },

  goHome() {
    this.renderHome();
    showScreen('screen-home');
  },

  // ── IMPORT CSV ────────────────────────────────────────────────
  showImportCSV() {
    document.getElementById('csv-preview').style.display = 'none';
    document.getElementById('csv-file-input').value = '';
    this.openModal('modal-csv');

    document.getElementById('csv-file-input').onchange = function() {
      const file = this.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = e => {
        const stops = parseCSV(e.target.result, file.name);
        const preview = document.getElementById('csv-preview');
        if (!stops || stops.length === 0) {
          preview.innerHTML = '⚠️ Aucune adresse trouvée. Vérifiez le format.';
          preview.style.display = 'block';
          return;
        }
        const tournees = [...new Set(stops.map(s => s.tournee))];
        preview.innerHTML = `✅ <strong>${stops.length} adresses</strong> détectées dans <strong>${tournees.length} tournée(s)</strong> : ${tournees.join(', ')}`;
        preview.style.display = 'block';
      };
      reader.readAsText(file);
    };
  },

  importCSV() {
    const fileInput = document.getElementById('csv-file-input');
    const file = fileInput.files[0];
    if (!file) { toast('Choisissez un fichier CSV'); return; }

    const reader = new FileReader();
    reader.onload = e => {
      const stops = parseCSV(e.target.result, file.name);
      if (!stops || stops.length === 0) {
        toast('⚠️ Aucune adresse trouvée'); return;
      }

      // Regrouper par tournée
      const grouped = {};
      stops.forEach(s => {
        if (!grouped[s.tournee]) grouped[s.tournee] = [];
        grouped[s.tournee].push(s);
      });

      // Créer ou mettre à jour les routes
      Object.entries(grouped).forEach(([name, stopsGroup]) => {
        let route = state.routes.find(r => r.name === name || r.csvKey === name);
        if (!route) {
          route = {
            id: uid(),
            name: `Tournée ${name}`,
            csvKey: name,
            weekdays: [],
            monthdays: [],
            startTime: '06:00',
            stops: []
          };
          state.routes.push(route);
        }
        route.stops = stopsGroup;
      });

      DB.save();
      toast(`✅ ${stops.length} adresses importées !`);
      this.closeModal('modal-csv');
      this.renderHome();
    };
    reader.readAsText(file);
  },

  // ── GESTION DES TOURNÉES ──────────────────────────────────────
  showManageRoutes() {
    this.renderRoutesModal();
    this.openModal('modal-routes');
  },

  renderRoutesModal() {
    const list = document.getElementById('routes-list-modal');
    list.innerHTML = '';
    if (state.routes.length === 0) {
      list.innerHTML = '<p style="color:var(--text-2); font-size:0.9rem; text-align:center; padding:20px 0;">Aucune tournée. Importez d\'abord un CSV.</p>';
      return;
    }
    state.routes.forEach(r => {
      const item = document.createElement('div');
      item.className = 'settings-row';
      item.innerHTML = `
        <span class="row-icon">📋</span>
        <span class="row-label">${r.name}</span>
        <span class="row-value">${(r.stops||[]).length} arrêts</span>
        <span class="row-arrow">›</span>
      `;
      item.onclick = () => this.editRoute(r.id);
      list.appendChild(item);
    });
  },

  addRoute() {
    const route = {
      id: uid(),
      name: `Tournée ${state.routes.length + 1}`,
      weekdays: [],
      monthdays: [],
      startTime: '06:00',
      stops: []
    };
    state.routes.push(route);
    DB.save();
    this.editRoute(route.id);
  },

  editRoute(id) {
    const route = state.routes.find(r => r.id === id);
    if (!route) return;
    state.editingRouteId = id;

    document.getElementById('edit-route-title').textContent = `Modifier : ${route.name}`;
    document.getElementById('edit-route-name').value = route.name;
    document.getElementById('edit-route-start-time').value = route.startTime || '06:00';

    // Jours de la semaine
    document.querySelectorAll('#edit-weekdays .day-btn').forEach(btn => {
      const day = parseInt(btn.dataset.day);
      btn.classList.toggle('selected', (route.weekdays || []).includes(day));
      btn.onclick = () => {
        btn.classList.toggle('selected');
      };
    });

    // Jours du mois
    const grid = document.getElementById('edit-monthdays');
    grid.innerHTML = '';
    for (let d = 1; d <= 31; d++) {
      const btn = document.createElement('button');
      btn.className = 'mday-btn' + ((route.monthdays || []).includes(d) ? ' selected' : '');
      btn.textContent = d;
      btn.onclick = () => btn.classList.toggle('selected');
      grid.appendChild(btn);
    }

    document.getElementById('btn-delete-route').style.display = 'block';
    this.closeModal('modal-routes');
    this.openModal('modal-edit-route');
  },

  saveRoute() {
    if (!state.editingRouteId) return;
    const route = state.routes.find(r => r.id === state.editingRouteId);
    if (!route) return;

    route.name = document.getElementById('edit-route-name').value.trim() || route.name;
    route.startTime = document.getElementById('edit-route-start-time').value;
    route.weekdays = [...document.querySelectorAll('#edit-weekdays .day-btn.selected')]
                      .map(b => parseInt(b.dataset.day));
    route.monthdays = [...document.querySelectorAll('#edit-monthdays .mday-btn.selected')]
                       .map(b => parseInt(b.textContent));

    DB.save();
    toast('✅ Tournée enregistrée');
    this.closeModal('modal-edit-route');
    this.renderHome();
    this.showSettings();
  },

  deleteRoute() {
    if (!state.editingRouteId) return;
    if (!confirm('Supprimer cette tournée ?')) return;
    state.routes = state.routes.filter(r => r.id !== state.editingRouteId);
    if (state.session && state.session.routeId === state.editingRouteId) {
      state.session = null;
      DB.saveSession();
    }
    state.editingRouteId = null;
    DB.save();
    toast('Tournée supprimée');
    this.closeModal('modal-edit-route');
    this.showSettings();
  },

  // ── GESTION DES ADRESSES ──────────────────────────────────────
  showManageAddresses() {
    state.editingAddressId = null;
    this.renderAddressesList();
    this.openModal('modal-addresses');
  },

  renderAddressesList() {
    const allStops = state.routes.flatMap(r => r.stops || []);
    const searchTerm = document.getElementById('address-search').value.toLowerCase();
    const filtered = allStops.filter(s =>
      !searchTerm || s.nom.toLowerCase().includes(searchTerm) ||
      s.adresse.toLowerCase().includes(searchTerm)
    );

    const html = filtered.map(s => `
      <div style="padding:10px; border-bottom:1px solid var(--border); display:flex; justify-content:space-between; align-items:center;">
        <div style="flex:1;">
          <strong>${s.nom}</strong><br>
          <span style="font-size:0.85rem; color:var(--text-2);">${s.adresse}, ${s.code_postal} ${s.ville}</span>
        </div>
        <button class="btn-sm" onclick="App.editAddress('${s.id}')" style="margin-right:6px;">✏️</button>
      </div>
    `).join('');

    document.getElementById('addresses-list-modal').innerHTML = html || '<p style="padding:10px; color:var(--text-2);">Aucune adresse trouvée</p>';
  },

  filterAddresses() {
    this.renderAddressesList();
  },

  showAddAddressForm() {
    state.editingAddressId = null;
    document.getElementById('edit-address-title').textContent = 'Ajouter une adresse';
    document.getElementById('addr-name').value = '';
    document.getElementById('addr-address').value = '';
    document.getElementById('addr-city').value = '';
    document.getElementById('addr-postal').value = '';
    document.getElementById('btn-delete-address').style.display = 'none';

    const routeSelect = document.getElementById('addr-route');
    routeSelect.innerHTML = state.routes.map(r =>
      `<option value="${r.id}">${r.name}</option>`
    ).join('');

    this.closeModal('modal-addresses');
    this.openModal('modal-edit-address');
  },

  editAddress(stopId) {
    const stop = state.routes.flatMap(r => r.stops || []).find(s => s.id === stopId);
    if (!stop) return;

    state.editingAddressId = stopId;
    document.getElementById('edit-address-title').textContent = 'Modifier l\'adresse';
    document.getElementById('addr-name').value = stop.nom;
    document.getElementById('addr-address').value = stop.adresse;
    document.getElementById('addr-city').value = stop.ville;
    document.getElementById('addr-postal').value = stop.code_postal;

    const routeSelect = document.getElementById('addr-route');
    routeSelect.innerHTML = state.routes.map(r =>
      `<option value="${r.id}" ${r.stops.find(s => s.id === stopId) ? 'selected' : ''}>${r.name}</option>`
    ).join('');

    document.getElementById('btn-delete-address').style.display = 'block';
    this.closeModal('modal-addresses');
    this.openModal('modal-edit-address');
  },

  saveAddress() {
    const nom = document.getElementById('addr-name').value.trim();
    const adresse = document.getElementById('addr-address').value.trim();
    const ville = document.getElementById('addr-city').value.trim();
    const code_postal = document.getElementById('addr-postal').value.trim();
    const routeId = document.getElementById('addr-route').value;

    if (!nom || !adresse || !ville || !code_postal || !routeId) {
      toast('❌ Tous les champs sont obligatoires');
      return;
    }

    if (state.editingAddressId) {
      for (const route of state.routes) {
        const stop = route.stops.find(s => s.id === state.editingAddressId);
        if (stop) {
          stop.nom = nom;
          stop.adresse = adresse;
          stop.ville = ville;
          stop.code_postal = code_postal;
          break;
        }
      }
      toast('✏️ Adresse modifiée');
    } else {
      const route = state.routes.find(r => r.id === routeId);
      if (route) {
        route.stops.push({
          id: uid(),
          nom, adresse, ville, code_postal,
          tournee: route.name,
          lat: null, lon: null
        });
        toast('➕ Adresse ajoutée');
      }
    }

    DB.save();
    this.closeModal('modal-edit-address');
    this.showManageAddresses();
  },

  deleteAddress() {
    if (!state.editingAddressId) return;
    if (!confirm('Supprimer cette adresse définitivement ?')) return;

    for (const route of state.routes) {
      const idx = route.stops.findIndex(s => s.id === state.editingAddressId);
      if (idx >= 0) {
        route.stops.splice(idx, 1);
        break;
      }
    }

    toast('❌ Adresse supprimée');
    DB.save();
    this.closeModal('modal-edit-address');
    this.showManageAddresses();
  },

  // ── GÉOCODAGE ─────────────────────────────────────────────────
  showGeocodeAll() {
    const total = state.routes.reduce((n, r) => n + (r.stops ? r.stops.length : 0), 0);
    const done = state.routes.reduce((n, r) => n + (r.stops ? r.stops.filter(s => s.lat).length : 0), 0);

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
    const allStops = state.routes.flatMap(r => r.stops || []);
    const toGeocode = allStops.filter(s => !s.lat);
    const total = allStops.length;

    if (toGeocode.length === 0) { toast('Tout est déjà géocodé !'); return; }

    state.geocodeRunning = true;
    state.geocodeStop = false;
    document.getElementById('btn-start-geocode').disabled = true;
    document.getElementById('btn-stop-geocode').textContent = '⏹ Stop';

    let done = allStops.filter(s => s.lat).length;
    let errors = 0;

    for (const stop of toGeocode) {
      if (state.geocodeStop) break;

      document.getElementById('geocode-status-text').textContent =
        `Géocodage : ${stop.adresse}, ${stop.ville}`;
      document.getElementById('geocode-count').textContent =
        `${done}/${total} faits · ${errors} erreurs`;
      document.getElementById('geocode-bar').style.width = (done/total*100) + '%';

      try {
        const ok = await geocodeAddress(stop);
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

// ─── CHARGEMENT DONNÉES INITIALES ────────────────────────────
function loadPreloadedDataIfNeeded() {
  if (typeof PRELOADED_DATA === 'undefined') return;
  const storedVersion = parseInt(localStorage.getItem('journal_data_version') || '0');
  const newVersion = PRELOADED_DATA.version || 1;
  if (state.routes.length === 0 || storedVersion < newVersion) {
    state.routes = PRELOADED_DATA.routes;
    DB.save();
    localStorage.setItem('journal_data_version', String(newVersion));
  }
}

function forceReloadData() {
  if (typeof PRELOADED_DATA === 'undefined') { toast('Données non disponibles'); return; }
  if (!confirm('Recharger toutes les données depuis le fichier source ?\nTes notes et modifications locales seront effacées.')) return;
  state.routes = PRELOADED_DATA.routes;
  state.session = null;
  DB.save();
  DB.saveSession();
  localStorage.setItem('journal_data_version', String(PRELOADED_DATA.version || 1));
  toast('✅ Données rechargées avec les coordonnées GPS !');
  App.renderHome();
  showScreen('screen-home');
}

// ─── DÉMARRAGE ────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => App.init());
