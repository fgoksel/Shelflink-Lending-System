(() => {
  'use strict';

  const API = '/api';
  const $ = (id) => document.getElementById(id);

  const state = { token: null, username: null, poll: null, seen: new Set() };

  function loadSession() {
    try {
      const s = JSON.parse(localStorage.getItem('shelflink-session') || 'null');
      if (s && s.token) { state.token = s.token; state.username = s.username; }
    } catch (e) { /* storage unavailable: start logged out */ }
  }
  function saveSession() {
    try { localStorage.setItem('shelflink-session', JSON.stringify({ token: state.token, username: state.username })); }
    catch (e) { /* ignore */ }
  }
  function clearSession() {
    state.token = null; state.username = null;
    try { localStorage.removeItem('shelflink-session'); } catch (e) { /* ignore */ }
  }

  function toast(msg, bad) {
    const t = $('toast');
    t.textContent = msg;
    t.className = 'toast' + (bad ? ' bad' : '');
    t.hidden = false;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => { t.hidden = true; }, 3500);
  }

  function trace(method, path, status, ms) {
    const li = document.createElement('li');
    const ok = status >= 200 && status < 400;
    const parts = [new Date().toLocaleTimeString(), method, path, String(status), ms + ' ms'];
    parts.forEach((p, i) => {
      const s = document.createElement('span');
      s.textContent = p;
      if (i === 3) s.className = ok ? 'ok' : 'bad';
      li.appendChild(s);
    });
    const list = $('trace');
    list.prepend(li);
    while (list.children.length > 40) list.removeChild(list.lastChild);
  }

  async function api(method, path, body) {
    const started = performance.now();
    const headers = { 'Content-Type': 'application/json' };
    if (state.token) headers.Authorization = 'Bearer ' + state.token;
    let res;
    try {
      res = await fetch(API + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
    } catch (e) {
      trace(method, path, 0, Math.round(performance.now() - started));
      throw new Error('Cannot reach the server');
    }
    trace(method, path, res.status, Math.round(performance.now() - started));
    let data = null;
    try { data = await res.json(); } catch (e) { /* empty body */ }
    if (res.status === 401 && state.token) { logout(); throw new Error('Session expired, please log in again'); }
    if (!res.ok) throw new Error((data && data.error) || 'Request failed (' + res.status + ')');
    return data;
  }

  /* ---------- auth ---------- */
  let authMode = 'login';
  document.querySelectorAll('#auth-form button[type=submit]').forEach((b) => {
    b.addEventListener('click', () => { authMode = b.dataset.mode; });
  });

  $('auth-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = $('auth-error');
    err.hidden = true;
    const username = $('username').value.trim();
    const password = $('password').value;
    try {
      if (authMode === 'register') {
        await api('POST', '/auth/register', { username, password });
        toast('Account created, logging you in');
      }
      const data = await api('POST', '/auth/login', { username, password });
      state.token = data.token; state.username = data.username || username;
      saveSession();
      $('password').value = '';
      showApp();
    } catch (ex) {
      err.textContent = ex.message;
      err.hidden = false;
    }
  });

  function logout() {
    clearSession();
    clearInterval(state.poll);
    state.seen = new Set();
    $('app-view').hidden = true;
    $('user-chip').hidden = true;
    $('auth-view').hidden = false;
  }
  $('logout-btn').addEventListener('click', logout);

  /* ---------- views ---------- */
  function showApp() {
    $('auth-view').hidden = true;
    $('app-view').hidden = false;
    $('user-chip').hidden = false;
    $('user-name').textContent = state.username;
    refreshAll(true);
    clearInterval(state.poll);
    state.poll = setInterval(() => { loadNotifications(false); }, 3000);
  }

  function refreshAll(first) {
    loadBooks();
    loadLoans();
    loadNotifications(first);
  }

  function badgeFor(b) {
    const el = document.createElement('span');
    el.className = 'badge' + (b.available_copies === 0 ? ' out' : b.available_copies === 1 ? ' low' : '');
    el.textContent = b.available_copies === 0 ? 'None available' : b.available_copies + ' of ' + b.total_copies + ' available';
    return el;
  }

  async function loadBooks() {
    const q = $('search').value.trim();
    try {
      const books = await api('GET', '/books' + (q ? '?search=' + encodeURIComponent(q) : ''));
      const box = $('books');
      box.textContent = '';
      if (!books.length) { box.textContent = 'No books found.'; return; }
      books.forEach((b) => {
        const card = document.createElement('div');
        card.className = 'book';
        const h = document.createElement('h3'); h.textContent = b.title;
        const a = document.createElement('div'); a.className = 'author'; a.textContent = b.author;
        const btn = document.createElement('button');
        btn.className = 'btn btn-primary'; btn.textContent = 'Borrow';
        btn.disabled = b.available_copies === 0;
        btn.addEventListener('click', () => borrow(b.id, btn));
        card.append(h, a, badgeFor(b), btn);
        box.appendChild(card);
      });
    } catch (ex) { toast(ex.message, true); }
  }

  async function borrow(bookId, btn) {
    btn.disabled = true;
    try {
      const loan = await api('POST', '/loans', { bookId });
      toast('Borrowed "' + loan.book_title + '"');
      refreshAll(false);
    } catch (ex) {
      toast(ex.message, true);
      btn.disabled = false;
      loadBooks();
    }
  }

  async function giveBack(loanId, btn) {
    btn.disabled = true;
    try {
      await api('POST', '/loans/' + loanId + '/return', {});
      toast('Returned');
      refreshAll(false);
    } catch (ex) { toast(ex.message, true); btn.disabled = false; }
  }

  async function loadLoans() {
    try {
      const loans = await api('GET', '/loans/mine');
      const box = $('loans');
      box.textContent = '';
      if (!loans.length) { box.textContent = 'No loans yet.'; box.className = 'muted'; return; }
      box.className = '';
      const table = document.createElement('table');
      const head = table.createTHead().insertRow();
      ['Book', 'Due', ''].forEach((t) => { const th = document.createElement('th'); th.textContent = t; head.appendChild(th); });
      const body = table.createTBody();
      loans.forEach((l) => {
        const row = body.insertRow();
        row.insertCell().textContent = l.book_title || 'Book #' + l.book_id;
        row.insertCell().textContent = l.returned_at ? 'Returned' : new Date(l.due_at).toLocaleDateString();
        const cell = row.insertCell();
        if (!l.returned_at) {
          const b = document.createElement('button');
          b.className = 'btn'; b.textContent = 'Return';
          b.addEventListener('click', () => giveBack(l.id, b));
          cell.appendChild(b);
        }
      });
      box.appendChild(table);
    } catch (ex) { toast(ex.message, true); }
  }

  async function loadNotifications(first) {
    try {
      const notes = await api('GET', '/notifications/mine');
      const list = $('notifications');
      list.textContent = '';
      if (!notes.length) {
        const li = document.createElement('li'); li.textContent = 'Nothing yet. Borrow a book to see one arrive.'; list.appendChild(li);
        return;
      }
      notes.forEach((n) => {
        const li = document.createElement('li'); li.textContent = n.message; list.appendChild(li);
        if (!first && !state.seen.has(n.id)) toast('New notification: ' + n.message);
        state.seen.add(n.id);
      });
    } catch (ex) { /* polling errors stay quiet */ }
  }

  let searchTimer;
  $('search').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(loadBooks, 250); });
  $('clear-log').addEventListener('click', () => { $('trace').textContent = ''; });

  loadSession();
  if (state.token) showApp();
})();
