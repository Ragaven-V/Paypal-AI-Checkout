// Account: sign in / create account / sign out. The login cookie is HttpOnly, so this
// module only ever sees the user's id and email returned by the API.
import { state } from './state.js';
import { $, showModal, showToast } from './dom.js';
import { getJSON, postJSON } from './api.js';

let mode = 'signin';
let closeModal = null;
const listeners = new Set();

// Other modules (e.g. "My orders") can react to sign-in / sign-out
export function onAccountChange(fn) {
  listeners.add(fn);
}

function setUser(user) {
  state.user = user;
  $('btn-signin').hidden = Boolean(user);
  $('btn-signout').hidden = !user;
  const email = $('account-email');
  email.hidden = !user;
  email.textContent = user ? user.email : '';
  listeners.forEach(fn => fn(user));
}

function setMode(next) {
  mode = next;
  const signup = mode === 'signup';
  $('account-title').textContent = signup ? 'Create your account' : 'Sign in';
  $('account-intro').textContent = signup
    ? 'Save your orders and see them on any device. Orders you made as a guest in this browser are added to your account.'
    : 'Sign in to see your orders on any device.';
  $('account-submit').textContent = signup ? 'Create account' : 'Sign in';
  $('account-switch-text').textContent = signup ? 'Already have an account?' : 'New here?';
  $('account-switch').textContent = signup ? 'Sign in' : 'Create an account';
  $('account-password-input').autocomplete = signup ? 'new-password' : 'current-password';
  $('account-error').textContent = '';
}

function openAccount(nextMode = 'signin') {
  setMode(nextMode);
  closeModal = showModal($('account-modal'));
  $('account-email-input').focus();
}

async function submit(e) {
  e.preventDefault();
  const email = $('account-email-input').value.trim();
  const password = $('account-password-input').value;
  const errorEl = $('account-error');
  errorEl.textContent = '';

  if (!email || !password) {
    errorEl.textContent = 'Please enter your email and password.';
    return;
  }
  if (mode === 'signup' && password.length < 8) {
    errorEl.textContent = 'Password must be at least 8 characters.';
    return;
  }

  const button = $('account-submit');
  button.disabled = true;
  try {
    const { ok, data } = await postJSON(mode === 'signup' ? '/api/auth/register' : '/api/auth/login', {
      email,
      password,
      shopperId: state.shopperId,
      sessionId: state.sessionId
    });
    if (!ok) {
      errorEl.textContent = data.error || 'Something went wrong. Please try again.';
      return;
    }
    $('account-password-input').value = '';
    closeModal?.();
    setUser(data.user);
    const linked = data.linkedOrders ? ` ${data.linkedOrders} earlier order(s) added to your account.` : '';
    showToast(mode === 'signup' ? `Welcome! Your account is ready.${linked}` : `Signed in as ${data.user.email}.${linked}`, 'success');
  } catch {
    errorEl.textContent = 'Network error. Please try again.';
  } finally {
    button.disabled = false;
  }
}

async function signOut() {
  await postJSON('/api/auth/logout', {}).catch(() => {});
  setUser(null);
  showToast('Signed out.', 'info');
}

export async function initAccount() {
  $('btn-signin').addEventListener('click', () => openAccount('signin'));
  $('btn-signout').addEventListener('click', signOut);
  $('btn-account-close').addEventListener('click', () => closeModal?.());
  $('account-switch').addEventListener('click', () => setMode(mode === 'signin' ? 'signup' : 'signin'));
  $('account-form').addEventListener('submit', submit);

  try {
    const { ok, data } = await getJSON('/api/auth/me');
    setUser(ok ? data.user : null);
  } catch {
    setUser(null);
  }
}
