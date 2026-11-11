import { initializeApp } from 'https://www.gstatic.com/firebasejs/11.0.2/firebase-app.js';
import { getAuth, getRedirectResult, GoogleAuthProvider, onAuthStateChanged, signInWithPopup, signInWithRedirect, signOut } from 'https://www.gstatic.com/firebasejs/11.0.2/firebase-auth.js';
import { collection, doc, getDoc, getFirestore, onSnapshot, updateDoc } from 'https://www.gstatic.com/firebasejs/11.0.2/firebase-firestore.js';
import { decided, decision, NOTE_LIMIT, platformResults, postText, relativeTime, statusLabel, waiting } from './review.js';

// Public web config: it names the project, it does not grant access. Access is the database rules.
const firebaseConfig = {
  apiKey: 'AIzaSyAhtlULfc9lqepZkQtAyfkNgJH-5bwBgrg',
  // The site's own address, so sign-in by redirect keeps working where third-party storage is blocked.
  authDomain: 'socialspace-review.web.app',
  projectId: 'socialspace-review',
  storageBucket: 'socialspace-review.firebasestorage.app',
  messagingSenderId: '959889181994',
  appId: '1:959889181994:web:f8cac16c1b0dfcaa5ea253',
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const root = document.getElementById('app');
const state = { user: null, allowed: null, posts: [], tab: 'review', busy: new Set(), error: '', unsubscribe: null };

const el = (tag, attrs = {}, ...children) => {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    if (key.startsWith('on')) node.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key === 'class') node.className = value;
    else node.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat()) if (child !== null && child !== undefined && child !== false) node.append(child);
  return node;
};

onAuthStateChanged(auth, async (user) => {
  state.user = user;
  state.allowed = null;
  state.posts = [];
  state.unsubscribe?.();
  state.unsubscribe = null;
  render();
  if (!user) return;
  try {
    const email = (user.email ?? '').toLowerCase();
    state.allowed = (await getDoc(doc(db, 'reviewers', email))).exists();
  } catch {
    // The rules refuse even the check when the account is not on the list.
    state.allowed = false;
  }
  if (state.allowed) {
    state.unsubscribe = onSnapshot(collection(db, 'posts'), (snapshot) => {
      state.posts = snapshot.docs.map((item) => ({ id: item.id, ...item.data() }));
      state.error = '';
      render();
    }, (error) => { state.error = `Couldn't load posts: ${error.message}`; render(); });
  }
  render();
});

// Popups are blocked in some browsers and in-app views; then the whole page goes to Google and comes back.
const POPUP_UNAVAILABLE = ['auth/popup-blocked', 'auth/operation-not-supported-in-this-environment', 'auth/cancelled-popup-request'];
getRedirectResult(auth).catch((error) => { state.error = `Sign-in failed: ${error.message}`; render(); });
async function signIn() {
  state.error = '';
  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ prompt: 'select_account' });
  try { await signInWithPopup(auth, provider); }
  catch (error) {
    if (POPUP_UNAVAILABLE.includes(error.code)) { await signInWithRedirect(auth, provider); return; }
    if (error.code !== 'auth/popup-closed-by-user') { state.error = `Sign-in failed: ${error.message}`; render(); }
  }
}

async function decide(post, status, note) {
  if (state.busy.has(post.id)) return;
  state.busy.add(post.id);
  state.error = '';
  render();
  try { await updateDoc(doc(db, 'posts', post.id), decision(status, state.user.email, note)); }
  catch (error) { state.error = `Couldn't save your decision on "${post.title}": ${error.message}`; }
  finally { state.busy.delete(post.id); render(); }
}

function render() {
  root.replaceChildren(header(), main());
}

function header() {
  return el('header', { class: 'top' },
    el('div', { class: 'brand' }, el('img', { src: 'favicon.svg', alt: '' }), el('span', {}, 'Social Space review')),
    state.user ? el('div', { class: 'who' }, el('span', {}, state.user.email), el('button', { class: 'link', onClick: () => signOut(auth) }, 'Sign out')) : null);
}

function main() {
  const body = el('main', { class: 'wrap' });
  if (state.error) body.append(el('div', { class: 'alert', role: 'alert' }, state.error));
  if (!state.user) {
    body.append(el('section', { class: 'center card' },
      el('h1', {}, 'Review posts before they go out'),
      el('p', {}, 'Sign in with the Google account that was given access.'),
      el('button', { class: 'primary', onClick: signIn }, 'Sign in with Google')));
    return body;
  }
  if (state.allowed === null) { body.append(el('p', { class: 'muted center' }, 'Checking access…')); return body; }
  if (!state.allowed) {
    body.append(el('section', { class: 'center card' },
      el('h1', {}, 'No access yet'),
      el('p', {}, `${state.user.email} isn't on the reviewers list. Ask for it to be added in Social Space, then reload this page.`)));
    return body;
  }
  const queue = waiting(state.posts);
  const done = decided(state.posts);
  body.append(el('nav', { class: 'tabs', role: 'tablist' },
    tab('review', `To review (${queue.length})`),
    tab('history', `History (${done.length})`)));
  if (state.tab === 'review') {
    body.append(queue.length ? el('div', { class: 'list' }, queue.map(reviewCard))
      : el('p', { class: 'muted center empty' }, 'Nothing to review. New posts show up here as soon as they are sent.'));
  } else {
    body.append(done.length ? el('div', { class: 'list' }, done.map(historyCard))
      : el('p', { class: 'muted center empty' }, 'No decisions yet.'));
  }
  return body;
}

function tab(id, label) {
  return el('button', { role: 'tab', 'aria-selected': String(state.tab === id), class: state.tab === id ? 'tab on' : 'tab', onClick: () => { state.tab = id; render(); } }, label);
}

function media(post) {
  if (!post.mediaUrl) return el('div', { class: 'media missing' }, 'Video not uploaded');
  // #t= starts the preview at the chosen cover moment.
  const start = post.coverMs ? `#t=${(post.coverMs / 1000).toFixed(1)}` : '';
  return el('video', { class: 'media', src: post.mediaUrl + start, controls: true, playsinline: true, preload: 'metadata' });
}

function meta(post) {
  return el('p', { class: 'meta' }, [post.brand, post.category].filter(Boolean).join(' · '), ` · sent ${relativeTime(post.submittedAt)}`);
}

function chips(list, className) {
  return el('div', { class: 'chips' }, list.map((item) => el('span', { class: className }, item)));
}

function reviewCard(post) {
  const busy = state.busy.has(post.id);
  const noteId = `note-${post.id}`;
  const note = el('textarea', { id: noteId, maxlength: String(NOTE_LIMIT), rows: '2', placeholder: 'Optional note, e.g. what to change' });
  const text = postText(post);
  return el('article', { class: 'card post' },
    media(post),
    el('div', { class: 'details' },
      el('h2', {}, post.title || 'Untitled video'),
      meta(post),
      post.youtubeTitle && post.platforms?.includes('youtube') ? el('p', {}, el('strong', {}, 'YouTube title: '), post.youtubeTitle) : null,
      el('div', { class: 'label' }, 'Description and hashtags'),
      el('pre', { class: 'text' }, text || 'No description'),
      el('div', { class: 'label' }, 'Posts to'),
      chips((post.platforms ?? []).map((platform) => platformResults({ platforms: [platform] })[0].name), 'chip'),
      post.madeWithAi ? el('p', { class: 'muted small' }, 'Labeled as made with AI where the social asks.') : null,
      el('label', { for: noteId, class: 'label' }, 'Note'),
      note,
      el('div', { class: 'actions' },
        el('button', { class: 'secondary', disabled: busy, onClick: () => decide(post, 'rejected', note.value) }, 'Reject'),
        el('button', { class: 'primary', disabled: busy, onClick: () => decide(post, 'approved', note.value) }, busy ? 'Saving…' : 'Approve and post'))));
}

function historyCard(post) {
  const status = statusLabel(post);
  return el('article', { class: 'card history' },
    el('div', { class: 'history-head' },
      el('div', {}, el('h2', {}, post.title || 'Untitled video'), meta(post)),
      el('span', { class: `badge ${status.tone}` }, status.text)),
    post.decidedBy ? el('p', { class: 'small' }, `${post.status === 'rejected' ? 'Rejected' : 'Approved'} by ${post.decidedBy} ${relativeTime(post.decidedAt)}`) : null,
    post.note ? el('p', { class: 'small note' }, `Note: ${post.note}`) : null,
    el('ul', { class: 'results' }, platformResults(post).map((result) => el('li', {},
      el('span', { class: `dot ${result.tone}` }), el('strong', {}, result.name), ' ', result.text,
      result.url ? [' · ', el('a', { href: result.url, target: '_blank', rel: 'noopener' }, 'View post')] : null))),
    el('details', {}, el('summary', {}, 'Video and text'), media(post), el('pre', { class: 'text' }, postText(post))));
}

render();
