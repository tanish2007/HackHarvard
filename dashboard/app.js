const POLL_MS = 2000;
const params = new URLSearchParams(location.search);
const stateUrl = params.get("state") || "/state";

const STATUS_COLOR = {
  safe: "#3ecf8e",
  unconfirmed: "#f0b429",
  sos: "#ff6b5a",
  en_route: "#7eb6ff",
};

const ZONE_STYLE = {
  evacuate: { color: "#ff6b5a", fillColor: "#ff6b5a", fillOpacity: 0.24, label: "Evacuate now" },
  warning: { color: "#f0b429", fillColor: "#f0b429", fillOpacity: 0.2, label: "Warning" },
  watch: { color: "#7eb6ff", fillColor: "#7eb6ff", fillOpacity: 0.08, label: "Watch" },
};

const FROM_DEG = {
  n: 0, north: 0, nne: 22.5, ne: 45, northeast: 45, ene: 67.5,
  e: 90, east: 90, ese: 112.5, se: 135, southeast: 135, sse: 157.5,
  s: 180, south: 180, ssw: 202.5, sw: 225, southwest: 225, wsw: 247.5,
  w: 270, west: 270, wnw: 292.5, nw: 315, northwest: 315, nnw: 337.5,
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
let windLayer = null;
const hazardLayers = new Map();
const shelterLayers = new Map();
const peopleLayers = new Map();
const reportLayers = new Map();
const unitLayers = new Map();
const volunteerLayers = new Map();
let routeLine = null;
let fitted = false;
let lastState = null;
let statusFilter = "";
let windowHours = 24;
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

function goTo(lat, lng, zoom) {
  const nextZoom = zoom || Math.max(map.getZoom(), 14);
  if (reduceMotion()) {
    map.setView([lat, lng], nextZoom);
    return;
  }
  map.flyTo([lat, lng], nextZoom, { duration: 0.65 });
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
  if (!wind || !wind.wind_dir || !wind.wind_mph) {
    el.textContent = "Wind unavailable";
    return;
  }
  const source = wind.source === "nws"
    ? "NWS"
    : wind.source === "fallback"
      ? "backup forecast"
      : "scenario forecast";
  el.textContent = wind.wind_mph + " mph from " + wind.wind_dir + ", "
    + Math.round(wind.temp_f) + " F, " + source;
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

function syncZones(hazardsRows) {
  zoneLayer.clearLayers();
  const fire = (hazardsRows || []).find((hazard) => hazard.kind === "fire") || picture.fire;
  picture.zones.forEach((zone) => {
    if (!Array.isArray(zone.polygon) || zone.polygon.length < 3) return;
    const level = fire ? zoneLevel(zone, fire) : "watch";
    const style = ZONE_STYLE[level];
    const polygon = L.polygon(zone.polygon, {
      pane: "zones",
      color: style.color,
      weight: 2,
      fillColor: style.fillColor,
      fillOpacity: style.fillOpacity,
    });
    polygon.bindTooltip(zone.name + ", " + style.label);
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
  document.getElementById("incident-name").textContent = state.incident.name;
  document.getElementById("updated").textContent = "Updated " + ago(state.incident.updated_at);
  document.getElementById("count-safe").textContent = state.counts.safe;
  document.getElementById("count-unconfirmed").textContent = state.counts.unconfirmed;
  document.getElementById("count-sos").textContent = state.counts.sos;
  document.getElementById("count-en-route").textContent = state.counts.en_route || 0;

  const visibleHazards = state.hazards.filter(hazardInWindow);
  syncHazards(visibleHazards);
  syncShelters(state.shelters);
  const visiblePeople = statusFilter
    ? state.people.filter((person) => person.status === statusFilter)
    : state.people;
  syncPeople(visiblePeople);
  syncReports(state.reports);
  syncUnits(state.units);
  syncVolunteers(state.volunteers);
  syncZones(visibleHazards);
  paintFeed(state);
  refreshInspector();

  if (!fitted) {
    const bounds = [];
    state.people.forEach((person) => bounds.push([person.lat, person.lng]));
    state.shelters.forEach((shelter) => bounds.push([shelter.lat, shelter.lng]));
    state.hazards.forEach((hazard) => bounds.push([hazard.lat, hazard.lng]));
    state.reports.forEach((report) => bounds.push([report.lat, report.lng]));
    state.volunteers.forEach((volunteer) => bounds.push([volunteer.lat, volunteer.lng]));
    picture.zones.forEach((zone) => zone.polygon.forEach((point) => bounds.push(point)));
    if (bounds.length) {
      map.fitBounds(bounds, { padding: [32, 32] });
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
    const color = hazard.kind === "fire" ? "#ff7a3c" : "#8eb7e8";
    const tooltip = statusLabel(hazard.kind) + ", " + hazard.severity;
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
      fillOpacity: 0.2,
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

function syncShelters(rows) {
  const seen = new Set();
  rows.forEach((shelter) => {
    const key = shelter.id;
    seen.add(key);
    const tooltip = shelter.name + ", " + shelter.capacity_note;
    const existing = shelterLayers.get(key);
    if (existing) {
      existing.setLatLng([shelter.lat, shelter.lng]);
      existing.setTooltipContent(tooltip);
      return;
    }
    const layer = L.circleMarker([shelter.lat, shelter.lng], {
      pane: "residents",
      radius: 7,
      color: "#5ee0d0",
      weight: 2,
      fillColor: "#0e3f3c",
      fillOpacity: 0.95,
    }).bindTooltip(tooltip);
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
    const selected = inspector && inspector.key === "person:" + key;
    const tooltip = person.name + ", " + statusLabel(person.status);
    const existing = peopleLayers.get(key);
    if (existing && existing.statusName === person.status) {
      existing.setLatLng([person.lat, person.lng]);
      existing.setTooltipContent(tooltip);
      if (person.status === "sos") {
        existing.setIcon(sosIcon(selected));
      } else {
        existing.setStyle(personStyle(person, selected));
      }
      return;
    }
    if (existing) people.removeLayer(existing);
    const layer = person.status === "sos"
      ? L.marker([person.lat, person.lng], { pane: "residents", icon: sosIcon(selected), zIndexOffset: 1000 })
      : L.circleMarker([person.lat, person.lng], personStyle(person, selected));
    layer.statusName = person.status;
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

function personStyle(person, selected) {
  const color = STATUS_COLOR[person.status] || "#e8eef4";
  return {
    pane: "residents",
    radius: 6,
    color: selected ? "#e8eef4" : color,
    weight: selected ? 3 : 1.5,
    fillColor: color,
    fillOpacity: 0.95,
  };
}

function sosIcon(selected) {
  return L.divIcon({
    className: "sos-pin" + (selected ? " is-selected" : ""),
    html: "<span class='ring'></span><span class='ring late'></span><span class='core'></span>",
    iconSize: [32, 32],
    iconAnchor: [16, 16],
  });
}

function syncReports(rows) {
  const seen = new Set();
  rows.forEach((report) => {
    const key = report.id;
    seen.add(key);
    const tooltip = statusLabel(report.kind) + ", " + report.text;
    const existing = reportLayers.get(key);
    if (existing) {
      existing.setLatLng([report.lat, report.lng]);
      existing.setTooltipContent(tooltip);
      return;
    }
    const layer = L.circleMarker([report.lat, report.lng], {
      pane: "residents",
      radius: 6,
      color: "#e7c8a0",
      fillColor: "#e7c8a0",
      fillOpacity: 0.9,
    }).bindTooltip(tooltip);
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
    const existing = unitLayers.get(key);
    if (existing) {
      existing.setLatLng([unit.lat, unit.lng]);
      existing.setTooltipContent(unit.name);
      return;
    }
    const layer = L.circleMarker([unit.lat, unit.lng], {
      pane: "residents",
      radius: 6,
      color: "#d5dde6",
      fillColor: "#d5dde6",
      fillOpacity: 0.9,
    }).bindTooltip(unit.name);
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
    const existing = volunteerLayers.get(key);
    if (existing) {
      existing.setLatLng([volunteer.lat, volunteer.lng]);
      existing.setTooltipContent(tooltip);
      existing.setIcon(volunteerIcon(selected));
      return;
    }
    const layer = L.marker([volunteer.lat, volunteer.lng], {
      pane: "residents",
      icon: volunteerIcon(selected),
    }).bindTooltip(tooltip);
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

function volunteerIcon(selected) {
  return L.divIcon({
    className: "volunteer-pin" + (selected ? " is-selected" : ""),
    html: "<span></span>",
    iconSize: [14, 14],
    iconAnchor: [7, 7],
  });
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
  const hazard = state.hazards.find((row) => text.includes(String(row.id).toLowerCase()));
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
    const hazard = state.hazards.find((row) => row.id === id);
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
      pin: person.status === "sos" ? 0 : 1,
      lat: person.lat,
      lng: person.lng,
    });
  });
  state.reports.forEach((report) => {
    cards.push({
      key: "report:" + report.id,
      kind: "report",
      title: statusLabel(report.kind),
      detail: report.text,
      time: ago(report.at),
      pin: 0,
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
      pin: 2,
      at: Date.parse(entry.at) || 0,
      lat: spot ? spot.lat : null,
      lng: spot ? spot.lng : null,
    });
  });
  state.hazards.filter(hazardInWindow).forEach((hazard) => {
    cards.push({
      key: "hazard:" + hazard.id,
      kind: hazard.kind,
      title: statusLabel(hazard.kind) + ", " + hazard.severity,
      detail: hazard.radius_km + " km, " + hazard.source,
      time: hazard.updated_at ? ago(hazard.updated_at) : "Standing",
      pin: 3,
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
        pin: 4,
        lat: unit.lat,
        lng: unit.lng,
      });
    });
  }
  cards.sort((left, right) => {
    if (left.pin !== right.pin) return left.pin - right.pin;
    return (right.at || 0) - (left.at || 0);
  });
  return cards;
}

function paintFeed(state) {
  const cards = buildCards(state);
  const key = JSON.stringify(cards.map((card) => [card.key, card.title, card.detail, card.time]));
  const list = document.getElementById("feed");
  if (key !== feedKey) {
    feedKey = key;
    const scroll = list.scrollTop;
    list.replaceChildren();
    if (!cards.length) {
      const empty = document.createElement("li");
      empty.className = "empty";
      empty.textContent = "Nothing in this window.";
      list.append(empty);
    } else {
      cards.forEach((card) => list.append(feedItem(card)));
      list.scrollTop = scroll;
    }
  }
  markFeedSelection();
}

function feedItem(card) {
  const item = document.createElement("li");
  const button = document.createElement("button");
  button.type = "button";
  button.dataset.key = card.key;
  const kind = document.createElement("span");
  kind.className = "kind " + card.kind;
  kind.textContent = statusLabel(card.kind) || card.kind;
  const time = document.createElement("time");
  time.textContent = card.time;
  const title = document.createElement("strong");
  title.textContent = card.title;
  const detail = document.createElement("span");
  detail.className = "detail";
  detail.textContent = card.detail;
  button.append(kind, time, title, detail);
  button.addEventListener("click", () => {
    const model = modelByKey(card.key, lastState);
    if (model) openInspector(model, true);
    if (card.lat != null && card.lng != null) goTo(card.lat, card.lng, card.zoom);
  });
  item.append(button);
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

function travelBearing(direction) {
  const from = FROM_DEG[String(direction || "").trim().toLowerCase()];
  if (from == null) return null;
  return (from + 180) * Math.PI / 180;
}

function createWindLayer() {
  return L.Layer.extend({
    onAdd(target) {
      this._map = target;
      this._canvas = L.DomUtil.create("canvas", "wind-canvas");
      this._canvas.setAttribute("aria-hidden", "true");
      target.getPane("wind").appendChild(this._canvas);
      this._particles = [];
      this._wind = null;
      this._reduce = false;
      this._shift = () => {
        L.DomUtil.setPosition(this._canvas, this._map.containerPointToLayerPoint([0, 0]));
      };
      target.on("move", this._shift, this);
      target.on("zoomend resize", this._place, this);
      this._place();
      this._frame = (now) => {
        this._draw(now);
        this._raf = requestAnimationFrame(this._frame);
      };
    },
    onRemove(target) {
      cancelAnimationFrame(this._raf);
      target.off("move", this._shift, this);
      target.off("zoomend resize", this._place, this);
      this._canvas.remove();
    },
    setWind(wind, reduce) {
      this._wind = wind;
      this._reduce = reduce;
      this._particles = [];
      this._last = 0;
      if (!this._map) return;
      this._place();
      cancelAnimationFrame(this._raf);
      if (reduce) {
        this._draw(0);
        return;
      }
      this._raf = requestAnimationFrame(this._frame);
    },
    _place() {
      const size = this._map.getSize();
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      this._canvas.width = Math.max(1, size.x) * ratio;
      this._canvas.height = Math.max(1, size.y) * ratio;
      this._canvas.style.width = size.x + "px";
      this._canvas.style.height = size.y + "px";
      L.DomUtil.setPosition(this._canvas, this._map.containerPointToLayerPoint([0, 0]));
      this._ratio = ratio;
      if (!this._particles.length) this._seed();
    },
    _seed() {
      const bounds = this._map.getBounds();
      const count = this._reduce ? 36 : 80;
      this._particles = [];
      for (let index = 0; index < count; index += 1) {
        this._particles.push(this._spawn(bounds, Math.random()));
      }
    },
    _spawn(bounds, age) {
      return {
        lat: bounds.getSouth() + Math.random() * (bounds.getNorth() - bounds.getSouth()),
        lng: bounds.getWest() + Math.random() * (bounds.getEast() - bounds.getWest()),
        age: age,
      };
    },
    _draw(now) {
      if (!this._canvas || !this._wind) return;
      const bearing = travelBearing(this._wind.wind_dir);
      if (bearing == null) return;
      const ctx = this._canvas.getContext("2d");
      const ratio = this._ratio || 1;
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      ctx.clearRect(0, 0, this._canvas.width, this._canvas.height);
      const dt = this._last ? Math.min(0.05, (now - this._last) / 1000) : 0.016;
      this._last = now;
      const bounds = this._map.getBounds();
      const visual = this._reduce ? 0 : 28;
      ctx.strokeStyle = "rgba(232, 238, 244, 0.55)";
      ctx.lineWidth = 1.15;
      if (this._reduce) {
        this._particles.forEach((particle) => this._stroke(ctx, particle, bearing));
        return;
      }
      this._particles.forEach((particle) => {
        const start = this._map.latLngToContainerPoint([particle.lat, particle.lng]);
        if (!this._reduce) {
          const meters = Number(this._wind.wind_mph) * 0.44704;
          const degLat = (meters / 111320) * visual * dt;
          const degLng = degLat / Math.max(0.2, Math.cos(particle.lat * Math.PI / 180));
          particle.lat += Math.cos(bearing) * degLat;
          particle.lng += Math.sin(bearing) * degLng;
          particle.age += dt * 0.35;
          if (particle.age > 1 || !bounds.contains([particle.lat, particle.lng])) {
            const next = this._spawn(bounds, 0);
            particle.lat = next.lat;
            particle.lng = next.lng;
            particle.age = 0;
          }
        }
        const end = this._map.latLngToContainerPoint([particle.lat, particle.lng]);
        const dx = Math.sin(bearing);
        const dy = -Math.cos(bearing);
        ctx.beginPath();
        ctx.moveTo(start.x - dx * 10, start.y - dy * 10);
        ctx.lineTo(end.x, end.y);
        ctx.stroke();
      });
    },
    _stroke(ctx, particle, bearing) {
      const start = this._map.latLngToContainerPoint([particle.lat, particle.lng]);
      const dx = Math.sin(bearing) * 14;
      const dy = -Math.cos(bearing) * 14;
      ctx.beginPath();
      ctx.moveTo(start.x - dx, start.y - dy);
      ctx.lineTo(start.x + dx, start.y + dy);
      ctx.stroke();
    },
  });
}

function applyWind() {
  if (!map) return;
  const bearing = picture.wind ? travelBearing(picture.wind.wind_dir) : null;
  if (!picture.wind || !picture.wind.wind_mph || bearing == null) {
    if (windLayer) {
      map.removeLayer(windLayer);
      windLayer = null;
    }
    return;
  }
  if (!windLayer) {
    const Wind = createWindLayer();
    windLayer = new Wind();
    windLayer.addTo(map);
  }
  windLayer.setWind(picture.wind, reduceMotion());
}

function setBasemap(name) {
  activeBasemap = name;
  if (tiles) map.removeLayer(tiles);
  tiles = name === "sat" ? satelliteTiles() : darkTiles();
  tiles.addTo(map);
  document.getElementById("basemap-dark").setAttribute("aria-pressed", name === "dark" ? "true" : "false");
  document.getElementById("basemap-sat").setAttribute("aria-pressed", name === "sat" ? "true" : "false");
}

function darkTiles() {
  const attribution = "Tiles &copy; Esri";
  return L.layerGroup([
    L.tileLayer(
      "https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}",
      { maxZoom: 16, attribution: attribution },
    ),
    L.tileLayer(
      "https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}",
      { maxZoom: 16, attribution: attribution },
    ),
  ]);
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
  document.getElementById("drawer-close").addEventListener("click", () => closeDrawer());
  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeDrawer();
  });
  window.addEventListener("resize", () => map.invalidateSize());
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
  L.control.zoom({ position: "topright" }).addTo(map);
  map.createPane("zones");
  map.getPane("zones").style.zIndex = 350;
  map.createPane("wind");
  map.getPane("wind").style.zIndex = 420;
  map.getPane("wind").style.pointerEvents = "none";
  map.createPane("residents");
  map.getPane("residents").style.zIndex = 640;
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
    if (ignoreMapClick) return;
    closeDrawer();
  });
  applyWind();
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
  } catch (err) {
    return;
  }
}

async function loadRoute() {
  try {
    const route = await fetch("/route", { cache: "no-store" }).then(readJson);
    const line = (route.polyline || []).map((point) => [point.lat, point.lng]);
    const note = document.getElementById("route-note");
    if (!line.length) {
      note.textContent = "";
      return;
    }
    const label = route.person_name + " to " + route.shelter_name + ", " + route.duration_min + " min";
    note.textContent = label;
    if (routeLine) {
      routeLine.setLatLngs(line);
      routeLine.setTooltipContent(label);
      return;
    }
    routeLine = L.polyline(line, { color: "#f4f7fb", weight: 4, opacity: 0.9 }).bindTooltip(label);
    routeLine.addTo(map);
  } catch (err) {
    return;
  }
}

async function tick() {
  loadForecast();
  loadRoute();
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

async function boot() {
  try {
    await fetchPicture();
  } catch (err) {
    picture.wind = null;
  }
  try {
    initMap();
    bindChrome();
    await tick();
  } catch (err) {
    showBanner(String(err && err.message ? err.message : err), false);
    return;
  }
  setInterval(tick, POLL_MS);
  setInterval(async () => {
    try {
      await fetchPicture();
      applyWind();
      paintWind();
      if (lastState) syncZones(lastState.hazards.filter(hazardInWindow));
      refreshInspector();
    } catch (err) {
      paintWind();
    }
  }, 60000);
}

boot();
