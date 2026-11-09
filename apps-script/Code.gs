/**
 * Family Hub — Google Apps Script backend, bound to a Google Sheet.
 *
 * Tasks
 *   rotating — a name and a rotation order, no due date. There is always one
 *              current turn; Done passes it to the next in line. Admins can
 *              add an extra turn anywhere in the upcoming line or reorder it
 *              without changing the base rotation, which resumes afterwards.
 *   one-time — a name, a member and a due date; Done ends it.
 *   Members can ask someone else to take a turn (pass), trade turns in a
 *   rotation (switch: you do mine now, I do your next one), or ask the admins
 *   to replace them.
 * Cards: yellow cards; a 2nd unused yellow becomes a red card, which adds an
 *   extra turn for the member at the front of a task the admin picks.
 * Fun: one-off dates (name, members, time, place), good words (every 3rd
 *   comes with a prize) and a monthly allowance paid on the 1st.
 *
 * Nothing is sent automatically. The app shows everything; admins (and members,
 * for their requests) send WhatsApp messages themselves from the app.
 *
 * Upcoming line of a rotating task = Activities.planned (explicit entries)
 * followed by the rotation from Activities.current_index. Entries starting
 * with "*" are extra turns that don't use up anyone's place in the rotation.
 * A slot is a single name ("Noa") or a group joined with "+" ("Dad+Noa").
 *
 * Sheets (created / upgraded by setup()):
 *   Users, Activities (rotating tasks), Turns (task turns, one-time tasks and
 *   dates), Cards, GoodWords. Columns from older versions are left in place.
 *
 * Access: this script is only the backend (a JSON API). The screens are a
 * static page on GitHub Pages (APP_URL) that POSTs here. Each member opens a
 * personal link (APP_URL#u=<token>). Treat each link like a password.
 */

const APP_NAME = 'Family Hub';
// Where the screens are hosted. Personal links point here.
const APP_URL = 'https://roycaspi77.github.io/family-hub/';
const TZ = Session.getScriptTimeZone();

const GOOD_WORDS_PER_PRIZE = 3;
const OPEN_STATUSES = ['assigned', 'in_progress', 'upcoming'];
const EXTRA = '*';   // prefix of an extra turn in Activities.planned

const HEADERS = {
  Users: ['token', 'name', 'email', 'role', 'allowance', 'phone'],
  Activities: ['id', 'type', 'name', 'rotation', 'current_index', 'planned', 'active'],
  Turns: ['id', 'activity_id', 'type', 'title', 'assignee', 'due_at', 'place',
          'status', 'completed_at', 'completed_by', 'note',
          'offer_to', 'offer_kind', 'offer_by', 'replace_request', 'replace_reason'],
  Cards: ['id', 'member', 'color', 'explanation', 'task_id', 'red_task_id',
          'used', 'created_at', 'by'],
  GoodWords: ['id', 'member', 'explanation', 'prize', 'created_at', 'by'],
};

// ============================================================================
// Setup / upgrade (run from the Apps Script editor; safe to run again)
// ============================================================================

function setup() {
  const ss = spreadsheet_();
  Object.keys(HEADERS).forEach(name => {
    const sh = ss.getSheetByName(name) || ss.insertSheet(name);
    if (sh.getLastRow() === 0) {
      sh.appendRow(HEADERS[name]);
      sh.setFrozenRows(1);
      return;
    }
    // Upgrade: add any new columns at the end, keeping existing data.
    const existing = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
    const missing = HEADERS[name].filter(h => existing.indexOf(h) < 0);
    if (missing.length) {
      sh.getRange(1, existing.length + 1, 1, missing.length).setValues([missing]);
    }
  });

  if (readAll_('Users').length === 0) {
    writeRow_('Users', {
      token: newToken_(), name: 'Admin', email: Session.getEffectiveUser().getEmail(),
      role: 'admin', allowance: 0,
    });
  }

  // Nothing runs on a timer any more.
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'tick')
    .forEach(t => ScriptApp.deleteTrigger(t));

  migrate_();
  Logger.log('Setup done. Next: Deploy > Manage deployments > Edit > New version.');
}

/**
 * Brings data from older versions into this model: recurring fun activities
 * stop (their coming event stays as a date), red-card penalty turns become
 * extra turns, and every active rotating task gets its current turn.
 */
function migrate_() {
  const turns = readAll_('Turns');
  readAll_('Activities').forEach(a => {
    if (a.type === 'fun') {
      if (bool_(a.active)) { a.active = false; writeRow_('Activities', a); }
      return;
    }
    if (a.penalty_queue) {
      a.planned = list_(a.penalty_queue).map(s => EXTRA + s).concat(list_(a.planned)).join(',');
      a.penalty_queue = '';
    }
    if (a.swap_queue) a.swap_queue = '';
    writeRow_('Activities', a);
    if (bool_(a.active) && !turns.some(t => t.activity_id === a.id && isOpen_(t))) startNextTurn_(a);
  });
  turns.filter(t => t.type === 'task' && t.status === 'in_progress')
    .forEach(t => { t.status = 'assigned'; writeRow_('Turns', t); });
}

/** Logs every member's personal link. */
function printLinks() {
  readAll_('Users').forEach(u => Logger.log(`${u.name}: ${personalLink_(u)}`));
}

// ============================================================================
// Web app entry (JSON API)
// ============================================================================

// Only these functions can be called from the page; every one takes the
// caller's token as its first argument.
const API = {
  getState, completeTurn, offerTurn, answerOffer, requestReplace,
  adminSaveActivity, adminInsertTurn, adminMoveTurn, adminRemoveTurn, adminResetOrder,
  adminCreateOneTimeTask, adminEditTurn, adminSkipTurn, adminAnswerReplace,
  adminSaveDate, adminDeleteDate, adminGiveCard, adminGiveGoodWord,
  adminSaveUser, adminGetLinks,
};

/** The page sends text/plain JSON {fn, args} so the browser skips a CORS preflight. */
function doPost(e) {
  let result;
  try {
    const request = JSON.parse(e.postData.contents);
    const fn = API.hasOwnProperty(request.fn) ? API[request.fn] : null;
    if (!fn) throw new Error('Unknown action.');
    result = { ok: true, data: fn.apply(null, request.args || []) };
  } catch (err) {
    result = { ok: false, error: err.message || String(err) };
  }
  return ContentService.createTextOutput(JSON.stringify(result))
    .setMimeType(ContentService.MimeType.JSON);
}

function doGet() {
  return ContentService.createTextOutput(JSON.stringify({ ok: true, app: APP_NAME }))
    .setMimeType(ContentService.MimeType.JSON);
}

function getState(token) {
  const me = auth_(token);
  const admin = isAdmin_(me);
  const turns = readAll_('Turns');
  const open = turns.filter(isOpen_);
  const activities = readAll_('Activities').filter(a => a.type !== 'fun');
  const activityName = id => { const a = activities.find(x => x.id === id); return a ? a.name : ''; };
  const cards = readAll_('Cards');
  const goodWords = readAll_('GoodWords');
  const now = Date.now();
  const dates = turns.filter(t => t.type === 'fun' && t.status !== 'cancelled');

  return {
    me: { name: me.name, role: me.role, isAdmin: admin },
    users: users_().map(u => admin
      ? { name: u.name, role: u.role, email: u.email, phone: String(u.phone || ''), allowance: Number(u.allowance) || 0 }
      : { name: u.name, role: u.role, phone: String(u.phone || '') }),   // phones power the WhatsApp buttons
    rotating: activities.filter(a => admin || bool_(a.active)).map(a => {
      const current = open.find(t => t.activity_id === a.id);
      return {
        id: a.id, name: a.name, active: bool_(a.active), rotation: list_(a.rotation).join(', '),
        current: current ? turnView_(current) : null,
        upcoming: upcoming_(a, Math.max(6, list_(a.rotation).length + 3)),
        changed: list_(a.planned).length > 0,
      };
    }),
    oneTime: open.filter(t => t.type === 'task' && !t.activity_id).map(turnView_),
    offers: open.filter(t => t.offer_to === me.name).map(turnView_),
    replaceRequests: admin ? open.filter(t => t.replace_request === 'pending').map(turnView_) : [],
    history: turns.filter(t => t.type === 'task' && !isOpen_(t))
      .sort((a, b) => ms_(b.completed_at) - ms_(a.completed_at)).slice(0, 40).map(turnView_),
    dates: {
      upcoming: dates.filter(t => ms_(t.due_at) >= now - 3 * 3600000)
        .sort((a, b) => ms_(a.due_at) - ms_(b.due_at)).map(turnView_),
      past: dates.filter(t => ms_(t.due_at) < now - 3 * 3600000)
        .sort((a, b) => ms_(b.due_at) - ms_(a.due_at)).slice(0, 10).map(turnView_),
    },
    cards: {
      list: cards.slice().reverse().slice(0, 100).map(c => ({
        id: c.id, member: c.member, color: c.color, explanation: String(c.explanation || ''),
        task: activityName(c.task_id), red_task: activityName(c.red_task_id),
        used: bool_(c.used), created_at: ms_(c.created_at), by: c.by,
      })),
      summary: users_().map(u => ({
        name: u.name,
        yellow: cards.filter(c => c.member === u.name && c.color === 'yellow' && !bool_(c.used)).length,
        red: cards.filter(c => c.member === u.name && c.color === 'red').length,
      })),
    },
    goodWords: {
      list: goodWords.slice().reverse().slice(0, 100).map(g => ({
        id: g.id, member: g.member, explanation: String(g.explanation || ''),
        prize: String(g.prize || ''), created_at: ms_(g.created_at), by: g.by,
      })),
      summary: users_().map(u => ({ name: u.name, count: goodWords.filter(g => g.member === u.name).length })),
      perPrize: GOOD_WORDS_PER_PRIZE,
    },
    allowance: users_().filter(u => admin || u.name === me.name)
      .map(u => ({ name: u.name, amount: Number(u.allowance) || 0 })),
  };
}

// ---------- Member actions ----------

/** Rotating: the turn goes to the next in line. One-time: the task is over. */
function completeTurn(token, turnId, note) {
  return withLock_(() => {
    const me = auth_(token);
    const turn = openTask_(turnId);
    requireParticipant_(me, turn);
    closeTurn_(turn, 'done', me.name, clean_(note, 300));
    return getState(token);
  });
}

/**
 * Ask another member to take this turn.
 *   pass   — they take it, nothing in return.
 *   switch — (rotating only) they take it now; the asker takes their next turn.
 */
function offerTurn(token, turnId, toName, kind) {
  return withLock_(() => {
    const me = auth_(token);
    const turn = openTask_(turnId);
    if (members_(turn.assignee).indexOf(me.name) < 0) throw new Error('This is not your task.');
    if (turn.offer_to) throw new Error(`Already waiting for ${turn.offer_to} to answer.`);
    if (kind !== 'pass' && kind !== 'switch') throw new Error('Unknown request.');
    const target = userByName_(toName);
    if (!target || target.name === me.name) throw new Error('Pick another family member.');
    if (members_(turn.assignee).indexOf(target.name) >= 0) throw new Error(`${target.name} is already on this task.`);
    if (kind === 'switch') {
      if (!turn.activity_id) throw new Error('One-time tasks can only be passed, not switched.');
      const activity = activityOf_(turn);
      if (!activity || nextTurnIndexOf_(activity, target.name) < 0) {
        throw new Error(`${target.name} has no coming turn in "${turn.title}" to switch with. Use Pass instead.`);
      }
    }
    turn.offer_to = target.name;
    turn.offer_kind = kind;
    turn.offer_by = me.name;
    writeRow_('Turns', turn);
    return getState(token);
  });
}

/** The asked member accepts or declines; the asker can withdraw (accept is ignored then). */
function answerOffer(token, turnId, accept) {
  return withLock_(() => {
    const me = auth_(token);
    const turn = openTask_(turnId);
    if (!turn.offer_to) throw new Error('There is no pending request on this task.');
    const asker = turn.offer_by;
    const target = turn.offer_to;
    const kind = turn.offer_kind;
    if (me.name !== asker && me.name !== target) throw new Error('This request is not for you.');
    clearOffer_(turn);

    if (me.name === target && accept) {
      turn.assignee = replaceMember_(turn.assignee, asker, target);
      if (kind === 'switch') {
        const activity = activityOf_(turn);
        const i = activity ? nextTurnIndexOf_(activity, target) : -1;
        if (i < 0) throw new Error(`${target} has no coming turn in "${turn.title}" any more.`);
        const planned = materialize_(activity, i + 1);
        planned[i] = replaceMember_(planned[i], target, asker);
        activity.planned = planned.join(',');
        writeRow_('Activities', activity);
      }
    }
    writeRow_('Turns', turn);
    return getState(token);
  });
}

/** Ask the admins for someone else to do this turn (withdraw = true cancels the request). */
function requestReplace(token, turnId, reason, withdraw) {
  return withLock_(() => {
    const me = auth_(token);
    const turn = openTask_(turnId);
    if (members_(turn.assignee).indexOf(me.name) < 0) throw new Error('This is not your task.');
    if (withdraw) {
      turn.replace_request = '';
      turn.replace_reason = '';
    } else {
      if (turn.replace_request === 'pending') throw new Error('You already asked the admins.');
      turn.replace_request = 'pending';
      turn.replace_reason = clean_(reason, 200);
    }
    writeRow_('Turns', turn);
    return getState(token);
  });
}

// ---------- Admin: rotating tasks ----------

function adminSaveActivity(token, input) {
  return withLock_(() => {
    requireAdmin_(auth_(token));
    const rotation = list_(input.rotation).map(normalizeSlot_);
    if (!rotation.length) throw new Error('Rotation needs at least one person.');
    rotation.forEach(validateSlot_);
    const name = clean_(input.name, 60);
    if (!name) throw new Error('Name is required.');

    let activity = input.id ? readAll_('Activities').find(a => a.id === input.id) : null;
    const isNew = !activity;
    if (isNew) activity = { id: uid_(), type: 'task', current_index: 0, planned: '' };
    const wasActive = !isNew && bool_(activity.active);
    if (list_(activity.rotation).join(',') !== rotation.join(',')) {
      // A new order starts fresh; earlier changes to the line don't fit it.
      activity.planned = '';
      activity.current_index = (Number(activity.current_index) || 0) % rotation.length;
    }
    activity.name = name;
    activity.rotation = rotation.join(',');
    activity.active = input.active !== false;
    writeRow_('Activities', activity);

    const openTurns = readAll_('Turns').filter(t => t.activity_id === activity.id && isOpen_(t));
    if (!activity.active) {
      openTurns.forEach(t => closeTurn_(t, 'cancelled', '', 'Task deactivated'));
    } else {
      openTurns.forEach(t => { if (t.title !== name) { t.title = name; writeRow_('Turns', t); } });
      if (isNew || !wasActive || !openTurns.length) startNextTurn_(activity);
    }
    return getState(token);
  });
}

/** Adds an extra turn for `member` at `position` in the upcoming line (0 = right after the current turn). */
function adminInsertTurn(token, activityId, position, member) {
  return editLine_(token, activityId, activity => {
    validateSlot_(member);
    const at = int_(position, 0, 50, 0);
    const planned = materialize_(activity, at);
    planned.splice(at, 0, EXTRA + normalizeSlot_(member));
    return planned;
  });
}

/** Swaps upcoming entries `position` and `position + direction` (direction -1 or +1). */
function adminMoveTurn(token, activityId, position, direction) {
  return editLine_(token, activityId, activity => {
    const i = int_(position, 0, 50, 0);
    const j = i + (Number(direction) < 0 ? -1 : 1);
    if (j < 0) throw new Error('Already first in line.');
    const planned = materialize_(activity, Math.max(i, j) + 1);
    const tmp = planned[i]; planned[i] = planned[j]; planned[j] = tmp;
    return planned;
  });
}

/** Removes an extra turn from the upcoming line. Regular turns can only be moved. */
function adminRemoveTurn(token, activityId, position) {
  return editLine_(token, activityId, activity => {
    const i = int_(position, 0, 50, 0);
    const planned = list_(activity.planned);
    if (i >= planned.length || planned[i].charAt(0) !== EXTRA) {
      throw new Error('Only extra turns can be removed. Use the arrows to change the order.');
    }
    planned.splice(i, 1);
    return planned;
  });
}

/** Drops every change to the upcoming line: the plain rotation continues from where it was. */
function adminResetOrder(token, activityId) {
  return editLine_(token, activityId, activity => {
    const regular = list_(activity.planned).filter(e => e.charAt(0) !== EXTRA).length;
    const n = list_(activity.rotation).length;
    activity.current_index = (((Number(activity.current_index) || 0) - regular) % n + n) % n;
    return [];
  });
}

function editLine_(token, activityId, change) {
  return withLock_(() => {
    requireAdmin_(auth_(token));
    const activity = readAll_('Activities').find(a => a.id === activityId && a.type !== 'fun');
    if (!activity) throw new Error('Task not found.');
    activity.planned = change(activity).join(',');
    writeRow_('Activities', activity);
    return getState(token);
  });
}

// ---------- Admin: turns, one-time tasks, requests ----------

function adminCreateOneTimeTask(token, input) {
  return withLock_(() => {
    requireAdmin_(auth_(token));
    const title = clean_(input.title, 60);
    if (!title) throw new Error('Task name is required.');
    const assignee = normalizeSlot_(input.assignee);
    validateSlot_(assignee);
    writeRow_('Turns', { id: uid_(), activity_id: '', type: 'task', title: title, assignee: assignee,
                         due_at: dateOf_(input.due_at), status: 'assigned' });
    return getState(token);
  });
}

/** Reassign an open task turn; one-time tasks can also get a new name / due date. */
function adminEditTurn(token, turnId, changes) {
  return withLock_(() => {
    requireAdmin_(auth_(token));
    const turn = openTask_(turnId);
    if (changes.assignee) {
      const slot = normalizeSlot_(changes.assignee);
      validateSlot_(slot);
      if (slot !== turn.assignee) { clearOffer_(turn); turn.replace_request = ''; }
      turn.assignee = slot;
    }
    if (!turn.activity_id) {
      if (changes.title) turn.title = clean_(changes.title, 60);
      if (changes.due_at) turn.due_at = dateOf_(changes.due_at);
    }
    writeRow_('Turns', turn);
    return getState(token);
  });
}

/** Rotating: skip this turn without doing it (next in line). One-time: cancel the task. */
function adminSkipTurn(token, turnId) {
  return withLock_(() => {
    const me = auth_(token);
    requireAdmin_(me);
    const turn = openTask_(turnId);
    closeTurn_(turn, turn.activity_id ? 'excused' : 'cancelled', me.name,
               (turn.activity_id ? 'Skipped by ' : 'Cancelled by ') + me.name);
    return getState(token);
  });
}

/** replacement = a member's name, or '' to decline. The rotation order doesn't change. */
function adminAnswerReplace(token, turnId, replacement) {
  return withLock_(() => {
    requireAdmin_(auth_(token));
    const turn = openTask_(turnId);
    if (turn.replace_request !== 'pending') throw new Error('No pending request on this task.');
    if (!replacement) {
      turn.replace_request = 'declined';
    } else {
      const user = userByName_(replacement);
      if (!user) throw new Error('Pick a family member.');
      turn.assignee = user.name;
      turn.replace_request = 'replaced';
      clearOffer_(turn);
    }
    writeRow_('Turns', turn);
    return getState(token);
  });
}

// ---------- Admin: dates ----------

function adminSaveDate(token, input) {
  return withLock_(() => {
    requireAdmin_(auth_(token));
    const title = clean_(input.title, 80);
    if (!title) throw new Error('Name the date.');
    const members = (Array.isArray(input.members) ? input.members : []).filter(n => userByName_(n));
    if (!members.length) throw new Error('Pick at least one member.');
    let date = input.id ? readAll_('Turns').find(t => t.id === input.id && t.type === 'fun') : null;
    if (!date) date = { id: uid_(), activity_id: '', type: 'fun', status: 'upcoming' };
    date.title = title;
    date.assignee = members.join('+');
    date.due_at = dateOf_(input.due_at);
    date.place = clean_(input.place, 100);
    writeRow_('Turns', date);
    return getState(token);
  });
}

function adminDeleteDate(token, dateId) {
  return withLock_(() => {
    requireAdmin_(auth_(token));
    const date = readAll_('Turns').find(t => t.id === dateId && t.type === 'fun');
    if (!date) throw new Error('Date not found.');
    date.status = 'cancelled';
    writeRow_('Turns', date);
    return getState(token);
  });
}

// ---------- Admin: cards, good words, family ----------

/**
 * Give a yellow card. If the member already has an unused yellow, both become
 * a red card, and red_task_id (required then) gets an extra turn for them
 * right after its current turn.
 */
function adminGiveCard(token, input) {
  return withLock_(() => {
    const me = auth_(token);
    requireAdmin_(me);
    const member = userByName_(input.member);
    if (!member) throw new Error('Pick a family member.');
    const explanation = clean_(input.explanation, 300);
    if (!explanation) throw new Error('Write why the card is given.');
    const activities = readAll_('Activities').filter(a => a.type !== 'fun');
    const related = input.task_id ? activities.find(a => a.id === input.task_id) : null;

    const activeYellows = readAll_('Cards')
      .filter(c => c.member === member.name && c.color === 'yellow' && !bool_(c.used));
    const yellow = {
      id: uid_(), member: member.name, color: 'yellow', explanation: explanation,
      task_id: related ? related.id : '', red_task_id: '', used: false,
      created_at: new Date(), by: me.name,
    };
    if (!activeYellows.length) {
      writeRow_('Cards', yellow);
      return getState(token);
    }

    const redTask = activities.find(a => a.id === input.red_task_id && bool_(a.active));
    if (!redTask) throw new Error('This is the 2nd yellow card: pick the task for the extra turn.');
    yellow.used = true;
    writeRow_('Cards', yellow);
    activeYellows.forEach(c => { c.used = true; writeRow_('Cards', c); });
    writeRow_('Cards', {
      id: uid_(), member: member.name, color: 'red', explanation: explanation,
      task_id: yellow.task_id, red_task_id: redTask.id, used: false,
      created_at: new Date(), by: me.name,
    });
    redTask.planned = [EXTRA + member.name].concat(list_(redTask.planned)).join(',');
    writeRow_('Activities', redTask);
    return getState(token);
  });
}

/** Every GOOD_WORDS_PER_PRIZE-th good word for a member must come with a prize. */
function adminGiveGoodWord(token, input) {
  return withLock_(() => {
    const me = auth_(token);
    requireAdmin_(me);
    const member = userByName_(input.member);
    if (!member) throw new Error('Pick a family member.');
    const explanation = clean_(input.explanation, 300);
    if (!explanation) throw new Error('Write what the good word is for.');
    const count = readAll_('GoodWords').filter(g => g.member === member.name).length + 1;
    const earnsPrize = count % GOOD_WORDS_PER_PRIZE === 0;
    const prize = earnsPrize ? clean_(input.prize, 100) : '';
    if (earnsPrize && !prize) throw new Error(`This is good word #${count}: choose the prize.`);
    writeRow_('GoodWords', {
      id: uid_(), member: member.name, explanation: explanation, prize: prize,
      created_at: new Date(), by: me.name,
    });
    return getState(token);
  });
}

function adminSaveUser(token, input) {
  return withLock_(() => {
    requireAdmin_(auth_(token));
    const all = readAll_('Users');
    let user = input.existing ? all.find(u => u.name === input.existing) : null;
    if (!user) {
      // Names are the key used in rotations, so they are fixed once created.
      const name = clean_(input.name, 30);
      if (!name || /[,+*]/.test(name)) throw new Error('Name is required and cannot contain ",", "+" or "*".');
      if (all.some(u => u.name === name)) throw new Error('That name already exists.');
      user = { token: newToken_(), name: name };
    }
    user.email = clean_(input.email, 100);
    user.phone = intlPhone_(input.phone);
    user.role = input.role === 'admin' ? 'admin' : 'member';
    user.allowance = Math.max(0, Math.min(100000, Number(input.allowance) || 0));
    writeRow_('Users', user);
    usersCache_ = null;
    return getState(token);
  });
}

function adminGetLinks(token) {
  requireAdmin_(auth_(token));
  return users_().map(u => ({ name: u.name, url: personalLink_(u) }));
}

// ============================================================================
// Rotation line
// ============================================================================

/** Next regular slot from the base rotation; advances the pointer. */
function baseNext_(activity) {
  const rotation = list_(activity.rotation);
  if (!rotation.length) throw new Error(`"${activity.name}" has an empty rotation.`);
  const index = (Number(activity.current_index) || 0) % rotation.length;
  activity.current_index = (index + 1) % rotation.length;
  return rotation[index];
}

/** Makes sure the first k upcoming entries are explicit in `planned` (taking them from the rotation). */
function materialize_(activity, k) {
  const planned = list_(activity.planned);
  while (planned.length < k) planned.push(baseNext_(activity));
  activity.planned = planned.join(',');
  return planned;
}

/** The upcoming line without changing anything: [{name, extra}]. */
function upcoming_(activity, count) {
  const out = list_(activity.planned).map(e => ({ name: slotOf_(e), extra: e.charAt(0) === EXTRA }));
  const rotation = list_(activity.rotation);
  let index = Number(activity.current_index) || 0;
  while (out.length < count && rotation.length) {
    out.push({ name: rotation[index++ % rotation.length], extra: false });
  }
  return out.slice(0, Math.max(count, out.length));
}

/** Position of the first upcoming turn that includes `name`, or -1 (looks two rounds ahead). */
function nextTurnIndexOf_(activity, name) {
  const line = upcoming_(activity, list_(activity.planned).length + 2 * list_(activity.rotation).length);
  return line.findIndex(e => members_(e.name).indexOf(name) >= 0);
}

function startNextTurn_(activity) {
  const planned = list_(activity.planned);
  const slot = planned.length ? slotOf_(planned.shift()) : baseNext_(activity);
  activity.planned = planned.join(',');
  writeRow_('Activities', activity);
  const turn = { id: uid_(), activity_id: activity.id, type: 'task', title: activity.name,
                 assignee: slot, due_at: '', status: 'assigned' };
  writeRow_('Turns', turn);
  return turn;
}

function closeTurn_(turn, status, byName, note) {
  turn.status = status;
  turn.completed_at = new Date();
  turn.completed_by = byName;
  if (note) turn.note = note;
  clearOffer_(turn);
  if (turn.replace_request === 'pending') turn.replace_request = '';
  writeRow_('Turns', turn);
  if (turn.activity_id && status !== 'cancelled') {
    const activity = activityOf_(turn);
    if (activity && bool_(activity.active)) startNextTurn_(activity);
  }
}

function activityOf_(turn) {
  return turn.activity_id ? readAll_('Activities').find(a => a.id === turn.activity_id) || null : null;
}

function clearOffer_(turn) {
  turn.offer_to = '';
  turn.offer_kind = '';
  turn.offer_by = '';
}

function isOpen_(turn) { return OPEN_STATUSES.indexOf(turn.status) >= 0; }

function openTask_(turnId) {
  const turn = readAll_('Turns').find(t => t.id === turnId);
  if (!turn || turn.type !== 'task' || !isOpen_(turn)) throw new Error('Task not found or already done.');
  return turn;
}

function requireParticipant_(user, turn) {
  if (members_(turn.assignee).indexOf(user.name) < 0 && !isAdmin_(user)) {
    throw new Error('Only the assigned member or an admin can do this.');
  }
}

function dateOf_(ms) {
  const d = new Date(Number(ms));
  if (isNaN(d.getTime())) throw new Error('Pick a date and time.');
  return d;
}

// ---------- Slots ("Noa" or "Dad+Noa") ----------

function members_(slot) { return String(slot || '').split('+').map(x => x.trim()).filter(Boolean); }
function normalizeSlot_(slot) { return members_(slot).join('+'); }
function slotOf_(entry) { return String(entry).replace(/^\*/, ''); }
function replaceMember_(slot, from, to) { return members_(slot).map(n => n === from ? to : n).join('+'); }

function validateSlot_(slot) {
  const names = users_().map(u => u.name);
  const unknown = members_(slot).filter(n => names.indexOf(n) < 0);
  if (!members_(slot).length) throw new Error('Pick at least one family member.');
  if (unknown.length) throw new Error('Unknown names: ' + unknown.join(', '));
}

// ============================================================================
// Sheet + misc helpers
// ============================================================================

let usersCache_ = null;
let spreadsheetCache_ = null;

/**
 * Opened by id rather than used through getActive(): in the editor, getActive()
 * can carry a stale "active sheet" that makes every call fail with
 * "Sheet <id> not found".
 */
function spreadsheet_() {
  return spreadsheetCache_ || (spreadsheetCache_ = SpreadsheetApp.openById(SpreadsheetApp.getActive().getId()));
}

function sheet_(name) { return spreadsheet_().getSheetByName(name); }

function readAll_(name) {
  const values = sheet_(name).getDataRange().getValues();
  const header = values.shift() || [];
  return values
    .map((row, i) => {
      const obj = { _row: i + 2 };
      header.forEach((key, j) => { obj[key] = row[j]; });
      return obj;
    })
    .filter(obj => obj[header[0]] !== '');
}

function writeRow_(name, obj) {
  const sh = sheet_(name);
  const header = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  const row = header.map(key => cell_(obj[key]));
  if (obj._row) {
    sh.getRange(obj._row, 1, 1, row.length).setValues([row]);
  } else {
    sh.appendRow(row);
    obj._row = sh.getLastRow();
  }
}

/** Stops user text like "=IMPORTXML(...)" from being stored as a formula. */
function cell_(value) {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string' && /^[=+\-@]/.test(value)) return "'" + value;
  return value;
}

function users_() { return usersCache_ || (usersCache_ = readAll_('Users')); }
function userByName_(name) { return users_().find(u => u.name === name) || null; }

function auth_(token) {
  const user = token ? users_().find(u => u.token === token) : null;
  if (!user) throw new Error('Unknown link. Ask an admin for your personal link.');
  return user;
}

function isAdmin_(user) { return String(user.role).toLowerCase() === 'admin'; }
function requireAdmin_(user) { if (!isAdmin_(user)) throw new Error('Admins only.'); }

function withLock_(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try { return fn(); } finally { lock.releaseLock(); }
}

function turnView_(t) {
  return {
    id: t.id, activity_id: t.activity_id, type: t.type, title: t.title,
    rotating: t.type === 'task' && !!t.activity_id,
    assignee: t.assignee, members: members_(t.assignee), due_at: ms_(t.due_at),
    place: String(t.place || ''), status: t.status,
    completed_at: ms_(t.completed_at), completed_by: t.completed_by, note: String(t.note || ''),
    offer_to: t.offer_to || '', offer_kind: t.offer_kind || '', offer_by: t.offer_by || '',
    replace_request: t.replace_request || '', replace_reason: String(t.replace_reason || ''),
  };
}

/** The token goes in the #fragment, which browsers never send to GitHub's servers. */
function personalLink_(user) { return `${APP_URL}#u=${user.token}`; }

/**
 * "054-123 4567" / "972541234567" → "+972541234567". Stored with a leading
 * "+" so Sheets keeps it as text (a bare 054… would lose its leading 0).
 */
function intlPhone_(raw) {
  let digits = String(raw || '').replace(/\D/g, '').slice(0, 15);
  if (!digits) return '';
  if (digits.charAt(0) === '0') digits = '972' + digits.slice(1);
  return '+' + digits;
}

function bool_(v) { return v === true || String(v).toUpperCase() === 'TRUE'; }
function list_(s) { return String(s || '').split(',').map(x => x.trim()).filter(Boolean); }
function clean_(s, max) { return String(s || '').trim().slice(0, max); }
function ms_(d) { return d instanceof Date ? d.getTime() : null; }
function uid_() { return Utilities.getUuid().slice(0, 8); }
function newToken_() { return Utilities.getUuid().replace(/-/g, ''); }

function int_(v, min, max, fallback) {
  const n = parseInt(v, 10);
  return isNaN(n) ? fallback : Math.min(max, Math.max(min, n));
}
