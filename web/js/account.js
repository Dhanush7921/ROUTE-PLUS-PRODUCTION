// ACCOUNTS (Phase 3) — only active when the ROUTE+ server is running.
// Adds: sign up / sign in / sign out, profile, preferences that pre-fill the
// journey form, trips saved to the account, trip history and feedback.

import { INTERESTS, TRAVELERS } from '../../shared/taxonomy.js';
import { escapeHTML, days } from './format.js';
import { serializeJourney, sanitizeJourney } from './storage.js';
import { showDialog, closeDialog } from './ui/dialogs.js';

const $ = id => document.getElementById(id);
let user = null;
let preferences = null;

export async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(`api/${path}`, {
    method,
    credentials: 'same-origin',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error?.message || 'Request failed'), { code: data.error?.code, status: res.status });
  return data;
}

export const currentUser = () => user;

function updateButton() {
  const button = $('account-button');
  button.hidden = false;
  button.textContent = user ? `${user.displayName.split(' ')[0]} · My account` : 'Sign in';
}

function authView(mode = 'login', message = '') {
  const signup = mode === 'signup';
  $('account').innerHTML = `
    <button class="close" data-close="account" aria-label="Close">×</button>
    <span class="eyebrow">${signup ? 'CREATE YOUR ACCOUNT' : 'WELCOME BACK'}</span>
    <h2 id="account-title">${signup ? 'Keep your journeys everywhere.' : 'Sign in to ROUTE+'}</h2>
    <form class="auth-form" id="auth-form" novalidate>
      ${signup ? '<label>Name<input name="displayName" autocomplete="name" maxlength="60"></label>' : ''}
      <label>Email<input name="email" type="email" autocomplete="email" required></label>
      <label>Password<input name="password" type="password" autocomplete="${signup ? 'new-password' : 'current-password'}" minlength="8" required>
        ${signup ? '<span class="source-note">At least 8 characters.</span>' : ''}</label>
      <p class="error" id="auth-error" role="alert">${escapeHTML(message)}</p>
      <button class="button primary" type="submit">${signup ? 'Create account' : 'Sign in'}</button>
    </form>
    <p class="auth-switch">${signup ? 'Already have an account?' : 'New to ROUTE+?'} <button type="button" data-auth-mode="${signup ? 'login' : 'signup'}">${signup ? 'Sign in' : 'Create an account'}</button></p>`;
  $('auth-form').addEventListener('submit', async event => {
    event.preventDefault();
    const form = event.currentTarget;
    const body = Object.fromEntries(new FormData(form));
    form.querySelector('[type=submit]').disabled = true;
    try {
      const data = await api(`auth/${signup ? 'signup' : 'login'}`, { method: 'POST', body });
      user = data.user;
      await loadPreferences();
      updateButton();
      closeDialog('account');
      window.routePlus.toast(signup ? `Welcome, ${user.displayName}!` : `Signed in as ${user.displayName}.`);
    } catch (error) {
      authView(mode, error.message);
    }
  });
  showDialog('account');
  $('account').querySelector('input')?.focus();
}

async function loadPreferences() {
  const me = await api('me');
  user = me.user;
  preferences = me.preferences;
}

async function profileView() {
  const { trips, history } = await api('trips');
  const p = preferences || { interests: [] };
  $('account').innerHTML = `
    <button class="close" data-close="account" aria-label="Close">×</button>
    <span class="eyebrow">MY ACCOUNT</span>
    <h2 id="account-title">${escapeHTML(user.displayName)}</h2>
    <p>${escapeHTML(user.email)}${user.role === 'admin' ? ' · <a class="text-link" href="admin.html">Admin dashboard</a>' : ''}</p>
    <h3>My Trips</h3>
    ${trips.length ? trips.map(t => `<div class="saved-row"><div><strong>${escapeHTML(t.origin)} → ${escapeHTML(t.destination)}</strong><p>${days(t.tripDays)} · ${t.selectedStops.length} stops · ${escapeHTML(t.status)}</p></div>
      <div class="actions"><button class="button small primary" data-load="${escapeHTML(t.id)}" data-source="account">Open</button><a class="button small" href="companion.html?trip=${encodeURIComponent(t.id)}">On the road</a></div></div>`).join('') : '<p>No trips yet. Plan a journey and choose Save Journey.</p>'}
    ${history.length ? `<h3>Trip history</h3>${history.map(h => `<p>✓ ${escapeHTML(h.origin)} → ${escapeHTML(h.destination)} · completed ${new Date(h.completedAt).toLocaleDateString('en-IN')}</p>`).join('')}` : ''}
    <h3>Preferences</h3>
    <form id="prefs-form" class="auth-form">
      <label>Usual traveller type<select name="travelerType"><option value="">No preference</option>${TRAVELERS.map(t => `<option ${p.travelerType === t ? 'selected' : ''}>${escapeHTML(t)}</option>`).join('')}</select></label>
      <fieldset><legend>Favourite interests</legend><div class="chips">${INTERESTS.map(i => `<label class="chip"><input type="checkbox" name="interests" value="${escapeHTML(i)}" ${p.interests.includes(i) ? 'checked' : ''}> ${escapeHTML(i)}</label>`).join('')}</div></fieldset>
      <label class="chip"><input type="checkbox" name="locationOptIn" ${p.locationOptIn ? 'checked' : ''}> Allow location features in the on-road companion</label>
      <button class="button" type="submit">Save preferences</button>
    </form>
    <div class="actions"><button class="button danger" data-auth-action="logout">Sign out</button></div>`;
  $('prefs-form').addEventListener('submit', async event => {
    event.preventDefault();
    const form = event.currentTarget;
    const body = {
      travelerType: form.travelerType.value || null,
      interests: [...form.querySelectorAll('[name=interests]:checked')].map(i => i.value),
      locationOptIn: form.locationOptIn.checked
    };
    preferences = (await api('me/preferences', { method: 'PUT', body })).preferences;
    window.routePlus.toast('Preferences saved. New journeys start with them.');
  });
  showDialog('account');
}

function prefillForm() {
  const form = $('journey-form');
  if (!preferences || form.elements.origin.value) return;
  if (preferences.travelerType) form.elements.travelerType.value = preferences.travelerType;
  if (preferences.interests.length) form.querySelectorAll('[name=interests]').forEach(i => { i.checked = preferences.interests.includes(i.value); });
}

export async function installAccount(app) {
  if (!app.hooks.server) return;
  try { await loadPreferences(); } catch { user = null; }
  updateButton();
  prefillForm();

  app.actions.account = () => (user ? profileView() : authView('login'));
  document.addEventListener('click', async event => {
    const b = event.target.closest('[data-auth-mode], [data-auth-action]');
    if (!b) return;
    if (b.dataset.authMode) authView(b.dataset.authMode);
    if (b.dataset.authAction === 'logout') {
      await api('auth/logout', { method: 'POST' });
      user = null; preferences = null;
      updateButton();
      closeDialog('account');
      app.toast('Signed out. Journeys on this device are still here.');
    }
  });

  app.hooks.onSave = async state => {
    if (!user) { app.toast('Saved on this browser. Sign in to keep it in your account.'); return; }
    const { trip } = await api('trips', { method: 'POST', body: serializeJourney(state) });
    state.serverTripId = trip.id;
    app.render();
    app.toast('Journey saved to your account.');
  };
  app.hooks.savedExtras = async () => (user ? { accountTrips: (await api('trips')).trips, signedIn: true } : { accountTrips: null, signedIn: false });
  app.hooks.loadAccountTrip = async id => {
    const { trip } = await api(`trips/${encodeURIComponent(id)}`);
    return sanitizeJourney(trip);
  };
  app.hooks.deleteAccountTrip = id => api(`trips/${encodeURIComponent(id)}`, { method: 'DELETE' });
  app.hooks.feedbackEnabled = () => true;
  app.hooks.onFeedback = async (placeId, worth) => {
    const visited = worth !== 'skipped';
    await api('feedback', { method: 'POST', body: { placeId, visited, worthIt: worth === 'yes' ? true : worth === 'no' ? false : null, tripId: app.state.serverTripId } });
    if (visited && user && app.state.serverTripId) await api(`trips/${app.state.serverTripId}/visited`, { method: 'POST', body: { placeId } }).catch(() => {});
    closeDialog('detail');
    app.toast('Thank you — your feedback improves recommendations for everyone.');
  };
}
