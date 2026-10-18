const POLL_MS = 2000;
const params = new URLSearchParams(location.search);
const stateUrl = params.get("state") || "/state";

const map = L.map("map", { zoomControl: true });
L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 18,
  attribution: "&copy; OpenStreetMap",
}).addTo(map);
map.setView([37.73, -122.44], 12);

const hazards = L.layerGroup().addTo(map);
const shelters = L.layerGroup().addTo(map);
const people = L.layerGroup().addTo(map);
const hazardLayers = new Map();
const shelterLayers = new Map();
const peopleLayers = new Map();
const reportLayers = new Map();
const unitLayers = new Map();
const reports = L.layerGroup().addTo(map);
const units = L.layerGroup().addTo(map);
let fitted = false;
let timelineKey = "";

const STATUS_COLOR = {
  safe: "#1f7a4d",
  unconfirmed: "#9a6200",
  sos: "#b42318",
  en_route: "#1d4e89",
};

const sosIcon = L.divIcon({
  className: "sos-pin",
  html: "<span></span>",
  iconSize: [32, 32],
  iconAnchor: [16, 16],
});

function readJson(response) {
  if (!response.ok) {
    throw new Error("HTTP " + response.status);
  }
  return response.json();
}

function showBanner(text, backup) {
  const banner = document.getElementById("banner");
  const mode = document.getElementById("mode");
  if (!text) {
    banner.hidden = true;
    banner.textContent = "";
    mode.textContent = "Live";
    mode.className = "live";
    return;
  }
  banner.hidden = false;
  banner.textContent = text;
  mode.textContent = backup ? "Backup" : "Live";
  mode.className = backup ? "backup" : "live";
}

function render(state) {
  const lists = ["hazards", "shelters", "people", "volunteers", "reports", "units", "timeline"];
  lists.forEach((key) => {
    if (!Array.isArray(state[key])) {
      throw new Error("Missing list: " + key);
    }
  });

  document.getElementById("incident-name").textContent = state.incident.name;
  document.getElementById("updated").textContent = "Updated " + state.incident.updated_at;
  document.getElementById("count-safe").textContent = state.counts.safe;
  document.getElementById("count-unconfirmed").textContent = state.counts.unconfirmed;
  document.getElementById("count-sos").textContent = state.counts.sos;
  document.getElementById("count-en-route").textContent = state.counts.en_route || 0;

  syncHazards(state.hazards);
  syncShelters(state.shelters);
  syncPeople(state.people);
  syncReports(state.reports);
  syncUnits(state.units);
  syncTimeline(state.timeline);

  if (!fitted) {
    const bounds = [];
    state.people.forEach((person) => bounds.push([person.lat, person.lng]));
    state.shelters.forEach((shelter) => bounds.push([shelter.lat, shelter.lng]));
    state.hazards.forEach((hazard) => bounds.push([hazard.lat, hazard.lng]));
    state.reports.forEach((report) => bounds.push([report.lat, report.lng]));
    if (bounds.length) {
      map.fitBounds(bounds, { padding: [28, 28] });
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
    const color = hazard.kind === "fire" ? "#c2410c" : "#3d5a80";
    const tooltip = hazard.kind + " · " + hazard.severity;
    const existing = hazardLayers.get(key);
    if (existing) {
      existing.setLatLng([hazard.lat, hazard.lng]);
      existing.setRadius(hazard.radius_km * 1000);
      existing.setStyle({ color: color, fillColor: color });
      existing.setTooltipContent(tooltip);
      return;
    }
    const layer = L.circle([hazard.lat, hazard.lng], {
      radius: hazard.radius_km * 1000,
      color: color,
      weight: 2,
      fillColor: color,
      fillOpacity: 0.18,
    }).bindTooltip(tooltip);
    layer.addTo(hazards);
    hazardLayers.set(key, layer);
  });
  dropMissing(hazardLayers, hazards, seen);
}

function syncShelters(rows) {
  const seen = new Set();
  rows.forEach((shelter) => {
    const key = shelter.id;
    seen.add(key);
    const tooltip = shelter.name + " · " + shelter.capacity_note;
    const existing = shelterLayers.get(key);
    if (existing) {
      existing.setLatLng([shelter.lat, shelter.lng]);
      existing.setTooltipContent(tooltip);
      return;
    }
    const layer = L.circleMarker([shelter.lat, shelter.lng], {
      radius: 8,
      color: "#0f5f5a",
      fillColor: "#0f5f5a",
      fillOpacity: 0.9,
    }).bindTooltip(tooltip);
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
    const tooltip = person.name + " · " + person.status.replace(/_/g, " ");
    const existing = peopleLayers.get(key);
    if (existing && existing.statusName === person.status) {
      existing.setLatLng([person.lat, person.lng]);
      existing.setTooltipContent(tooltip);
      return;
    }
    if (existing) {
      people.removeLayer(existing);
    }
    const layer = person.status === "sos"
      ? L.marker([person.lat, person.lng], { icon: sosIcon, zIndexOffset: 1000 })
      : L.circleMarker([person.lat, person.lng], {
        radius: 7,
        color: STATUS_COLOR[person.status] || "#1c1915",
        fillColor: STATUS_COLOR[person.status] || "#1c1915",
        fillOpacity: 0.95,
      });
    layer.statusName = person.status;
    layer.bindTooltip(tooltip);
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
    const tooltip = report.kind.replace(/_/g, " ") + " · " + report.text;
    const existing = reportLayers.get(key);
    if (existing) {
      existing.setLatLng([report.lat, report.lng]);
      existing.setTooltipContent(tooltip);
      return;
    }
    const layer = L.circleMarker([report.lat, report.lng], {
      radius: 6,
      color: "#6b3f1d",
      fillColor: "#6b3f1d",
      fillOpacity: 0.9,
    }).bindTooltip(tooltip);
    layer.addTo(reports);
    reportLayers.set(key, layer);
  });
  dropMissing(reportLayers, reports, seen);
}

function syncUnits(rows) {
  const seen = new Set();
  rows.forEach((unit) => {
    if (unit.lat == null || unit.lng == null) {
      return;
    }
    const key = unit.unit_id;
    seen.add(key);
    const tooltip = unit.name;
    const existing = unitLayers.get(key);
    if (existing) {
      existing.setLatLng([unit.lat, unit.lng]);
      existing.setTooltipContent(tooltip);
      return;
    }
    const layer = L.circleMarker([unit.lat, unit.lng], {
      radius: 7,
      color: "#3d3a34",
      fillColor: "#3d3a34",
      fillOpacity: 0.9,
    }).bindTooltip(tooltip);
    layer.addTo(units);
    unitLayers.set(key, layer);
  });
  dropMissing(unitLayers, units, seen);
}

function syncTimeline(entries) {
  const nextKey = JSON.stringify(entries);
  if (nextKey === timelineKey) {
    return;
  }
  timelineKey = nextKey;
  const timeline = document.getElementById("timeline");
  timeline.replaceChildren();
  entries.forEach((entry) => {
    const item = document.createElement("li");
    const when = document.createElement("time");
    const who = document.createElement("span");
    const text = document.createElement("p");
    when.textContent = entry.at;
    who.className = "who";
    who.textContent = entry.channel + " · " + entry.who;
    text.textContent = entry.text;
    item.append(when, who, text);
    timeline.append(item);
  });
}

function dropMissing(store, group, seen) {
  Array.from(store.keys()).forEach((key) => {
    if (seen.has(key)) {
      return;
    }
    group.removeLayer(store.get(key));
    store.delete(key);
  });
}

async function loadBackup() {
  const response = await fetch("/backup-state.json", { cache: "no-store" });
  render(await readJson(response));
  showBanner("Showing the saved backup. Live /state did not answer.", true);
}

async function tick() {
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

window.addEventListener("resize", () => map.invalidateSize());
tick();
setInterval(tick, POLL_MS);
