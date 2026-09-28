// Product analytics event names (Phase 4). Shared by browser and server so
// the server can reject unknown events.
export const EVENTS = [
  'journey_started', 'route_generated', 'discovery_seen', 'discovery_opened',
  'discovery_skipped', 'discovery_added', 'discovery_removed', 'trip_extended',
  'trip_kept', 'trip_saved', 'journey_completed', 'place_feedback'
];
