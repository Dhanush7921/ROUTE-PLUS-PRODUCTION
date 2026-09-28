// MAP RENDERING ADAPTER
//
//   ROUTE+ map area (dashboard, unchanged UI)
//        ↓
//   renderRouteMap()  ← screens call only this
//        ↓
//   'routeplus-svg'   today: the ROUTE+ SVG route map (./map.js)
//   'google-maps-js'  later: Google Maps JavaScript API as the base map, with
//                     the SAME ROUTE+ layers on top (solid main route, dashed
//                     optional detours, added stops, phases).
//
// Google provides geographic infrastructure; ROUTE+ keeps ownership of route
// discovery, detour decisions, recommendations and trip impact. The Google
// renderer is NOT implemented in Production Step 1, so it is never selected.
//
// Key rule for later: the browser may only ever receive GOOGLE_MAPS_BROWSER_KEY
// (restricted to our website's HTTP referrers + Maps JavaScript API). The
// server key must never reach this file. Loading Google's script will also
// need the CSP in server/lib/http.js to allow maps.googleapis.com/gstatic.com.

import { renderMap as renderSvgMap } from './map.js';

const RENDERERS = {
  'routeplus-svg': { ready: true, render: renderSvgMap },
  'google-maps-js': { ready: false, render: null } // Production step: Google map display
};

let active = 'routeplus-svg';

/** Choose a renderer from server capabilities; falls back to the SVG map. */
export function selectMapRenderer(serverInfo) {
  const wantsGoogle = serverInfo?.providers?.mapRenderer === 'google-maps-js';
  active = wantsGoogle && RENDERERS['google-maps-js'].ready ? 'google-maps-js' : 'routeplus-svg';
  return active;
}

export const activeMapRenderer = () => active;

export function renderRouteMap(el, plan, state, recommended, extras) {
  return RENDERERS[active].render(el, plan, state, recommended, extras);
}
