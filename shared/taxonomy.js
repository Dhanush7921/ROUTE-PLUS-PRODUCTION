// ROUTE+ vocabulary: interests, traveller types and place categories.
// Everything here is DATA. Screens, scoring and providers read from these
// lists, so adding a new interest never requires changing app logic.

export const INTERESTS = [
  'Nature', 'Devotional', 'Temples', 'Food', 'Heritage', 'Waterfalls',
  'Mountains', 'Adventure', 'Photography', 'Hidden Gems', 'Relaxation',
  'Local Experiences'
];

export const TRAVELERS = [
  'Couple', 'Family', 'Friends', 'Solo', 'Spiritual / Devotional',
  'Nature Lover', 'Adventure', 'Photography'
];

// Each category knows which interests it naturally serves and which
// illustration to show. Providers map their raw types onto these ids.
export const CATEGORIES = {
  scenic:      { label: 'Scenic Spot',          interests: ['Nature', 'Photography'],                art: 'viewpoint' },
  temple:      { label: 'Temple',               interests: ['Temples', 'Devotional', 'Heritage'],    art: 'temple' },
  pilgrimage:  { label: 'Pilgrimage',           interests: ['Devotional', 'Temples'],                art: 'temple' },
  river:       { label: 'Sacred River',         interests: ['Devotional', 'Nature', 'Local Experiences'], art: 'ghat' },
  monastery:   { label: 'Monastery',            interests: ['Devotional', 'Heritage', 'Photography'], art: 'monastery' },
  ashram:      { label: 'Ashram',               interests: ['Devotional', 'Relaxation'],             art: 'ashram' },
  heritage:    { label: 'Heritage & Culture',   interests: ['Heritage', 'Photography'],              art: 'fort' },
  nature:      { label: 'Nature',               interests: ['Nature', 'Relaxation'],                 art: 'forest' },
  waterfall:   { label: 'Waterfall',            interests: ['Waterfalls', 'Nature', 'Photography'],  art: 'waterfall' },
  viewpoint:   { label: 'Mountain / Viewpoint', interests: ['Mountains', 'Nature', 'Photography'],   art: 'viewpoint' },
  lake:        { label: 'Lake',                 interests: ['Nature', 'Relaxation', 'Photography'],  art: 'lake' },
  food:        { label: 'Food & Local Flavours', interests: ['Food', 'Local Experiences'],           art: 'food' },
  hidden:      { label: 'Hidden Gem',           interests: ['Hidden Gems', 'Local Experiences'],     art: 'village' },
  adventure:   { label: 'Adventure',            interests: ['Adventure', 'Nature'],                  art: 'trail' },
  photography: { label: 'Photography',          interests: ['Photography'],                          art: 'viewpoint' },
  rest:        { label: 'Relaxation / Rest Stop', interests: ['Relaxation', 'Food'],                 art: 'garden' },
  local:       { label: 'Local Experience',     interests: ['Local Experiences', 'Food'],            art: 'village' },
  wildlife:    { label: 'Wildlife',             interests: ['Nature', 'Adventure', 'Photography'],   art: 'forest' },
  cave:        { label: 'Caves',                interests: ['Nature', 'Adventure', 'Hidden Gems'],   art: 'cave' }
};

export const categoryLabel = id => CATEGORIES[id]?.label || 'Discovery';

export const TRIP_DURATIONS = [
  { value: 1, label: '1 day' }, { value: 2, label: '2 days' },
  { value: 3, label: '3 days' }, { value: 4, label: '4 days' },
  { value: 5, label: '5 days' }, { value: 7, label: '7+ days' }
];

// The demo is a normal journey request. Nothing in the engine depends on it.
export const DEMO_JOURNEY = {
  origin: 'Visakhapatnam',
  destination: 'Manali',
  tripDays: 3,
  travelerType: 'Family',
  interests: ['Nature', 'Devotional', 'Food']
};
