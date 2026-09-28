// Weather provider (Phase 4 context) — Open-Meteo, free and keyless.
// https://open-meteo.com/en/docs  Returns a small daily forecast summary.

import { fetchJson } from './http.js';

export function createWeatherProvider({ baseUrl = 'https://api.open-meteo.com/v1/forecast', fetchImpl, cache } = {}) {
  return {
    name: 'open-meteo',
    async forecast([lat, lng]) {
      const key = `wx:${lat.toFixed(1)},${lng.toFixed(1)}:${new Date().toISOString().slice(0, 13)}`;
      const hit = cache?.get(key);
      if (hit) return hit;
      const url = `${baseUrl}?latitude=${lat.toFixed(3)}&longitude=${lng.toFixed(3)}&daily=precipitation_sum,weather_code,temperature_2m_max&forecast_days=3&timezone=Asia%2FKolkata`;
      const body = await fetchJson(url, { fetchImpl, timeoutMs: 6000 });
      const days = (body.daily?.time || []).map((date, i) => ({
        date,
        rainMm: body.daily.precipitation_sum?.[i] ?? 0,
        code: body.daily.weather_code?.[i] ?? 0,
        maxC: body.daily.temperature_2m_max?.[i] ?? null
      }));
      cache?.set(key, days);
      return days;
    }
  };
}
