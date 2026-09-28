# ROUTE+ closed beta — test plan

## Test objective

ROUTE+ claims one thing: **you can tell, before you commit, whether a place is
worth the detour.** The beta exists to find out whether that is true for real
travellers — not whether the app is bug-free.

Three questions, in order of importance:

1. Does **`+km` / `+min`** make the add-or-skip decision easy, or do people
   still not know what a stop will cost them?
2. Does the **trip impact** (FITS / NEAR LIMIT / EXCEEDS, and the day estimate)
   match what testers believe about their own trip?
3. Are the **discoveries** worth discovering — real, relevant, correctly placed?

Everything else (polish, speed, wording) is secondary. If testers say the route
looks right but they still can't decide about a stop, the product has not worked,
however smooth it felt.

## Who to invite

6–12 people who actually take road trips in India. Mix: a family driver, a
couple, a solo traveller, at least two on Android phones, at least one on a slow
connection. No more — a closed beta you can talk to beats a big one you cannot.

## Tester instructions (send this part)

> Thanks for testing ROUTE+. It plans a road trip and, for each interesting
> place along the way, tells you what stopping there would **add** to your drive.
>
> **This is a beta. Please read the limits below — some are important.**
>
> - It is **not navigation.** Do not follow it while driving. Use it to plan.
> - Distances and times are **estimates.** They come from free, open road data.
>   Treat them as "about right", not exact.
> - **Place details** — opening hours, entry fees, how long a visit takes — are
>   our editorial estimates and may be out of date. Confirm locally before you go.
> - The map services we use are **free public services with no guarantee.** If
>   they are busy you will see *"Live map services are currently unavailable"* and
>   the app will fall back to its own offline data. That is expected; tell us
>   when you see it.
> - **Paid live map services (Google Maps, live traffic) are not included yet.**
>   There is no real-time traffic in these numbers.
> - Photos are drawn illustrations of the type of place, not photographs of the
>   actual place.
>
> Please try to plan a journey **you would really take**. Take 20–30 minutes.
> Work through the scenarios below, then answer the questions at the end.
>
> Your account and saved trips are stored on our beta server. Tell us if you want
> them deleted afterwards and we will delete them.

## Test scenarios

Do these in order. For each one, note **what you expected** and **what happened**.

| # | Scenario | What to do | What should happen |
|---|---|---|---|
| 1 | **Landing page** | Open the site. Read it without clicking. | You can say what ROUTE+ does in one sentence. If you can't, say so. |
| 2 | **Enter origin/destination** | Type a real trip of yours. Try a misspelling too. | Both places are found. A misspelling gives a helpful message next to the field, not an error page. |
| 3 | **Generate route** | Pick your trip length, traveller type and interests. Generate. | A route appears with distance, driving time, a map and route phases. |
| 4 | **Discover nearby places** | Look at the discovery cards. Use the filters. | The places are genuinely near your route, and relevant to the interests you chose. Tell us any that are wrong or badly placed. |
| 5 | **Open place details** | Open one. Read everything. | You learn enough to decide. Note anything missing, and anything you don't believe. |
| 6 | **Understand +km / +min** | Look at the `+… km` and `+… min` on a card. | **Key test.** Can you say what stopping there costs your drive, without re-reading? If not, that is the most useful thing you can tell us. |
| 7 | **Add a stop** | Add one. | The summary updates: extra distance, extra driving, time at stops. |
| 8 | **Add multiple stops** | Add two or three more. | Totals build up correctly. Nothing jumps or double-counts. |
| 9 | **Skip / remove a stop** | Skip one from the list, then remove one you added. | A skipped place leaves the list; a removed stop gives its time back. |
| 10 | **Cumulative trip impact** | Open "Your journey" and the day-by-day estimate. | The totals and the days match what you believe about your own trip. Tell us if the day plan is unrealistic. |
| 11 | **Duration warning** | Keep adding stops until you see NEAR LIMIT, then EXCEEDS. | You are warned before you overcommit, and offered a clear choice: keep your duration, extend the trip, or remove a stop. Try **both** keep and extend. |
| 12 | **Save / restore journey** | Create an account, save the journey, reload the page, then open it from your saved list. | Everything comes back: stops, duration, decisions. |
| 13 | **Mobile / PWA** | Do 1–12 again on your phone. Add it to your home screen. Open the companion view. | Usable one-handed. No sideways scrolling. Nothing important hidden. |
| 14 | **Authentication** | Sign out, sign in again. Try a wrong password once. | Sign-in works; the wrong password is refused clearly. Your trips are yours — nobody else's appear. |
| 15 | **Provider fallback message** | If you see *"Live map services are currently unavailable"* at any point, carry on. | The app keeps working on offline data and does not pretend the figures are live. Tell us whether the message made sense. |

## Known limitations (do not report these as bugs)

- No turn-by-turn navigation, and no plan to add it in beta.
- Distances/times are estimates: real road data via OSRM when reachable, a
  simplified offline network otherwise (roughly within 10–15 %).
- No live traffic, tolls, weather-related closures or seasonal road conditions.
- Place hours, fees and visit durations are editorial estimates.
- Discovery uses OpenStreetMap plus a curated list of 120 places. Coverage is
  uneven — some corridors are thin.
- Overpass (the OpenStreetMap search service) can time out; discovery then uses
  the curated list only, and says so.
- Photos are category illustrations.
- Stops are visited in the order you pass them; the app does not reorder them.
- English only.

## Feedback questions (ask every tester)

Keep it to these. Short answers.

1. In one sentence, what does ROUTE+ do?
2. Looking at a discovery card, could you tell what stopping there would cost
   your drive? (yes / mostly / no — and what confused you)
3. Did you trust the `+km` / `+min` numbers? Why or why not?
4. Did the FITS / NEAR LIMIT / EXCEEDS verdict match your own sense of your trip?
5. Which stop did you add, and which did you reject? Why?
6. Was anything **wrong** — a place in the wrong location, a silly detour figure,
   hours that are clearly incorrect?
7. On your phone: anything hard to reach, read or tap?
8. Would you use this to plan your next road trip? (yes / no / not yet — and what
   would change your answer)
9. What one thing would you add or remove?

## How to report an issue

One channel, so nothing is lost. Ask for:

- **what you did** (the exact origin and destination, the stops)
- **what you expected**, and **what happened**
- **screenshot** (phone or desktop), and roughly **when** — the server logs are
  timestamped, so a time makes it findable
- **device and browser**

In-app, the "worth the detour?" answer on a place already reaches us as
feedback, and it is the single most valuable signal — encourage testers to use
it every time they visit a place.

## Success metrics to observe

Run this on the server after a few days of testing:

```bash
npm run beta:signals            # last 14 days
npm run beta:signals -- 30
```

It reads the events the app already records and prints the funnel. What to look
for:

| Signal | Reading it |
|---|---|
| **journeys started → routes generated** | Below ~90 % means route entry is failing people (spelling, unsupported places). |
| **discoveries opened → stops added** | The core metric. A healthy number means `+km` / `+min` is doing its job. Very low means people look and cannot decide. |
| **stops added → stops removed** | High means stops cost more than testers expected — the estimates or their presentation are wrong. |
| **trip extended vs duration kept** | Both are successes: the warning worked. Neither happening at all means nobody reached the limit, so test with tighter trips. |
| **journeys started → journeys saved** | Did anyone finish planning, or do they drop out midway? |
| **place feedback count** | Below one per tester, the in-app feedback path is too hidden. |
| **provider mix** (also printed) | How often testers got real OSRM road data versus offline fallback. If fallback dominates, the beta is not testing what you think it is. |
| **detour method** (also printed) | `road-network` vs `estimated`. Tells you how much of the `+km` / `+min` feedback was about real road figures. |

Also read, by hand: every free-text comment, and the admin dashboard
(`/admin.html`) for per-place engagement — a place that is opened often and
added rarely is either badly described or not actually worth the detour.

**The beta has succeeded if** most testers can answer question 2 with "yes",
several say yes to question 8, and you end up with a short list of specific,
fixable complaints. A beta with no complaints means the testers were too polite
or the scenarios too easy.

## What is deliberately not being tested

Paid Google Maps / Places / Routes, live traffic, premium map tiles, payments,
booking, notifications, social or sharing features, and PostgreSQL at scale. All
deferred to main production on purpose — do not let tester enthusiasm pull them
into the beta.

## Privacy, and what the app records

Only what is needed to judge the product:

- **Events** — a fixed whitelist (`shared/events.js`): journey started, route
  generated, discovery seen / opened / added / skipped / removed, trip extended /
  kept / saved, journey completed, place feedback. Only whitelisted properties
  are stored; anything else in an event is dropped by the server.
- **Feedback** — the place, whether it was visited, "worth the detour?", an
  optional rating and an optional comment the tester wrote themselves.
- **Accounts** — email, a display name, a scrypt password hash. Sessions store a
  hash of the cookie, never the cookie.

**No location history.** The companion's GPS features work in the browser; a
position sent to `/api/places/near` is used to answer and is not stored. No
tracking across sites, no third-party analytics, no advertising identifiers.
Testers can ask for their account and trips to be deleted.
