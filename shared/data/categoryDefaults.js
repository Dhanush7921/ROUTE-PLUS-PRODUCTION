// Sensible defaults per category. Any place source (curated list, OpenStreetMap,
// a future partner feed) only has to provide name, category and coordinates;
// the rest starts from these editorial defaults and can be overridden per place.
// Values are ROUTE+ editorial estimates, not measurements.

const EVERYONE = ['Family', 'Couple', 'Friends', 'Solo'];

export const CATEGORY_DEFAULTS = {
  scenic:      { visit: 40, walk: 10, suitableFor: [...EVERYONE, 'Nature Lover', 'Photography'], lessSuitableFor: ['Travellers in a hurry'], bestTime: 'Morning or late afternoon', hours: [6 * 60, 18 * 60 + 30] },
  viewpoint:   { visit: 35, walk: 10, suitableFor: [...EVERYONE, 'Nature Lover', 'Photography'], lessSuitableFor: ['Travellers in a hurry'], bestTime: 'Clear mornings; sunset', hours: [6 * 60, 18 * 60 + 30], caution: 'Stay behind barriers. Fog and rain reduce visibility.' },
  temple:      { visit: 50, walk: 10, suitableFor: ['Family', 'Spiritual / Devotional', 'Solo', 'Couple'], lessSuitableFor: ['Travellers wanting outdoor activity'], bestTime: 'Early morning', hours: [6 * 60, 20 * 60], caution: 'Dress modestly; footwear off inside. Queues are long on festival days.' },
  pilgrimage:  { visit: 90, walk: 20, suitableFor: ['Spiritual / Devotional', 'Family', 'Solo'], lessSuitableFor: ['Travellers on a tight schedule'], bestTime: 'Early morning', hours: [5 * 60, 21 * 60], caution: 'Crowded on festivals and weekends. Keep valuables secure.' },
  river:       { visit: 45, walk: 10, suitableFor: ['Spiritual / Devotional', 'Family', 'Solo', 'Photography'], lessSuitableFor: ['Travellers in a hurry'], bestTime: 'Sunrise or evening', hours: [5 * 60, 20 * 60], caution: 'River currents can be strong; do not enter the water unless it is a designated bathing ghat.' },
  monastery:   { visit: 50, walk: 10, suitableFor: ['Spiritual / Devotional', 'Family', 'Couple', 'Solo', 'Photography'], lessSuitableFor: ['Travellers wanting nightlife'], bestTime: 'Morning prayers', hours: [7 * 60, 18 * 60], caution: 'Maintain silence in prayer halls; ask before photographing monks.' },
  ashram:      { visit: 60, walk: 10, suitableFor: ['Spiritual / Devotional', 'Solo', 'Family'], lessSuitableFor: ['Adventure'], bestTime: 'Morning', hours: [6 * 60, 18 * 60] },
  heritage:    { visit: 80, walk: 40, suitableFor: ['Family', 'Couple', 'Friends', 'Solo', 'Photography'], lessSuitableFor: ['Travellers avoiding long walks'], bestTime: 'Morning (less heat)', hours: [9 * 60, 17 * 60 + 30], caution: 'Expect uneven stone steps and little shade. Carry water.' },
  nature:      { visit: 60, walk: 20, suitableFor: [...EVERYONE, 'Nature Lover'], lessSuitableFor: ['Travellers in a hurry'], bestTime: 'Morning', hours: [7 * 60, 18 * 60] },
  waterfall:   { visit: 60, walk: 20, suitableFor: ['Family', 'Friends', 'Couple', 'Nature Lover', 'Photography'], lessSuitableFor: ['Travellers with limited mobility'], bestTime: 'July–October (after monsoon)', hours: [8 * 60, 17 * 60 + 30], caution: 'Rocks are slippery. Do not enter the water; flash floods happen in monsoon.' },
  lake:        { visit: 45, walk: 10, suitableFor: [...EVERYONE, 'Nature Lover', 'Photography'], lessSuitableFor: ['Adventure'], bestTime: 'Evening', hours: [6 * 60, 19 * 60] },
  food:        { visit: 45, walk: 0, suitableFor: [...EVERYONE, 'Spiritual / Devotional', 'Nature Lover', 'Adventure', 'Photography'], lessSuitableFor: [], bestTime: 'Meal times', hours: [8 * 60, 22 * 60], facilities: ['Parking', 'Restrooms'], food: true },
  hidden:      { visit: 60, walk: 15, suitableFor: ['Couple', 'Friends', 'Solo', 'Photography'], lessSuitableFor: ['Travellers wanting full facilities'], bestTime: 'Daylight', hours: [8 * 60, 18 * 60], caution: 'Fewer facilities; confirm access locally.' },
  adventure:   { visit: 150, walk: 90, suitableFor: ['Adventure', 'Friends', 'Solo'], lessSuitableFor: ['Families with small children', 'Travellers with limited mobility'], bestTime: 'Early morning', hours: [7 * 60, 17 * 60], caution: 'Use a licensed operator; check weather before starting.' },
  photography: { visit: 60, walk: 15, suitableFor: ['Photography', 'Couple', 'Solo'], lessSuitableFor: ['Travellers in a hurry'], bestTime: 'Golden hour', hours: [5 * 60 + 30, 19 * 60] },
  rest:        { visit: 30, walk: 5, suitableFor: [...EVERYONE, 'Nature Lover'], lessSuitableFor: [], bestTime: 'Any time', hours: [7 * 60, 21 * 60], facilities: ['Parking', 'Restrooms'] },
  local:       { visit: 60, walk: 15, suitableFor: ['Couple', 'Friends', 'Solo', 'Family'], lessSuitableFor: [], bestTime: 'Daytime', hours: [9 * 60, 19 * 60] },
  wildlife:    { visit: 180, walk: 15, suitableFor: ['Family', 'Nature Lover', 'Photography', 'Adventure'], lessSuitableFor: ['Travellers on a tight schedule'], bestTime: 'Early morning safari', hours: [6 * 60, 17 * 60 + 30], caution: 'Safaris need advance booking; parks close on some days and in monsoon.' },
  cave:        { visit: 75, walk: 30, suitableFor: ['Family', 'Friends', 'Adventure', 'Photography'], lessSuitableFor: ['Travellers with limited mobility'], bestTime: 'Daytime', hours: [9 * 60, 17 * 60], caution: 'Many steps and damp floors inside.' }
};

export const DEFAULT_CAUTION = 'Confirm opening hours, access and local conditions before you go.';
