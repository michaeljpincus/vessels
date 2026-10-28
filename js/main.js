import * as maplibregl from 'https://unpkg.com/maplibre-gl@^6.12.0/dist/maplibre-gl.mjs';

const map = new maplibregl.Map({
  container: 'map',
  minZoom: 2.5,
  center: [ 58.6508212580619, 23.3024588377676], 
  style: 'https://michaeljpincus.github.io/franklin_basemap/basemap.json',
  attributionControl: { compact: true }
});

window.map = map;

// ---------- Helpers ----------

const fmt = new Intl.DateTimeFormat('en-US', {
  month: 'long',
  day: '2-digit',
  year: 'numeric',
  timeZone: 'UTC'
});

// "port_visit" -> "Port visit"
const sentenceCase = (s) => {
  const t = String(s).replace(/_/g, ' ');
  return t.charAt(0).toUpperCase() + t.slice(1);
};

// "OCEAN STAR" -> "Ocean Star"
const properName = (s) =>
  String(s)
    .toLowerCase()
    .replace(/(^|[\s\-/(])(\S)/g, (_, sep, c) => sep + c.toUpperCase());

// ---------- Data ----------

const geojson = await (await fetch('events.geojson')).json();

const events = geojson.features.map(f => ({
  ...f.properties,                     // vessel, imo, event_type, flag, flag_url, ...
  start: Date.parse(f.properties.start),
  end: Date.parse(f.properties.end),
  coord: f.geometry.coordinates,
}));

const DAY = 24 * 3600 * 1000;
const tMin = new Date(2025, 9, 8).getTime();
const tMax = Math.max(...events.map(e => e.end));

const slider = document.getElementById('slider');
slider.min = tMin;
slider.max = tMax;
slider.step = DAY / 4;
slider.value = tMin;

function positionsAt(t, includeLastKnown) {
  const byVessel = {};
  for (const e of events) (byVessel[e.imo] ??= []).push(e);

  const features = [];
  for (const list of Object.values(byVessel)) {
    list.sort((a, b) => a.start - b.start);

    // Active event: start <= t <= end
    let ev = list.find(e => e.start <= t && t <= e.end);
    let status = 'active';

    // Otherwise, the most recent event that has already ended
    if (!ev && includeLastKnown) {
      const past = list.filter(e => e.end < t);
      if (past.length) { ev = past[past.length - 1]; status = 'last_known'; }
    }
    if (!ev) continue; // vessel not yet seen at time t

    features.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: ev.coord },
      properties: {
        vessel: ev.vessel,
        imo: ev.imo,
        event_type: ev.event_type,
        flag: ev.flag,
        flag_url: ev.image,
        status,
      },
    });
  }
  return { type: 'FeatureCollection', features };
}

// ---------- Popup helpers ----------

function popupHTML(p) {
  return `
    <div class="popup-vessel">
      ${p.flag_url ? `<img class="popup-flag" src="${p.flag_url}" alt="" onerror="this.remove()">` : ''}
      <span>${properName(p.vessel)}</span>
    </div>
    <div class="popup-event">
      ${p.flag ? sentenceCase(p.flag) : ''} (${sentenceCase(p.status).toLowerCase()})
    </div>
  `;
}

let selectedImo = null;
let selectedKey = null;
const selectedPopup = new maplibregl.Popup({ closeButton: false, closeOnClick: false });

function clearSelection() {
  selectedImo = null;
  selectedKey = null;
  selectedPopup.remove();
}

// Move/refresh the selected popup to match the current data
function syncSelectedPopup(data) {
  if (selectedImo == null) return;

  const f = data.features.find(f => String(f.properties.imo) === selectedImo);
  if (!f) {            // vessel not visible at this time -> hide, but keep selection
    selectedPopup.remove();
    selectedKey = null;
    return;
  }

  selectedPopup.setLngLat(f.geometry.coordinates);

  const key = `${f.properties.imo}|${f.properties.status}|${f.properties.event_type}`;
  if (key !== selectedKey) {   // only rebuild HTML when something changed
    selectedKey = key;
    selectedPopup.setHTML(popupHTML(f.properties));
  }
  if (!selectedPopup.isOpen()) selectedPopup.addTo(map);
}

// ---------- Map ----------

map.on('load', () => {
  // Make sure the attribution starts collapsed
  const attrib = document.querySelector('.maplibregl-ctrl-attrib');
  attrib?.classList.remove('maplibregl-compact-show');
  attrib?.removeAttribute('open');

  map.addSource('vessels', { type: 'geojson', data: positionsAt(tMin, true) });

  map.addLayer({
    id: 'vessels',
    type: 'circle',
    source: 'vessels',
    paint: {
      'circle-radius': 9,
      'circle-color': [
        'case',
        ['==', ['get', 'status'], 'last_known'], '#838181',
        ['==', ['get', 'event_type'], 'loitering'], '#d62728',
        '#1f77b4',
      ],
      'circle-opacity': ['case', ['==', ['get', 'status'], 'last_known'], 0.5, 1],
      'circle-stroke-width': 3,
      'circle-stroke-color': '#fff',
    },
  });

  // Hover popup (skipped for the selected vessel, which already has one)
  const hoverPopup = new maplibregl.Popup({ closeButton: false, closeOnClick: false });
  let hoverKey = null;

  map.on('mousemove', 'vessels', (e) => {
    map.getCanvas().style.cursor = 'pointer';
    const p = e.features[0].properties;

    if (String(p.imo) === selectedImo) {
      hoverPopup.remove();
      hoverKey = null;
      return;
    }

    hoverPopup.setLngLat(e.lngLat);

    // Only rebuild the HTML when the ship or its state changes (avoids flag flicker)
    const key = `${p.imo}|${p.status}|${p.event_type}`;
    if (key !== hoverKey) {
      hoverKey = key;
      hoverPopup.setHTML(popupHTML(p));
    }
    hoverPopup.addTo(map);
  });

  map.on('mouseleave', 'vessels', () => {
    map.getCanvas().style.cursor = '';
    hoverKey = null;
    hoverPopup.remove();
  });

  // Click a dot to select it; click empty map to deselect
  map.on('click', (e) => {
    const hits = map.queryRenderedFeatures(e.point, { layers: ['vessels'] });
    if (!hits.length) return clearSelection();

    selectedImo = String(hits[0].properties.imo);
    selectedKey = null;
    hoverPopup.remove();
    hoverKey = null;
    update();   // positions + shows the popup immediately
  });

  update();
});

// ---------- Timeline controls ----------

function update() {
  const t = +slider.value;
  document.getElementById('date').textContent = fmt.format(t);

  // fill the slider track up to the current position
  slider.style.setProperty('--pct', `${((t - tMin) / (tMax - tMin)) * 100}%`);

  const data = positionsAt(t, document.getElementById('lastKnown').checked);
  map.getSource('vessels')?.setData(data);
  syncSelectedPopup(data);   // keep the selected vessel's popup on its current position
}

slider.addEventListener('input', update);
document.getElementById('lastKnown').addEventListener('change', update);

let timer = null;
document.getElementById('play').addEventListener('click', (e) => {
  const btn = e.currentTarget;
  const label = btn.querySelector('.play-label');

  if (timer) {
    clearInterval(timer);
    timer = null;
    label.textContent = 'Play';
    btn.classList.remove('is-playing');
    return;
  }
  label.textContent = 'Pause';
  btn.classList.add('is-playing');
  timer = setInterval(() => {
    let v = +slider.value + DAY / 2;
    if (v > tMax) v = tMin;
    slider.value = v;
    update();
  }, 100);
});