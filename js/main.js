import * as maplibregl from 'https://unpkg.com/maplibre-gl@^6.12.0/dist/maplibre-gl.mjs';

const map = new maplibregl.Map({
  container: 'map',
  minZoom: 2.5,
  style: 'https://michaeljpincus.github.io/basemap/basemap.json',
  attributionControl: { compact: true }
});

window.map = map;

const fmt = new Intl.DateTimeFormat('en-US', {
  month: 'long',
  day: '2-digit',
  year: 'numeric',
  timeZone: 'UTC'
});

// Load the data up front
const geojson = await (await fetch('events.geojson')).json();

const vessels = [...new Set(geojson.features.map(f => f.properties.vessel))];
const colorFor = (i, n) => `hsl(${Math.round((i * 360) / n)}, 70%, 50%)`;

const matchExpr = [
  'match',
  ['get', 'vessel'],
  ...vessels.flatMap((v, i) => [v, colorFor(i, vessels.length)]),
  '#999999'
];

const events = geojson.features.map(f => ({
  ...f.properties,                     // vessel, imo, event_type, ...
  start: Date.parse(f.properties.start),
  end: Date.parse(f.properties.end),
  coord: f.geometry.coordinates,
}));

const DAY = 24 * 3600 * 1000;
const tMin = Math.min(...events.map(e => e.start));
const tMax = Math.max(...events.map(e => e.end));


 
const slider = document.getElementById('slider');
slider.min = tMin; slider.max = tMax; slider.step = DAY / 4; slider.value = tMin;

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
      properties: { vessel: ev.vessel, imo: ev.imo, event_type: ev.event_type, flag: ev.flag, status },
    });
  }
  return { type: 'FeatureCollection', features };
}

const titleCase = (s) => {
  const t = String(s).replace(/_/g, ' ');
  return t.charAt(0).toUpperCase() + t.slice(1);
};

const properName = (s) =>
  String(s)
    .toLowerCase()
    .replace(/(^|[\s\-/(])(\S)/g, (_, sep, c) => sep + c.toUpperCase());


map.on('load', () => {

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
 
  const popup = new maplibregl.Popup({ closeButton: false, closeOnClick: false });
 map.on('mousemove', 'vessels', (e) => {
    map.getCanvas().style.cursor = 'pointer';
    const p = e.features[0].properties;
    popup.setLngLat(e.lngLat)
      .setHTML(`
        <div class="popup-vessel">${properName(p.vessel)}</div>
        <div class="popup-event">${p.flag}</div>
      `)
      .setHTML(`
        <div class="popup-vessel">${properName(p.vessel)}</div>
        <div class="popup-event">${titleCase(p.flag)} (${titleCase(p.status)})</div>
      `)
      .addTo(map);
  });
  map.on('mouseleave', 'vessels', () => { map.getCanvas().style.cursor = ''; popup.remove(); });
 
  update();
});

function update() {
  const t = +slider.value;
  document.getElementById('date').textContent = fmt.format(t);
  map.getSource('vessels')?.setData(
    positionsAt(t, document.getElementById('lastKnown').checked)
  );
}
slider.addEventListener('input', update);
document.getElementById('lastKnown').addEventListener('change', update);
 
let timer = null;
document.getElementById('play').addEventListener('click', (e) => {
  if (timer) { clearInterval(timer); timer = null; e.target.textContent = '▶ Play'; return; }
  e.target.textContent = '⏸ Pause';
  timer = setInterval(() => {
    let v = +slider.value + DAY / 2;
    if (v > tMax) v = tMin;
    slider.value = v;
    update();
  }, 100);
});