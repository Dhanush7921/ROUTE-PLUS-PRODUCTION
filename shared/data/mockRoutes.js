// PHASE 1 MOCK DATA — simulated routes and fictional sample places.
// Used by the schematic demo mode and by tests. Phase 2 replaces this with
// geographic providers (see shared/providers). Nothing here is travel advice.

const templates = [
  { name: 'Forest waterfall', category: 'waterfall', interests: ['Nature', 'Waterfalls', 'Photography'], suitableFor: ['Family', 'Friends', 'Nature Lover', 'Photography'], distance: 12, travel: 25, visit: 60, rating: 4.6, walk: 15, description: 'A shaded trail leads to a waterfall and a quiet place to pause.', caution: 'Uneven paths can be slippery after rain. Keep away from the water’s edge.' },
  { name: 'Riverside temple', category: 'temple', interests: ['Devotional', 'Temples', 'Heritage'], suitableFor: ['Family', 'Spiritual / Devotional', 'Solo'], distance: 8, travel: 20, visit: 50, rating: 4.7, walk: 5, description: 'A peaceful temple stop with space for a short visit and reflection.', caution: 'Respect local customs. Steps may limit wheelchair access.' },
  { name: 'Local kitchen', category: 'food', interests: ['Food', 'Local Experiences'], suitableFor: ['Family', 'Friends', 'Couple', 'Solo'], distance: 4, travel: 10, visit: 40, rating: 4.5, walk: 0, description: 'A relaxed break for regional dishes, fresh tea, and a slower moment.' },
  { name: 'Old fort walk', category: 'heritage', interests: ['Heritage', 'Photography'], suitableFor: ['Friends', 'Solo', 'Photography'], distance: 22, travel: 45, visit: 90, rating: 4.4, walk: 45, description: 'Explore weathered gateways and the stories behind an old fort.', caution: 'Long walking sections and steep steps. Limited shade.' },
  { name: 'Lakeside picnic', category: 'lake', interests: ['Nature', 'Relaxation'], suitableFor: ['Family', 'Couple', 'Nature Lover'], distance: 10, travel: 25, visit: 80, rating: 4.5, walk: 5, description: 'An easygoing picnic break with lake views and a short waterside walk.' },
  { name: 'Hill trail', category: 'adventure', interests: ['Adventure', 'Mountains', 'Nature'], suitableFor: ['Adventure', 'Friends', 'Solo'], distance: 28, travel: 55, visit: 150, rating: 4.6, walk: 100, seasonalFit: false, description: 'A longer uphill trail for travellers who enjoy an active detour.', caution: 'Steep exposed terrain. Skip in heavy rain and allow daylight for the return.' },
  { name: 'Sacred river steps', category: 'river', interests: ['Devotional', 'Local Experiences'], suitableFor: ['Spiritual / Devotional', 'Family'], distance: 6, travel: 15, visit: 45, rating: 4.3, walk: 10, description: 'Pause at a riverside spiritual landmark and watch the local rhythm.', caution: 'Stay on the steps; river conditions are not assessed.' },
  { name: 'Village courtyard', category: 'hidden', interests: ['Hidden Gems', 'Local Experiences', 'Food'], suitableFor: ['Couple', 'Friends', 'Solo'], distance: 14, travel: 30, visit: 75, rating: 4.2, walk: 10, description: 'Small local stalls and a courtyard offer an unhurried cultural stop.' },
  { name: 'Mountain overlook', category: 'viewpoint', interests: ['Mountains', 'Nature', 'Photography'], suitableFor: ['Family', 'Couple', 'Nature Lover', 'Photography'], distance: 8, travel: 20, visit: 35, rating: 4.8, walk: 5, description: 'Wide mountain views without committing to a long trek.', caution: 'Stay behind barriers. Fog can reduce visibility.' },
  { name: 'Golden-hour viewpoint', category: 'photography', interests: ['Photography', 'Mountains'], suitableFor: ['Photography', 'Couple', 'Solo'], distance: 18, travel: 40, visit: 70, rating: 4.4, walk: 20, description: 'A viewpoint best suited to travellers who want time for photography.' },
  { name: 'Nature garden', category: 'rest', interests: ['Nature', 'Relaxation'], suitableFor: ['Family', 'Nature Lover', 'Couple'], distance: 5, travel: 12, visit: 40, rating: 4.3, walk: 5, description: 'A gentle garden walk to stretch your legs between longer road sections.' },
  { name: 'Forest reserve trail', category: 'adventure', interests: ['Adventure', 'Hidden Gems'], suitableFor: ['Adventure'], distance: 38, travel: 80, visit: 180, rating: 4.1, walk: 120, openNow: false, description: 'A demanding reserve trail currently unavailable in this demo.', caution: 'Closed in the sample data. Access requires local confirmation.' }
];

const routeRecords = [
  ['vizag-manali', 'Visakhapatnam', 'Manali', 2700, 1740, ['Eastern corridor', 'Central corridor', 'Northern corridor', 'Himalayan approach']],
  ['hyderabad-goa', 'Hyderabad', 'Goa', 660, 660, ['Telangana start', 'Deccan corridor', 'Western Ghats', 'Goa approach']],
  ['chennai-ooty', 'Chennai', 'Ooty', 550, 600, ['Coastal start', 'Tamil Nadu corridor', 'Foothills', 'Nilgiri approach']],
  ['delhi-jaipur', 'Delhi', 'Jaipur', 280, 300, ['Delhi start', 'Haryana corridor', 'Rajasthan corridor', 'Jaipur approach']],
  ['mumbai-goa', 'Mumbai', 'Goa', 590, 660, ['Mumbai start', 'Konkan corridor', 'Southern Konkan', 'Goa approach']]
];

function buildPlace(routeId, template, index) {
  const phaseIndex = Math.floor(index / 3);
  const longWalk = template.walk > 20;
  return {
    id: `${routeId}-place-${index + 1}`,
    name: template.name,
    category: template.category,
    interests: template.interests,
    description: template.description,
    phaseIndex,
    distanceFromRouteKm: template.distance / 2,
    detourDistanceKm: template.distance,
    detourTimeMinutes: template.travel,
    visitDurationMinutes: template.visit,
    suitableFor: template.suitableFor,
    lessSuitableFor: longWalk ? ['Travellers avoiding long walks', 'Travellers in a hurry'] : ['Travellers on a tight schedule'],
    bestTime: template.category === 'photography' ? 'Late afternoon' : 'Morning / daylight',
    entryFee: index % 3 === 0 ? '₹50 (sample)' : 'Free (sample)',
    parking: index !== 5,
    walkingMinutes: template.walk,
    walkingRequired: template.walk > 0,
    foodAvailable: template.category === 'food' || index === 4,
    facilities: index % 3 === 0 ? ['Parking', 'Rest area'] : ['Parking'],
    openNow: template.openNow !== false,
    openingHours: { open: 8 * 60, close: 18 * 60 },
    seasonal: template.seasonalFit === false,
    seasonalFit: template.seasonalFit !== false,
    caution: template.caution || 'Confirm access, hours and local conditions before travelling.',
    rating: template.rating,
    // schematic position on the demo map (percent of width / height)
    schematic: { x: 17 + phaseIndex * 21 + (index % 3 - 1) * 5, y: [22, 72, 37][index % 3] },
    source: { provider: 'sample', verified: false }
  };
}

export const MOCK_ROUTES = routeRecords.map(([id, origin, destination, distanceKm, durationMin, phaseNames]) => ({
  id,
  origin: { name: origin },
  destination: { name: destination },
  distanceKm,
  durationMin,
  phases: phaseNames.map((name, i) => ({ id: `${id}-phase-${i + 1}`, index: i, name })),
  places: templates.map((t, i) => {
    const place = buildPlace(id, t, i);
    place.routePhase = `${id}-phase-${place.phaseIndex + 1}`;
    return place;
  })
}));
