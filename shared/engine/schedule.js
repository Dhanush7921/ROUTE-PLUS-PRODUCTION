// REALISTIC TRIP MODEL (Phase 2) — simulates the journey day by day.
//
// Rules (see DAY_MODEL in config.js):
//   • each day starts at 07:00
//   • at most 9 h of driving per day, and no driving after 20:00
//   • a 15-minute break after every 2.5 h of continuous driving
//   • you drive the main route; at each added stop you leave the road, drive
//     half the extra detour time, visit, then drive the other half back
//   • if you arrive before opening you wait; if the place would close before
//     your visit ends, the visit moves to the next morning (overnight nearby)
// The output has the same shape as calculateTripImpact() plus a `days` list.

import { DAY_MODEL } from '../config.js';
import { FIT, sumStops, tripBreakdown } from './tripImpact.js';

const MAX_WAIT_MIN = 150;

export function scheduleJourney({ index, stops, originalDays, tripDays = originalDays, model = DAY_MODEL }) {
  const days = [];
  const notes = [];
  let day = null;
  let sinceBreak = 0;
  let positionKm = 0;
  let waitMinutes = 0;
  let breakMinutes = 0;

  const startDay = overnightNear => {
    if (day) { day.end = day.clock; day.overnightNear = overnightNear; }
    day = { day: days.length + 1, start: model.startTime, clock: model.startTime, drivingMinutes: 0, visitMinutes: 0, stops: [] };
    days.push(day);
    sinceBreak = 0;
  };
  const capacity = () => Math.min(model.maxDrivingMinutes - day.drivingMinutes, model.latestDriveEnd - day.clock);

  // Drive `minutes`. onMainRoute: advance position along the route.
  const drive = (minutes, onMainRoute) => {
    let left = minutes;
    let guard = 0;
    while (left > 0.01 && guard++ < 1000) {
      if (capacity() <= 0.01) startDay(onMainRoute ? nearest(positionKm) : null);
      const chunk = Math.min(left, capacity(), model.breakEveryMinutes - sinceBreak);
      day.clock += chunk;
      day.drivingMinutes += chunk;
      sinceBreak += chunk;
      left -= chunk;
      if (onMainRoute) positionKm = index.kmAtTime(index.timeAt(positionKm) + chunk);
      if (sinceBreak >= model.breakEveryMinutes - 0.01 && left > 0.01) {
        day.clock += model.breakMinutes;
        breakMinutes += model.breakMinutes;
        sinceBreak = 0;
      }
    }
  };
  const nearest = km => index.nearestTown(km) || `km ${Math.round(km)}`;

  startDay(null);
  const ordered = [...stops].sort((a, b) => (a.detour?.anchorKm ?? a.routeKm ?? 0) - (b.detour?.anchorKm ?? b.routeKm ?? 0));
  for (const stop of ordered) {
    const leaveKm = stop.detour?.anchorKm ?? stop.routeKm ?? positionKm;
    const rejoinKm = stop.detour?.rejoinKm ?? leaveKm;
    drive(index.timeAt(leaveKm) - index.timeAt(positionKm), true);
    // Drive the detour: the "extra" time covers the whole anchor→place→rejoin
    // loop net of the baseline, so the baseline A→B driving is added separately.
    const baselineMin = index.timeAt(rejoinKm) - index.timeAt(leaveKm);
    const loopMin = stop.detourTimeMinutes + baselineMin;
    drive(loopMin / 2, false);

    const hours = stop.openingHours;
    if (hours) {
      if (day.clock < hours.open) {
        const wait = hours.open - day.clock;
        if (wait > MAX_WAIT_MIN) notes.push(`${stop.name}: you would arrive ${Math.round(wait / 60)} h before opening.`);
        day.clock = hours.open; waitMinutes += wait;
      }
      if (day.clock + stop.visitDurationMinutes > hours.close) {
        notes.push(`${stop.name} would close before your visit ends — visit moved to the next morning.`);
        startDay(stop.name);
        day.clock = Math.max(model.startTime, hours.open);
      }
    }
    day.clock += stop.visitDurationMinutes;
    day.visitMinutes += stop.visitDurationMinutes;
    day.stops.push(stop.name);
    drive(loopMin / 2, false);
    positionKm = rejoinKm;
  }
  drive(index.totalMin - index.timeAt(positionKm), true);
  day.end = day.clock;
  day.overnightNear = null;

  const requiredDays = days.length;
  const totals = sumStops(stops);
  const drivingTotal = days.reduce((n, d) => n + d.drivingMinutes, 0);
  const workload = Math.round(drivingTotal + totals.totalVisitMinutes + waitMinutes + breakMinutes);
  const last = days.at(-1);
  const spareToday = Math.max(0, Math.min(model.maxDrivingMinutes - last.drivingMinutes, model.latestDriveEnd - last.end));
  const remainingMinutes = requiredDays > tripDays
    ? -Math.round((requiredDays - tripDays - 1) * model.maxDrivingMinutes + (model.maxDrivingMinutes - spareToday))
    : Math.round((tripDays - requiredDays) * model.maxDrivingMinutes + spareToday);
  const exceedsPlannedDuration = requiredDays > tripDays;
  const fit = exceedsPlannedDuration ? FIT.EXCEEDS
    : remainingMinutes < tripDays * model.maxDrivingMinutes * (1 - model.nearLimitRatio) ? FIT.NEAR : FIT.FITS;

  return {
    model: 'daily',
    assumptions: { ...model },
    originalDays,
    tripDays,
    requiredDays,
    estimatedDays: Math.max(tripDays, requiredDays),
    ...totals,
    // Same journey-time arithmetic and provenance as the simple model, so the
    // app reads one shape whichever model answered. `baseDrivingMinutes` is the
    // main route on its own — the baseline every added stop is measured against.
    ...tripBreakdown({ stops, baseDrivingMinutes: index.totalMin, totals, workload, breakMinutes, waitMinutes }),
    workload,
    availableMinutes: tripDays * model.maxDrivingMinutes,
    remainingMinutes,
    exceedsOriginalDuration: requiredDays > originalDays,
    exceedsPlannedDuration,
    extraDaysNeeded: Math.max(0, requiredDays - tripDays),
    fit,
    notes,
    days: days.map(({ clock, ...d }) => ({ ...d, drivingMinutes: Math.round(d.drivingMinutes), start: Math.round(d.start), end: Math.round(d.end) }))
  };
}
