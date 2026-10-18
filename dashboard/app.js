const POLL_MS = 2000;
const NAME_KEY = "relay-confirmed-by";
const params = new URLSearchParams(location.search);
const stateUrl = params.get("state") || "/state";
let coreBase = "http://localhost:3000";
let adminToken = "";

const STATUS_COLOR = {
  safe: "#22c55e",
  unconfirmed: "#f59e0b",
  sos: "#ef4444",
  en_route: "#3b82f6",
};

const ZONE_STYLE = {
  evacuate: { color: "#ff6b5a", fillColor: "#ff6b5a", fillOpacity: 0.24, label: "Evacuate now" },
  warning: { color: "#f0b429", fillColor: "#f0b429", fillOpacity: 0.2, label: "Warning" },
  watch: { color: "#7eb6ff", fillColor: "#7eb6ff", fillOpacity: 0.08, label: "Watch" },
};

const LANGUAGE_NAME = { en: "English", es: "Spanish", zh: "Chinese", gu: "Gujarati" };
const CHANNEL_NAME = { imessage: "iMessage", sms: "SMS", voice: "Voice", radio: "Radio" };

const picture = { zones: [], fire: null, wind: null, phones: {} };
let map = null;
let tiles = null;
let activeBasemap = "dark";
let hazards = null;
let shelters = null;
let people = null;
let reports = null;
let units = null;
let volunteers = null;
let zoneLayer = null;
const hazardLayers = new Map();
const shelterLayers = new Map();
const peopleLayers = new Map();
const reportLayers = new Map();
const unitLayers = new Map();
const volunteerLayers = new Map();
let routeGlow = null;
let routeLine = null;
let routeOrigin = null;
let routeDest = null;
let routeChip = null;
let routeMeta = null;
let perimeterKey = "";
let fitted = false;
let feedStick = true;
let lastState = null;
let statusFilter = "";
let windowHours = 24;
let liveFires = [];
let inspector = null;
let feedKey = "";
let ignoreMapClick = false;

function reduceMotion() {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function readJson(response) {
  if (!response.ok) {
    throw new Error("HTTP " + response.status);
  }
  return response.json();
}

function haversine(lat1, lng1, lat2, lng2) {
  const p = Math.PI / 180;
  const dLat = (lat2 - lat1) * p;
  const dLng = (lng2 - lng1) * p;
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1 * p) * Math.cos(lat2 * p) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.min(1, Math.sqrt(a)));
}

function ago(iso) {
  if (!iso) return "No contact yet";
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return iso;
  const sec = Math.round((Date.now() - then) / 1000);
  if (Math.abs(sec) < 10) return "Just now";
  if (sec < 60) return sec + "s ago";
  const min = Math.round(sec / 60);
  if (min < 60) return min + "m ago";
  const hr = Math.round(min / 60);
  if (hr < 48) return hr + "h ago";
  return iso;
}

function statusLabel(status) {
  const labels = {
    safe: "Safe",
    unconfirmed: "Unconfirmed",
    sos: "SOS",
    en_route: "En route",
    available: "Available",
    fire: "Fire",
    weather: "Weather",
    shelter: "Shelter",
    report: "Report",
    road_blocked: "Road blocked",
    fire_sighting: "Fire sighting",
    other: "Report",
    radio: "Radio",
    voice: "Voice",
    imessage: "iMessage",
    sms: "SMS",
    volunteer: "Volunteer",
    unit: "Unit",
  };
  return labels[status] || (status ? String(status).replace(/_/g, " ") : "");
}

function channelLabel(value) {
  if (!value) return "No channel yet";
  return CHANNEL_NAME[String(value).toLowerCase()] || value;
}

function languageName(code) {
  if (!code) return "Unknown";
  return LANGUAGE_NAME[String(code).toLowerCase()] || code;
}

function showBanner(text, backup) {
  const banner = document.getElementById("banner");
  const mode = document.getElementById("mode");
  const label = mode.querySelector(".mode-label");
  if (!text) {
    banner.hidden = true;
    banner.textContent = "";
    mode.className = "live";
    if (label) label.textContent = "Live";
    else mode.textContent = "Live";
    return;
  }
  banner.hidden = false;
  banner.textContent = text;
  mode.className = backup ? "backup" : "live";
  if (label) label.textContent = backup ? "Backup" : "Live";
  else mode.textContent = backup ? "Backup" : "Live";
}

function updatedPhrase(iso) {
  if (!iso) return "Updated just now";
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "Updated just now";
  const sec = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (sec < 1) return "Updated just now";
  if (sec < 60) return "Updated " + sec + "s ago";
  const min = Math.round(sec / 60);
  if (min < 60) return "Updated " + min + "m ago";
  const hr = Math.round(min / 60);
  if (hr < 48) return "Updated " + hr + "h ago";
  return "Updated " + iso;
}

function clock(iso) {
  const then = Date.parse(iso);
  if (!iso || Number.isNaN(then)) return "--:--:--";
  return new Date(then).toLocaleTimeString("en-GB", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function esc(value) {
  return String(value == null ? "" : value).replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;",
  }[ch]));
}

function rosterShare(count, total) {
  if (!total) return 0;
  return Math.round((Number(count) || 0) / total * 100);
}

function weatherChip(wind) {
  if (!wind || wind.wind_mph == null || !wind.wind_dir) return "Weather unavailable";
  const mph = Number(wind.wind_mph);
  const mphText = Number.isInteger(mph) ? String(mph) : String(Math.round(mph * 10) / 10);
  const temp = Math.round(Number(wind.temp_f));
  let source = "NWS";
  if (wind.source === "fallback") source = "BACKUP";
  else if (wind.source && wind.source !== "nws") source = String(wind.source).toUpperCase();
  return mphText + " mph from " + wind.wind_dir + " · " + temp + "°F · " + source;
}

function organicRing(lat, lng, radiusKm) {
  const steps = 72;
  const ring = [];
  const latRad = lat * Math.PI / 180;
  const radius = Number(radiusKm) > 0 ? Number(radiusKm) : 1.2;
  for (let i = 0; i < steps; i += 1) {
    const t = (i / steps) * Math.PI * 2;
    const lobe = 1
      + 0.18 * Math.sin(2 * t + 0.6)
      + 0.1 * Math.sin(5 * t + 1.4)
      + 0.06 * Math.cos(7 * t + 0.2);
    const meters = radius * lobe;
    const dLat = (meters / 111.32) * Math.cos(t);
    const dLng = (meters / (111.32 * Math.max(0.2, Math.cos(latRad)))) * Math.sin(t);
    ring.push([lat + dLat, lng + dLng]);
  }
  return ring;
}

function isRouteOrigin(person) {
  return !!(routeMeta && person && person.name === routeMeta.person_name);
}

function isRouteShelter(shelter) {
  return !!(routeMeta && shelter && shelter.name && shelter.name === routeMeta.shelter_name);
}

function viewFor(lat, lng, zoom) {
  const wide = window.innerWidth > 800;
  const dx = wide ? 200 : 0;
  const dy = wide ? 0 : -Math.round(window.innerHeight * 0.18);
  if ((!dx && !dy) || !map) return L.latLng(lat, lng);
  const projected = map.project([lat, lng], zoom);
  return map.unproject(projected.subtract(L.point(dx, dy)), zoom);
}

function goTo(lat, lng, zoom) {
  const nextZoom = zoom || Math.max(map.getZoom(), 14);
  const center = viewFor(lat, lng, nextZoom);
  if (reduceMotion()) {
    map.setView(center, nextZoom, { animate: false });
    return;
  }
  map.flyTo(center, nextZoom, { duration: 0.65 });
}

function holdMapClick() {
  ignoreMapClick = true;
  setTimeout(() => {
    ignoreMapClick = false;
  }, 0);
}

function paintWind() {
  const el = document.getElementById("wind-readout");
  const wind = picture.wind;
  el.textContent = weatherChip(wind);
  if (wind && wind.summary) el.title = wind.summary;
}

function zoneLevel(zone, fire) {
  const lats = zone.polygon.map((point) => point[0]);
  const lngs = zone.polygon.map((point) => point[1]);
  const lat = (Math.min(...lats) + Math.max(...lats)) / 2;
  const lng = (Math.min(...lngs) + Math.max(...lngs)) / 2;
  const distance = haversine(lat, lng, fire.lat, fire.lng);
  const radius = Number(fire.radius_km) || 1;
  if (distance <= radius + 0.8) return "evacuate";
  if (distance <= radius + 1.6) return "warning";
  return "watch";
}

function firmsFires(rows) {
  return (rows || []).filter((hazard) => hazard && hazard.kind === "fire" && hazard.source === "firms");
}

function drawnHazards(state) {
  const weather = (state.hazards || []).filter((hazard) => hazard.kind !== "fire" && hazardInWindow(hazard));
  return firmsFires(liveFires).filter(hazardInWindow).concat(weather);
}

function syncZones(fires) {
  const rows = firmsFires(fires).filter((fire) => fire.lat != null && fire.lng != null);
  const key = rows.map((fire) => [fire.id, fire.lat, fire.lng, fire.radius_km].join(",")).join("|");
  if (key === perimeterKey) return;
  perimeterKey = key;
  zoneLayer.clearLayers();
  rows.forEach((fire) => {
    const polygon = L.polygon(organicRing(fire.lat, fire.lng, fire.radius_km), {
      pane: "zones",
      color: "#ef4444",
      weight: 2,
      dashArray: "6, 6",
      fillColor: "#dc2626",
      fillOpacity: 0.12,
      className: "evac-perimeter",
    });
    polygon.bindTooltip("FIRMS evacuation perimeter");
    polygon.on("click", () => {
      holdMapClick();
      const bounds = polygon.getBounds();
      if (reduceMotion()) map.fitBounds(bounds, { padding: [36, 36], animate: false });
      else map.fitBounds(bounds, { padding: [36, 36], maxZoom: 14 });
    });
    polygon.addTo(zoneLayer);
  });
}

function hazardInWindow(hazard) {
  if (!hazard.updated_at) return true;
  const then = Date.parse(hazard.updated_at);
  if (Number.isNaN(then)) return true;
  return Date.now() - then <= windowHours * 3600000;
}

function render(state) {
  const lists = ["hazards", "shelters", "people", "volunteers", "reports", "units", "timeline"];
  lists.forEach((key) => {
    if (!Array.isArray(state[key])) {
      throw new Error("Missing list: " + key);
    }
  });
  lastState = state;
  const incidentName = state.incident && state.incident.name ? state.incident.name : "Incident";
  document.getElementById("incident-name").textContent = incidentName;
  document.title = incidentName + " - Relay";
  document.getElementById("updated").textContent = updatedPhrase(state.incident.updated_at);
  const counts = state.counts || {};
  const roster = (Number(counts.safe) || 0)
    + (Number(counts.unconfirmed) || 0)
    + (Number(counts.sos) || 0)
    + (Number(counts.en_route) || 0);
  document.getElementById("count-safe").textContent = counts.safe;
  document.getElementById("count-unconfirmed").textContent = counts.unconfirmed;
  document.getElementById("count-sos").textContent = counts.sos;
  document.getElementById("count-en-route").textContent = counts.en_route || 0;
  document.getElementById("count-safe-sub").textContent =
    rosterShare(counts.safe, roster) + "% of active roster accounted for";
  document.getElementById("count-unconfirmed-sub").textContent =
    rosterShare(counts.unconfirmed, roster) + "% of active roster still unconfirmed";
  document.getElementById("count-sos-sub").textContent =
    rosterShare(counts.sos, roster) + "% of active roster in distress";
  document.getElementById("count-en-route-sub").textContent =
    rosterShare(counts.en_route, roster) + "% of active roster en route";
  document.querySelector(".count.sos").classList.toggle("is-hot", Number(counts.sos) > 0);

  const visibleHazards = drawnHazards(state);
  syncHazards(visibleHazards);
  syncShelters(state.shelters);
  const visiblePeople = statusFilter
    ? state.people.filter((person) => person.status === statusFilter)
    : state.people;
  syncPeople(visiblePeople);
  syncReports(state.reports);
  syncUnits(state.units);
  syncVolunteers(state.volunteers);
  syncZones(firmsFires(liveFires).filter(hazardInWindow));
  paintFeed(state);
  refreshInspector();

  if (!fitted) {
    const bounds = [];
    state.people.forEach((person) => bounds.push([person.lat, person.lng]));
    state.shelters.forEach((shelter) => bounds.push([shelter.lat, shelter.lng]));
    visibleHazards.forEach((hazard) => bounds.push([hazard.lat, hazard.lng]));
    state.reports.forEach((report) => bounds.push([report.lat, report.lng]));
    state.volunteers.forEach((volunteer) => bounds.push([volunteer.lat, volunteer.lng]));
    if (bounds.length) {
      const wide = window.innerWidth > 800;
      map.fitBounds(bounds, {
        paddingTopLeft: [wide ? 440 : 28, wide ? 28 : 150],
        paddingBottomRight: [36, wide ? 72 : Math.round(window.innerHeight * 0.48)],
        animate: false,
      });
      fitted = true;
    }
    requestAnimationFrame(() => map.invalidateSize());
  }
}

function syncHazards(rows) {
  const seen = new Set();
  rows.forEach((hazard) => {
    const key = hazard.id;
    seen.add(key);
    const color = hazard.kind === "fire" ? "#f97316" : "#1a73e8";
    const tooltip = statusLabel(hazard.kind) + ", " + hazard.severity;
    const existing = hazardLayers.get(key);
    if (existing) {
      existing.setLatLng([hazard.lat, hazard.lng]);
      existing.setRadius(hazard.radius_km * 1000);
      existing.setStyle({ color: color, fillColor: color, fillOpacity: 0.22 });
      existing.setTooltipContent(tooltip);
      return;
    }
    const layer = L.circle([hazard.lat, hazard.lng], {
      radius: hazard.radius_km * 1000,
      color: color,
      weight: 2,
      fillColor: color,
      fillOpacity: 0.22,
    }).bindTooltip(tooltip);
    layer.on("click", () => {
      holdMapClick();
      openInspector(hazardModel(hazard), true);
      goTo(hazard.lat, hazard.lng, 13);
    });
    layer.addTo(hazards);
    hazardLayers.set(key, layer);
  });
  dropMissing(hazardLayers, hazards, seen);
}

function pinSvg(color, selected, small) {
  const size = small ? 18 : 28;
  const center = size / 2;
  const radius = small ? 7 : 11;
  const inner = small ? 2.6 : 4.2;
  const stroke = selected ? 2.6 : 2;
  return "<svg width='" + size + "' height='" + size + "' viewBox='0 0 " + size + " " + size + "' aria-hidden='true'>"
    + "<circle cx='" + center + "' cy='" + center + "' r='" + (radius + 1.5) + "' fill='rgba(60,64,67,0.22)'/>"
    + "<circle cx='" + center + "' cy='" + center + "' r='" + radius + "' fill='" + color + "' stroke='#fff' stroke-width='" + stroke + "'/>"
    + "<circle cx='" + center + "' cy='" + center + "' r='" + inner + "' fill='#fff'/></svg>";
}

function pinIcon(color, selected, options) {
  const opts = options || {};
  const small = !!opts.small;
  const size = small ? 18 : 28;
  const label = opts.label
    ? "<span class='pin-label'>" + esc(opts.label) + "</span>"
    : "";
  const rings = opts.sos ? "<span class='ring'></span><span class='ring late'></span>" : "";
  const cls = "gpin"
    + (selected ? " is-selected" : "")
    + (opts.sos ? " is-sos" : "")
    + (small ? " is-small" : "");
  return L.divIcon({
    className: cls,
    html: rings + "<span class='gpin-shape'>" + pinSvg(color, selected, small) + "</span>" + label,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  });
}

function paintMarker(layer, selected, icon, lift) {
  if (layer.selectedFlag !== selected) {
    layer.setIcon(icon);
    layer.selectedFlag = selected;
  }
  if (layer.setZIndexOffset) layer.setZIndexOffset(lift || 0);
}

function syncShelters(rows) {
  const seen = new Set();
  rows.forEach((shelter) => {
    const key = shelter.id;
    seen.add(key);
    if (isRouteShelter(shelter)) {
      if (shelterLayers.has(key)) {
        shelters.removeLayer(shelterLayers.get(key));
        shelterLayers.delete(key);
      }
      return;
    }
    const selected = inspector && inspector.key === "shelter:" + key;
    const tooltip = shelter.name + ", " + shelter.capacity_note;
    const icon = pinIcon("#22c55e", selected, { label: selected ? shelter.name : "" });
    const existing = shelterLayers.get(key);
    if (existing) {
      existing.setLatLng([shelter.lat, shelter.lng]);
      existing.setTooltipContent(tooltip);
      paintMarker(existing, selected, icon, selected ? 500 : 0);
      return;
    }
    const layer = L.marker([shelter.lat, shelter.lng], {
      pane: "residents",
      icon: icon,
    }).bindTooltip(tooltip);
    layer.selectedFlag = selected;
    layer.on("click", () => {
      holdMapClick();
      openInspector(shelterModel(shelter), true);
      goTo(shelter.lat, shelter.lng);
    });
    layer.addTo(shelters);
    shelterLayers.set(key, layer);
  });
  dropMissing(shelterLayers, shelters, seen);
}

function syncPeople(rows) {
  const seen = new Set();
  rows.forEach((person) => {
    const key = person.person_id;
    seen.add(key);
    if (isRouteOrigin(person)) {
      if (peopleLayers.has(key)) {
        people.removeLayer(peopleLayers.get(key));
        peopleLayers.delete(key);
      }
      return;
    }
    const selected = inspector && inspector.key === "person:" + key;
    const tooltip = person.name + ", " + statusLabel(person.status);
    const showLabel = selected || person.status === "sos";
    const icon = pinIcon(STATUS_COLOR[person.status] || "#5f6368", selected, {
      sos: person.status === "sos",
      label: showLabel ? person.name : "",
    });
    const existing = peopleLayers.get(key);
    if (existing && existing.statusName === person.status) {
      existing.setLatLng([person.lat, person.lng]);
      existing.setTooltipContent(tooltip);
      paintMarker(existing, selected, icon, person.status === "sos" ? 1000 : 0);
      return;
    }
    if (existing) people.removeLayer(existing);
    const layer = L.marker([person.lat, person.lng], {
      pane: "residents",
      icon: icon,
      zIndexOffset: person.status === "sos" ? 1000 : 0,
    });
    layer.statusName = person.status;
    layer.selectedFlag = selected;
    layer.bindTooltip(tooltip);
    layer.on("click", () => {
      holdMapClick();
      openInspector(personModel(person, lastState), true);
      goTo(person.lat, person.lng);
    });
    layer.addTo(people);
    peopleLayers.set(key, layer);
  });
  dropMissing(peopleLayers, people, seen);
}

function syncReports(rows) {
  const seen = new Set();
  rows.forEach((report) => {
    const key = report.id;
    seen.add(key);
    const selected = inspector && inspector.key === "report:" + key;
    const tooltip = statusLabel(report.kind) + ", " + report.text;
    const icon = pinIcon("#f97316", selected, { small: true, label: selected ? statusLabel(report.kind) : "" });
    const existing = reportLayers.get(key);
    if (existing) {
      existing.setLatLng([report.lat, report.lng]);
      existing.setTooltipContent(tooltip);
      paintMarker(existing, selected, icon, selected ? 400 : 0);
      return;
    }
    const layer = L.marker([report.lat, report.lng], {
      pane: "residents",
      icon: icon,
    }).bindTooltip(tooltip);
    layer.selectedFlag = selected;
    layer.on("click", () => {
      holdMapClick();
      openInspector(reportModel(report), true);
      goTo(report.lat, report.lng);
    });
    layer.addTo(reports);
    reportLayers.set(key, layer);
  });
  dropMissing(reportLayers, reports, seen);
}

function syncUnits(rows) {
  const seen = new Set();
  rows.forEach((unit) => {
    if (unit.lat == null || unit.lng == null) return;
    const key = unit.unit_id;
    seen.add(key);
    const selected = inspector && inspector.key === "unit:" + key;
    const icon = pinIcon("#5f6368", selected, { small: true, label: selected ? unit.name : "" });
    const existing = unitLayers.get(key);
    if (existing) {
      existing.setLatLng([unit.lat, unit.lng]);
      existing.setTooltipContent(unit.name);
      paintMarker(existing, selected, icon, selected ? 400 : 0);
      return;
    }
    const layer = L.marker([unit.lat, unit.lng], {
      pane: "residents",
      icon: icon,
    }).bindTooltip(unit.name);
    layer.selectedFlag = selected;
    layer.on("click", () => {
      holdMapClick();
      openInspector(unitModel(unit), true);
      goTo(unit.lat, unit.lng);
    });
    layer.addTo(units);
    unitLayers.set(key, layer);
  });
  dropMissing(unitLayers, units, seen);
}

function syncVolunteers(rows) {
  const seen = new Set();
  rows.forEach((volunteer) => {
    const key = volunteer.volunteer_id;
    seen.add(key);
    const selected = inspector && inspector.key === "volunteer:" + key;
    const tooltip = volunteer.name + ", volunteer";
    const icon = pinIcon("#5f6368", selected, { small: true, label: selected ? volunteer.name : "" });
    const existing = volunteerLayers.get(key);
    if (existing) {
      existing.setLatLng([volunteer.lat, volunteer.lng]);
      existing.setTooltipContent(tooltip);
      paintMarker(existing, selected, icon, selected ? 400 : 0);
      return;
    }
    const layer = L.marker([volunteer.lat, volunteer.lng], {
      pane: "residents",
      icon: icon,
    }).bindTooltip(tooltip);
    layer.selectedFlag = selected;
    layer.on("click", () => {
      holdMapClick();
      openInspector(volunteerModel(volunteer, lastState), true);
      goTo(volunteer.lat, volunteer.lng);
    });
    layer.addTo(volunteers);
    volunteerLayers.set(key, layer);
  });
  dropMissing(volunteerLayers, volunteers, seen);
}

function dropMissing(store, group, seen) {
  Array.from(store.keys()).forEach((key) => {
    if (seen.has(key)) return;
    group.removeLayer(store.get(key));
    store.delete(key);
  });
}

function latestChannel(name, state) {
  let best = "";
  let bestAt = -Infinity;
  state.timeline.forEach((entry) => {
    if ((entry.who || "").toLowerCase() !== String(name || "").toLowerCase()) return;
    const at = Date.parse(entry.at);
    const score = Number.isNaN(at) ? 0 : at;
    if (score >= bestAt) {
      bestAt = score;
      best = entry.channel || "";
    }
  });
  return best;
}

function personModel(person, state) {
  return {
    key: "person:" + person.person_id,
    title: person.name,
    status: person.status,
    lat: person.lat,
    lng: person.lng,
    personId: person.person_id,
    rows: [
      ["Status", statusLabel(person.status)],
      ["Phone", picture.phones[person.person_id] || "No phone in the scenario"],
      ["Language", languageName(person.language)],
      ["Last contact", ago(person.last_contact)],
      ["Last channel", channelLabel(latestChannel(person.name, state))],
    ],
  };
}

function volunteerModel(volunteer, state) {
  return {
    key: "volunteer:" + volunteer.volunteer_id,
    title: volunteer.name,
    status: "volunteer",
    lat: volunteer.lat,
    lng: volunteer.lng,
    rows: [
      ["Role", "Volunteer"],
      ["Status", statusLabel(volunteer.status)],
      ["Phone", picture.phones[volunteer.volunteer_id] || "No phone in the scenario"],
      ["Note", volunteer.capacity_note || "No capacity note"],
      ["Last channel", channelLabel(latestChannel(volunteer.name, state))],
    ],
  };
}

function shelterModel(shelter) {
  return {
    key: "shelter:" + shelter.id,
    title: shelter.name,
    status: "shelter",
    lat: shelter.lat,
    lng: shelter.lng,
    rows: [
      ["Distance", shelter.distance_km + " km"],
      ["Capacity", shelter.capacity_note || "No note"],
    ],
  };
}

function hazardModel(hazard) {
  return {
    key: "hazard:" + hazard.id,
    title: statusLabel(hazard.kind),
    status: hazard.kind,
    lat: hazard.lat,
    lng: hazard.lng,
    zoom: 13,
    rows: [
      ["Severity", hazard.severity],
      ["Radius", hazard.radius_km + " km"],
      ["Source", hazard.source],
      ["Updated", hazard.updated_at ? ago(hazard.updated_at) : "Standing"],
    ],
  };
}

function reportModel(report) {
  return {
    key: "report:" + report.id,
    title: statusLabel(report.kind),
    status: "report",
    lat: report.lat,
    lng: report.lng,
    rows: [
      ["Report", report.text],
      ["From", report.reported_by || "Unknown"],
      ["When", ago(report.at)],
    ],
  };
}

function unitModel(unit) {
  const rows = [["Last heard", ago(unit.last_heard)]];
  if (unit.lat == null || unit.lng == null) rows.push(["Position", "No position yet"]);
  return {
    key: "unit:" + unit.unit_id,
    title: unit.name,
    status: "unit",
    lat: unit.lat,
    lng: unit.lng,
    rows: rows,
  };
}

function timelineModel(entry, index, state) {
  const spot = locateTimeline(entry, state);
  return {
    key: "timeline:" + index + ":" + (entry.at || ""),
    title: entry.who || "Update",
    status: entry.channel || "radio",
    lat: spot ? spot.lat : null,
    lng: spot ? spot.lng : null,
    rows: [
      ["Channel", channelLabel(entry.channel)],
      ["When", ago(entry.at)],
      ["Update", entry.text],
    ],
  };
}

function locateTimeline(entry, state) {
  const who = (entry.who || "").toLowerCase();
  const text = (entry.text || "").toLowerCase();
  const person = state.people.find((row) => row.name.toLowerCase() === who);
  if (person) return person;
  const volunteer = state.volunteers.find((row) => row.name.toLowerCase() === who);
  if (volunteer) return volunteer;
  const shelter = state.shelters.find((row) => text.includes(row.name.toLowerCase()));
  if (shelter) return shelter;
  const report = state.reports.find((row) => text && text.includes(String(row.text || "").toLowerCase()));
  if (report) return report;
  const hazard = drawnHazards(state).find((row) => text.includes(String(row.id).toLowerCase()));
  if (hazard) return hazard;
  return null;
}

function modelByKey(key, state) {
  if (!state || !key) return null;
  const split = key.indexOf(":");
  const kind = key.slice(0, split);
  const id = key.slice(split + 1);
  if (kind === "person") {
    const person = state.people.find((row) => row.person_id === id);
    return person ? personModel(person, state) : null;
  }
  if (kind === "volunteer") {
    const volunteer = state.volunteers.find((row) => row.volunteer_id === id);
    return volunteer ? volunteerModel(volunteer, state) : null;
  }
  if (kind === "shelter") {
    const shelter = state.shelters.find((row) => row.id === id);
    return shelter ? shelterModel(shelter) : null;
  }
  if (kind === "hazard") {
    const hazard = drawnHazards(state).find((row) => row.id === id);
    return hazard ? hazardModel(hazard) : null;
  }
  if (kind === "report") {
    const report = state.reports.find((row) => row.id === id);
    return report ? reportModel(report) : null;
  }
  if (kind === "unit") {
    const unit = state.units.find((row) => row.unit_id === id);
    return unit ? unitModel(unit) : null;
  }
  if (kind === "timeline") {
    const index = Number(id.split(":")[0]);
    const entry = state.timeline[index];
    return entry ? timelineModel(entry, index, state) : null;
  }
  return null;
}

function buildCards(state) {
  const cards = [];
  const peopleRows = statusFilter
    ? state.people.filter((person) => person.status === statusFilter)
    : state.people.filter((person) => person.status === "sos" || person.status === "unconfirmed");
  peopleRows.slice(0, statusFilter ? 12 : 8).forEach((person) => {
    const model = personModel(person, state);
    cards.push({
      key: model.key,
      kind: person.status,
      title: person.name,
      detail: statusLabel(person.status),
      time: ago(person.last_contact),
      iso: person.last_contact,
      pin: person.status === "sos" ? 0 : 1,
      at: Date.parse(person.last_contact) || 0,
      lat: person.lat,
      lng: person.lng,
      personId: person.person_id,
    });
  });
  state.reports.forEach((report) => {
    cards.push({
      key: "report:" + report.id,
      kind: "report",
      title: statusLabel(report.kind),
      detail: report.text,
      time: ago(report.at),
      iso: report.at,
      pin: 0,
      at: Date.parse(report.at) || 0,
      lat: report.lat,
      lng: report.lng,
    });
  });
  state.timeline.forEach((entry, index) => {
    const spot = locateTimeline(entry, state);
    cards.push({
      key: "timeline:" + index + ":" + (entry.at || ""),
      kind: (entry.channel || "radio").toLowerCase(),
      title: entry.who || "Update",
      detail: entry.text,
      time: ago(entry.at),
      iso: entry.at,
      pin: 2,
      at: Date.parse(entry.at) || 0,
      lat: spot ? spot.lat : null,
      lng: spot ? spot.lng : null,
    });
  });
  drawnHazards(state).forEach((hazard) => {
    cards.push({
      key: "hazard:" + hazard.id,
      kind: hazard.kind,
      title: statusLabel(hazard.kind) + ", " + hazard.severity,
      detail: "Severity " + hazard.severity + ", radius " + hazard.radius_km + " km.",
      time: hazard.updated_at ? ago(hazard.updated_at) : "Standing",
      iso: hazard.updated_at,
      pin: 3,
      at: Date.parse(hazard.updated_at) || 0,
      lat: hazard.lat,
      lng: hazard.lng,
      zoom: 13,
    });
  });
  if (!statusFilter) {
    state.shelters.forEach((shelter) => {
      cards.push({
        key: "shelter:" + shelter.id,
        kind: "shelter",
        title: shelter.name,
        detail: shelter.capacity_note,
        time: shelter.distance_km + " km",
        pin: 4,
        lat: shelter.lat,
        lng: shelter.lng,
      });
    });
    state.volunteers.forEach((volunteer) => {
      cards.push({
        key: "volunteer:" + volunteer.volunteer_id,
        kind: "volunteer",
        title: volunteer.name,
        detail: volunteer.capacity_note || "Volunteer",
        time: statusLabel(volunteer.status),
        pin: 4,
        lat: volunteer.lat,
        lng: volunteer.lng,
      });
    });
    state.units.forEach((unit) => {
      cards.push({
        key: "unit:" + unit.unit_id,
        kind: "unit",
        title: unit.name,
        detail: unit.lat == null ? "No position yet" : "On the map",
      time: ago(unit.last_heard),
      iso: unit.last_heard,
      at: Date.parse(unit.last_heard) || 0,
      pin: 4,
        lat: unit.lat,
        lng: unit.lng,
      });
    });
  }
  cards.sort((left, right) => {
    const leftDated = left.at > 0;
    const rightDated = right.at > 0;
    if (leftDated && rightDated) return left.at - right.at;
    if (leftDated !== rightDated) return leftDated ? 1 : -1;
    if (left.pin !== right.pin) return left.pin - right.pin;
    return String(left.title || "").localeCompare(String(right.title || ""));
  });
  return cards;
}

function senderFor(card) {
  const title = card.title || "System Agent";
  const kind = String(card.kind || "").toLowerCase();
  if (kind === "fire" || kind === "weather" || kind === "system") return "System Agent";
  if (kind === "unit" || ((kind === "radio" || kind === "voice") && /unit/i.test(title))) {
    return title + " (Search & Rescue)";
  }
  if (kind === "volunteer") return title + " (Volunteer)";
  if (kind === "safe" || kind === "unconfirmed" || kind === "sos" || kind === "en_route"
    || kind === "imessage" || kind === "sms") {
    return title + " (Resident)";
  }
  return title;
}

function messageFor(card) {
  const kind = String(card.kind || "").toLowerCase();
  if (kind === "unconfirmed") return "No check-in yet. Still marked unconfirmed.";
  if (kind === "safe") return "Checked in safe.";
  if (kind === "sos") return "SOS received. Needs a responder now.";
  if (kind === "en_route") return "Moving toward shelter.";
  if (kind === "unit") {
    return card.detail === "No position yet"
      ? "No position has checked in."
      : "Unit is on the map.";
  }
  if (kind === "volunteer") {
    if (!card.detail || card.detail === "Volunteer") return "Volunteer is available.";
    return card.detail;
  }
  if (kind === "shelter") {
    if (!card.detail || /openstreetmap/i.test(card.detail)) return "Shelter is open.";
    return card.detail;
  }
  return card.detail || "Update received.";
}

function paintFeed(state) {
  const cards = buildCards(state);
  const count = document.getElementById("feed-count");
  if (count) count.textContent = String(cards.length);
  const key = JSON.stringify(cards.map((card) => [card.key, card.title, card.detail, card.kind]));
  const list = document.getElementById("feed");
  if (key !== feedKey) {
    feedKey = key;
    list.replaceChildren();
    if (!cards.length) {
      const empty = document.createElement("li");
      empty.className = "empty";
      empty.textContent = "No dispatch in this window.";
      list.append(empty);
    } else {
      cards.forEach((card) => list.append(feedItem(card)));
      if (feedStick) {
        requestAnimationFrame(() => {
          const top = list.scrollHeight;
          if (reduceMotion()) list.scrollTop = top;
          else list.scrollTo({ top: top, behavior: "smooth" });
        });
      }
    }
  }
  markFeedSelection();
}

function discKind(kind) {
  const name = String(kind || "").toLowerCase();
  if (name === "safe") return "safe";
  if (name === "unconfirmed") return "unconfirmed";
  if (name === "sos") return "sos";
  if (name === "en_route" || name === "radio" || name === "voice" || name === "imessage" || name === "sms") {
    return "en-route";
  }
  if (name === "fire" || name === "report") return "fire";
  if (name === "weather") return "weather";
  if (name === "shelter") return "shelter";
  return "unit";
}

function feedItem(card) {
  const item = document.createElement("li");
  const button = document.createElement("button");
  button.type = "button";
  button.dataset.key = card.key;
  const disc = document.createElement("span");
  disc.className = "log-disc log-disc-" + discKind(card.kind);
  disc.setAttribute("aria-hidden", "true");
  const main = document.createElement("span");
  main.className = "log-main";
  const who = document.createElement("span");
  who.className = "log-who";
  who.textContent = senderFor(card);
  const text = document.createElement("span");
  text.className = "log-text";
  text.textContent = messageFor(card);
  main.append(who, text);
  const time = document.createElement("time");
  if (card.iso) time.dateTime = card.iso;
  time.textContent = card.time || clock(card.iso);
  button.append(disc, main, time);
  button.addEventListener("click", () => {
    const model = modelByKey(card.key, lastState);
    if (model) openInspector(model, true);
    if (card.lat != null && card.lng != null) goTo(card.lat, card.lng, card.zoom || 15);
  });
  if (card.kind === "sos" && card.personId) {
    const row = document.createElement("div");
    row.className = "feed-row";
    const confirm = document.createElement("button");
    confirm.type = "button";
    confirm.className = "confirm-sos";
    confirm.textContent = "Confirm 911 call";
    confirm.addEventListener("click", () => {
      const model = modelByKey(card.key, lastState);
      if (model) openInspector(model, true);
      confirmPerson(card.personId);
    });
    row.append(button, confirm);
    item.append(row);
  } else {
    item.append(button);
  }
  return item;
}

function markFeedSelection() {
  const selected = inspector ? inspector.key : "";
  document.querySelectorAll("#feed button").forEach((button) => {
    button.classList.toggle("is-selected", button.dataset.key === selected);
  });
}

function fillDrawer(model) {
  const status = document.getElementById("drawer-status");
  status.textContent = statusLabel(model.status) || model.status || "Detail";
  status.className = model.status || "";
  document.getElementById("drawer-title").textContent = model.title;
  const rows = document.getElementById("drawer-rows");
  rows.replaceChildren();
  model.rows.forEach((pair) => {
    const term = document.createElement("dt");
    const value = document.createElement("dd");
    term.textContent = pair[0];
    value.textContent = pair[1];
    rows.append(term, value);
  });
  syncDrawerConfirm(model);
}

function syncDrawerConfirm(model) {
  const box = document.getElementById("drawer-confirm");
  const show = !!(model && model.status === "sos" && model.personId);
  box.hidden = !show;
  if (!show) return;
  if (box.dataset.personId !== model.personId) {
    box.dataset.personId = model.personId;
    const note = document.getElementById("confirm-note");
    const button = document.getElementById("confirm-sos");
    note.textContent = "";
    button.disabled = false;
  }
}

function responderName() {
  const input = document.getElementById("confirmed-by");
  return input ? input.value.trim() : "";
}

async function confirmPerson(personId) {
  const note = document.getElementById("confirm-note");
  const button = document.getElementById("confirm-sos");
  const name = responderName();
  if (!name) {
    document.getElementById("drawer-confirm").hidden = false;
    note.textContent = "Enter the responder name.";
    document.getElementById("confirmed-by").focus();
    return;
  }
  button.disabled = true;
  note.textContent = "Calling Core.";
  const headers = { "Content-Type": "application/json" };
  if (adminToken) headers["x-relay-admin"] = adminToken;
  try {
    const response = await fetch(
      coreBase + "/escalations/" + encodeURIComponent(personId) + "/confirm",
      {
        method: "POST",
        headers: headers,
        body: JSON.stringify({ confirmed_by: name }),
      },
    );
    const body = await response.json().catch(() => ({}));
    if (response.status === 404) {
      note.textContent = "Unknown person.";
      button.disabled = false;
      return;
    }
    if (response.status === 409) {
      note.textContent = body.error === "already_confirmed"
        ? "Already confirmed."
        : "Not in SOS.";
      button.disabled = body.error === "already_confirmed";
      return;
    }
    if (response.status === 503) {
      note.textContent = "Escalation is off.";
      button.disabled = false;
      return;
    }
    if (response.status === 400) {
      note.textContent = "Name was rejected. Do not include a phone number.";
      button.disabled = false;
      return;
    }
    if (response.status === 403) {
      note.textContent = "Admin token was rejected.";
      button.disabled = false;
      return;
    }
    if (!response.ok || body.ok !== true) {
      note.textContent = "Confirm failed.";
      button.disabled = false;
      return;
    }
    if (body.delivered === false) {
      note.textContent = "Not delivered. Press again.";
      button.disabled = false;
      return;
    }
    note.textContent = "Call placed.";
  } catch (err) {
    note.textContent = "Core did not answer. Press again.";
    button.disabled = false;
  }
}

function openInspector(model, focus) {
  const opening = !inspector || inspector.key !== model.key || document.getElementById("drawer").hidden;
  inspector = model;
  fillDrawer(model);
  document.getElementById("drawer").hidden = false;
  markFeedSelection();
  if (lastState) {
    syncPeople(statusFilter
      ? lastState.people.filter((person) => person.status === statusFilter)
      : lastState.people);
    syncVolunteers(lastState.volunteers);
  }
  if (focus && opening) document.getElementById("drawer-title").focus();
}

function refreshInspector() {
  if (!inspector) return;
  const next = modelByKey(inspector.key, lastState);
  if (!next) {
    closeDrawer();
    return;
  }
  if (statusFilter && inspector.key.indexOf("person:") === 0 && next.status !== statusFilter) {
    closeDrawer();
    return;
  }
  inspector = next;
  fillDrawer(next);
  markFeedSelection();
}

function closeDrawer() {
  inspector = null;
  document.getElementById("drawer").hidden = true;
  markFeedSelection();
  if (lastState) {
    syncPeople(statusFilter
      ? lastState.people.filter((person) => person.status === statusFilter)
      : lastState.people);
    syncVolunteers(lastState.volunteers);
  }
}

function closeLayers() {
  const menu = document.getElementById("layers-menu");
  const toggle = document.getElementById("layers-toggle");
  if (!menu || !toggle) return;
  menu.hidden = true;
  toggle.setAttribute("aria-expanded", "false");
}

function setBasemap(name) {
  activeBasemap = name;
  if (tiles) map.removeLayer(tiles);
  tiles = name === "sat" ? satelliteTiles() : streetTiles();
  tiles.addTo(map);
  document.getElementById("basemap-dark").setAttribute("aria-pressed", name === "dark" ? "true" : "false");
  document.getElementById("basemap-sat").setAttribute("aria-pressed", name === "sat" ? "true" : "false");
  closeLayers();
}

function streetTiles() {
  return L.tileLayer(
    "https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}",
    { maxZoom: 19, attribution: "Tiles &copy; Esri" },
  );
}

function satelliteTiles() {
  return L.tileLayer(
    "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    {
      maxZoom: 18,
      attribution: "Tiles &copy; Esri",
    },
  );
}

function bindChrome() {
  document.querySelectorAll(".count").forEach((button) => {
    button.addEventListener("click", () => {
      const status = button.dataset.status;
      statusFilter = statusFilter === status ? "" : status;
      document.querySelectorAll(".count").forEach((other) => {
        other.setAttribute("aria-pressed", other.dataset.status === statusFilter ? "true" : "false");
      });
      feedKey = "";
      if (lastState) render(lastState);
    });
  });
  document.getElementById("window").addEventListener("input", (event) => {
    windowHours = Number(event.target.value);
    document.getElementById("window-label").textContent = windowHours + "h";
    feedKey = "";
    if (lastState) render(lastState);
  });
  document.getElementById("basemap-dark").addEventListener("click", () => setBasemap("dark"));
  document.getElementById("basemap-sat").addEventListener("click", () => setBasemap("sat"));
  document.getElementById("layers-toggle").addEventListener("click", () => {
    const menu = document.getElementById("layers-menu");
    const open = menu.hidden;
    menu.hidden = !open;
    document.getElementById("layers-toggle").setAttribute("aria-expanded", open ? "true" : "false");
  });
  document.getElementById("drawer-close").addEventListener("click", () => closeDrawer());
  document.getElementById("drawer-back").addEventListener("click", () => closeDrawer());
  const nameInput = document.getElementById("confirmed-by");
  nameInput.value = sessionStorage.getItem(NAME_KEY) || "";
  nameInput.addEventListener("input", () => {
    sessionStorage.setItem(NAME_KEY, nameInput.value);
  });
  document.getElementById("confirm-sos").addEventListener("click", () => {
    const personId = document.getElementById("drawer-confirm").dataset.personId;
    if (personId) confirmPerson(personId);
  });
  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeDrawer();
  });
  window.addEventListener("resize", () => map.invalidateSize());
  const feed = document.getElementById("feed");
  feed.addEventListener("scroll", () => {
    feedStick = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 72;
  });
  if (typeof ResizeObserver !== "undefined") {
    const observer = new ResizeObserver(() => {
      if (map) map.invalidateSize();
    });
    observer.observe(document.getElementById("map"));
  }
}

async function fetchPicture() {
  const response = await fetch("/picture", { cache: "no-store" });
  const body = await readJson(response);
  picture.zones = Array.isArray(body.zones) ? body.zones : [];
  picture.fire = body.fire_area || null;
  picture.wind = body.wind || null;
  picture.phones = {};
  (body.phones || []).forEach((row) => {
    if (row.person_id && row.phone) picture.phones[row.person_id] = row.phone;
  });
}

function initMap() {
  map = L.map("map", { zoomControl: false });
  L.control.zoom({ position: "bottomright" }).addTo(map);
  map.createPane("zones");
  map.getPane("zones").style.zIndex = 350;
  map.createPane("residents");
  map.getPane("residents").style.zIndex = 640;
  map.createPane("hud");
  map.getPane("hud").style.zIndex = 680;
  if (picture.fire) map.setView([picture.fire.lat, picture.fire.lng], 13);
  else map.setView([0, 0], 2);
  setBasemap("dark");
  hazards = L.layerGroup().addTo(map);
  shelters = L.layerGroup().addTo(map);
  people = L.layerGroup().addTo(map);
  reports = L.layerGroup().addTo(map);
  units = L.layerGroup().addTo(map);
  volunteers = L.layerGroup().addTo(map);
  zoneLayer = L.layerGroup().addTo(map);
  map.on("click", () => {
    closeLayers();
    if (ignoreMapClick) return;
    closeDrawer();
  });
  paintWind();
}

async function loadBackup() {
  const response = await fetch("/backup-state.json", { cache: "no-store" });
  render(await readJson(response));
  showBanner("Showing the saved backup. Live state did not answer.", true);
}

async function loadForecast() {
  try {
    const forecast = await fetch("/weather", { cache: "no-store" }).then(readJson);
    const temp = Math.round(forecast.temp_f);
    const wind = Math.round(forecast.wind_mph);
    const dir = forecast.wind_dir ? " " + forecast.wind_dir : "";
    document.getElementById("forecast").textContent =
      temp + " F, " + wind + " mph" + dir + ", " + forecast.summary;
    const next = forecast.next_2h || "";
    document.getElementById("forecast-next").textContent =
      next && next !== forecast.summary ? next : "";
    const chip = document.getElementById("wind-readout");
    chip.textContent = weatherChip(forecast);
    chip.title = [forecast.summary, next].filter(Boolean).join(". ");
  } catch (err) {
    return;
  }
}

function milesLabel(km) {
  const miles = Number(km) * 0.621371;
  if (!Number.isFinite(miles)) return "0.0";
  return miles.toFixed(1);
}

function overlapLabel(route) {
  const count = (route.avoided_hazards || []).length;
  if (!count) return "Zero Hazard Overlap";
  if (count === 1) return "1 Hazard Overlap";
  return count + " Hazard Overlap";
}

function routeChipText(route) {
  return route.duration_min + " min · " + milesLabel(route.distance_km) + " mi";
}

function routeTooltip(route) {
  const overlap = overlapLabel(route);
  return overlap ? routeChipText(route) + ", " + overlap : routeChipText(route);
}

function capacityPhrase(name) {
  const rows = (lastState && lastState.shelters) || [];
  const shelter = rows.find((row) => row.name === name);
  const note = shelter && shelter.capacity_note ? String(shelter.capacity_note) : "";
  const pct = note.match(/(\d+(?:\.\d+)?)\s*%/);
  if (pct) return "Capacity: " + pct[1] + "%";
  return "";
}

function originIcon(name) {
  return L.divIcon({
    className: "origin-pin",
    html: "<span class='accuracy'></span><span class='dot'></span>"
      + "<span class='pin-label'>" + esc(name) + ", current location</span>",
    iconSize: [22, 22],
    iconAnchor: [11, 11],
  });
}

function shelterIcon(name) {
  const cap = capacityPhrase(name);
  return L.divIcon({
    className: "shelter-pin",
    html: "<span class='gpin-shape'>" + pinSvg("#22c55e", false, false) + "</span>"
      + "<span class='pill'><strong>" + esc(name || "Shelter") + "</strong><em>"
      + esc(cap || "Shelter") + "</em></span>",
    iconSize: [28, 28],
    iconAnchor: [14, 14],
  });
}

function chipIcon(text) {
  return L.divIcon({
    className: "route-hud",
    html: "<span class='chip'>" + esc(text) + "</span>",
    iconSize: [160, 28],
    iconAnchor: [80, 42],
  });
}

function clearRouteArt() {
  [routeGlow, routeLine, routeOrigin, routeDest, routeChip].forEach((layer) => {
    if (layer && map) map.removeLayer(layer);
  });
  routeGlow = null;
  routeLine = null;
  routeOrigin = null;
  routeDest = null;
  routeChip = null;
}

function syncRoutePeople() {
  if (!lastState) return;
  syncPeople(statusFilter
    ? lastState.people.filter((person) => person.status === statusFilter)
    : lastState.people);
  syncShelters(lastState.shelters);
}

function drawRoute(route, line) {
  const label = routeChipText(route);
  const tip = routeTooltip(route);
  document.getElementById("route-note").textContent =
    (route.person_name || "Resident") + " to " + (route.shelter_name || "shelter")
    + ", " + route.duration_min + " min";
  if (!routeGlow) {
    routeGlow = L.polyline(line, {
      color: "#ffffff",
      weight: 10,
      opacity: 1,
      interactive: false,
    }).addTo(map);
  } else {
    routeGlow.setLatLngs(line);
    routeGlow.setStyle({ color: "#ffffff", weight: 10, opacity: 1 });
  }
  if (!routeLine) {
    routeLine = L.polyline(line, {
      color: "#1a73e8",
      weight: 6,
      opacity: 1,
    }).bindTooltip(tip).addTo(map);
  } else {
    routeLine.setLatLngs(line);
    routeLine.setStyle({ color: "#1a73e8", weight: 6, opacity: 1 });
    routeLine.setTooltipContent(tip);
  }
  const start = line[0];
  const end = line[line.length - 1];
  const mid = line[Math.floor(line.length / 2)];
  const originName = route.person_name || "Evacuee";
  const shelterName = route.shelter_name || "Shelter";
  if (!routeOrigin) {
    routeOrigin = L.marker(start, { pane: "hud", icon: originIcon(originName), zIndexOffset: 900 }).addTo(map);
    routeOrigin._label = originName;
    routeOrigin.on("click", () => {
      holdMapClick();
      const ll = routeOrigin.getLatLng();
      if (lastState && routeMeta) {
        const person = lastState.people.find((row) => row.name === routeMeta.person_name);
        if (person) openInspector(personModel(person, lastState), true);
      }
      goTo(ll.lat, ll.lng);
    });
  } else {
    routeOrigin.setLatLng(start);
    if (routeOrigin._label !== originName) {
      routeOrigin.setIcon(originIcon(originName));
      routeOrigin._label = originName;
    }
  }
  if (!routeDest) {
    routeDest = L.marker(end, { pane: "hud", icon: shelterIcon(shelterName), zIndexOffset: 880 }).addTo(map);
    routeDest._label = shelterName;
    routeDest.on("click", () => {
      holdMapClick();
      const ll = routeDest.getLatLng();
      if (lastState && routeMeta) {
        const shelter = lastState.shelters.find((row) => row.name === routeMeta.shelter_name);
        if (shelter) openInspector(shelterModel(shelter), true);
      }
      goTo(ll.lat, ll.lng);
    });
  } else {
    routeDest.setLatLng(end);
    if (routeDest._label !== shelterName) {
      routeDest.setIcon(shelterIcon(shelterName));
      routeDest._label = shelterName;
    }
  }
  if (!routeChip) {
    routeChip = L.marker(mid, {
      pane: "hud",
      icon: chipIcon(label),
      interactive: false,
      keyboard: false,
      zIndexOffset: 600,
    }).addTo(map);
    routeChip._text = label;
  } else {
    routeChip.setLatLng(mid);
    if (routeChip._text !== label) {
      routeChip.setIcon(chipIcon(label));
      routeChip._text = label;
    }
  }
}

async function loadRoute() {
  try {
    const route = await fetch("/route", { cache: "no-store" }).then(readJson);
    const line = (route.polyline || []).map((point) => [point.lat, point.lng]);
    if (!line.length) {
      routeMeta = null;
      document.getElementById("route-note").textContent = "";
      clearRouteArt();
      syncRoutePeople();
      return;
    }
    routeMeta = route;
    if (!map) return;
    drawRoute(route, line);
    syncRoutePeople();
  } catch (err) {
    return;
  }
}

async function loadLiveFires() {
  const center = picture.fire;
  if (!center || center.lat == null || center.lng == null) return;
  try {
    const rows = await fetch(
      "/hazards?lat=" + encodeURIComponent(center.lat)
        + "&lng=" + encodeURIComponent(center.lng)
        + "&radius_km=50",
      { cache: "no-store" }
    ).then(readJson);
    liveFires = Array.isArray(rows) ? firmsFires(rows) : [];
  } catch (err) {
    return;
  }
}

async function tick() {
  loadForecast();
  loadRoute();
  await loadLiveFires();
  try {
    const response = await fetch(stateUrl, { cache: "no-store" });
    render(await readJson(response));
    showBanner("");
  } catch (err) {
    try {
      await loadBackup();
    } catch (backupErr) {
      showBanner("No picture yet. The next poll tries again.", false);
    }
  }
}

async function loadClientConfig() {
  try {
    const config = await fetch("/client-config", { cache: "no-store" }).then(readJson);
    if (config.core) coreBase = String(config.core).replace(/\/$/, "");
    adminToken = config.admin_token || "";
  } catch (err) {
    adminToken = "";
  }
}

async function boot() {
  try {
    await fetchPicture();
  } catch (err) {
    picture.wind = null;
  }
  await loadClientConfig();
  try {
    initMap();
    bindChrome();
    await tick();
  } catch (err) {
    showBanner(String(err && err.message ? err.message : err), false);
    return;
  }
  setInterval(tick, POLL_MS);
  setInterval(() => {
    if (!lastState || !lastState.incident) return;
    document.getElementById("updated").textContent = updatedPhrase(lastState.incident.updated_at);
  }, 1000);
  setInterval(async () => {
    try {
      await fetchPicture();
      paintWind();
      await loadLiveFires();
      if (lastState) {
        syncHazards(drawnHazards(lastState));
        syncZones(firmsFires(liveFires).filter(hazardInWindow));
      }
      refreshInspector();
    } catch (err) {
      paintWind();
    }
  }, 60000);
}

boot();
