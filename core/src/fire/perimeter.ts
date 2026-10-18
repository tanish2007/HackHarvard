/**
 * Fire perimeter growth on the map, from a spread result.
 *
 * Each point on the current fire edge acts as an ignition that grows an
 * elliptical wavelet (Huygens' principle, as in FARSITE, Richards 1990).
 * With uniform fuel and wind, the perimeter after t minutes is exactly the
 * Minkowski sum of the current fire area and the t-minute spread ellipse.
 * The current area here is a circle (a FIRMS detection or the staged fire),
 * so the perimeter has a closed form through support functions:
 *
 *     h_K(n) = r + t * h_E(n),  h_E(n) = c (n.u) + sqrt(b^2 (n.u)^2 + a^2 (n.v)^2)
 *
 * where u is the head direction, v is across it, b and a are the ellipse's
 * semi-axes and c is the offset from the ignition (rear focus) to its
 * centre, all per minute. A point p is reached at
 *
 *     t* = max over n of (p.n - r) / h_E(n)
 *
 * since h_E(n) > 0 everywhere (the ignition lies inside the ellipse).
 *
 * Distances use a local flat-earth projection, accurate to well under 0.1%
 * over the few kilometres a forecast covers.
 */

/** A point on the map. */
export interface LatLng {
  lat: number;
  lng: number;
}

/**
 * The spread ellipse grown in one minute, in metres.
 *
 * Attributes:
 *     headRate (number): Head fire spread rate, m/min.
 *     backRate (number): Backing spread rate, m/min.
 *     flankRate (number): Half the ellipse width grown per minute, m/min.
 *     headDirectionDeg (number): Direction the head fire moves toward,
 *         degrees clockwise from north.
 */
export interface SpreadEllipse {
  headRate: number;
  backRate: number;
  flankRate: number;
  headDirectionDeg: number;
}

const M_PER_DEG_LAT = 111_320;

/**
 * Metres east and north of an origin.
 *
 * Args:
 *     origin (LatLng): The origin.
 *     p (LatLng): The point.
 *
 * Returns:
 *     [number, number]: East and north offsets, metres.
 */
function toLocal(origin: LatLng, p: LatLng): [number, number] {
  const k = Math.cos((origin.lat * Math.PI) / 180);
  return [(p.lng - origin.lng) * M_PER_DEG_LAT * k, (p.lat - origin.lat) * M_PER_DEG_LAT];
}

/**
 * Back from local metres to the map.
 *
 * Args:
 *     origin (LatLng): The origin.
 *     x (number): Metres east.
 *     y (number): Metres north.
 *
 * Returns:
 *     LatLng: The point.
 */
function fromLocal(origin: LatLng, x: number, y: number): LatLng {
  const k = Math.cos((origin.lat * Math.PI) / 180);
  return { lat: origin.lat + y / M_PER_DEG_LAT, lng: origin.lng + x / (M_PER_DEG_LAT * k) };
}

/** Unit vectors along the head direction (u) and across it (v), east/north. */
function axes(e: SpreadEllipse): { u: [number, number]; v: [number, number] } {
  const t = (e.headDirectionDeg * Math.PI) / 180;
  return { u: [Math.sin(t), Math.cos(t)], v: [Math.cos(t), -Math.sin(t)] };
}

/** Semi-axes and centre offset of the one-minute ellipse. */
function shape(e: SpreadEllipse): { a: number; b: number; c: number } {
  const b = (e.headRate + e.backRate) / 2;
  return { a: e.flankRate, b, c: b - e.backRate };
}

/**
 * Support function of the one-minute ellipse, measured from its ignition.
 *
 * Args:
 *     e (SpreadEllipse): The ellipse.
 *     nx (number): Unit normal, east.
 *     ny (number): Unit normal, north.
 *
 * Returns:
 *     number: How far the ellipse reaches in direction n, metres.
 */
function support(e: SpreadEllipse, nx: number, ny: number): number {
  const { u, v } = axes(e);
  const { a, b, c } = shape(e);
  const nu = nx * u[0] + ny * u[1];
  const nv = nx * v[0] + ny * v[1];
  return c * nu + Math.sqrt(b * b * nu * nu + a * a * nv * nv);
}

/**
 * The projected fire perimeter after some minutes.
 *
 * Args:
 *     center (LatLng): Centre of the current fire area.
 *     radiusM (number): Radius of the current fire area, metres. 0 for a
 *         point ignition.
 *     e (SpreadEllipse): The one-minute spread ellipse.
 *     minutes (number): How far ahead.
 *     points (number): Vertices in the polygon. Defaults to 72.
 *
 * Returns:
 *     LatLng[]: The perimeter, counter-clockwise from the head, not closed.
 */
export function perimeterAt(center: LatLng, radiusM: number, e: SpreadEllipse, minutes: number, points = 72): LatLng[] {
  const { u, v } = axes(e);
  const { a, b, c } = shape(e);
  const out: LatLng[] = [];
  for (let i = 0; i < points; i++) {
    const phi = (2 * Math.PI * i) / points;
    // Outward normal, written in the ellipse's own axes, then on the map.
    const nu = Math.cos(phi);
    const nv = Math.sin(phi);
    const nx = nu * u[0] + nv * v[0];
    const ny = nu * u[1] + nv * v[1];
    // Point where the ellipse touches its tangent with that normal.
    const d = Math.sqrt(b * b * nu * nu + a * a * nv * nv) || 1;
    const eu = c + (b * b * nu) / d;
    const ev = (a * a * nv) / d;
    const x = radiusM * nx + minutes * (eu * u[0] + ev * v[0]);
    const y = radiusM * ny + minutes * (eu * u[1] + ev * v[1]);
    out.push(fromLocal(center, x, y));
  }
  return out;
}

/**
 * Minutes until the fire reaches a point.
 *
 * Args:
 *     center (LatLng): Centre of the current fire area.
 *     radiusM (number): Radius of the current fire area, metres.
 *     e (SpreadEllipse): The one-minute spread ellipse.
 *     p (LatLng): The point.
 *
 * Returns:
 *     number: 0 if the point is already inside the fire, Infinity if the
 *         fire is not spreading, otherwise minutes.
 */
export function arrivalMinutes(center: LatLng, radiusM: number, e: SpreadEllipse, p: LatLng): number {
  const [px, py] = toLocal(center, p);
  if (Math.hypot(px, py) <= radiusM) return 0;
  if (e.headRate <= 0) return Infinity;
  // Coarse search over directions, then refine around the best one.
  let best = -Infinity;
  let bestPhi = 0;
  const value = (phi: number) => {
    const nx = Math.sin(phi);
    const ny = Math.cos(phi);
    return (px * nx + py * ny - radiusM) / support(e, nx, ny);
  };
  const steps = 720;
  for (let i = 0; i < steps; i++) {
    const phi = (2 * Math.PI * i) / steps;
    const val = value(phi);
    if (val > best) {
      best = val;
      bestPhi = phi;
    }
  }
  let lo = bestPhi - (2 * Math.PI) / steps;
  let hi = bestPhi + (2 * Math.PI) / steps;
  for (let i = 0; i < 60; i++) {
    const m1 = lo + (hi - lo) / 3;
    const m2 = hi - (hi - lo) / 3;
    if (value(m1) < value(m2)) lo = m1;
    else hi = m2;
  }
  return Math.max(0, Math.max(best, value((lo + hi) / 2)));
}
