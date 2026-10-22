/**
 * Family Hub — Google Apps Script backend, bound to a Google Sheet.
 *
 * Two kinds of activity, both with a rotation of family members:
 *   task — chores. An admin assigns the next person in the queue with a due
 *          time. The member presses Start, then Done. Late → yellow card and a
 *          2-hour grace; still not done → red card and an extra turn.
 *   fun  — recurring events (e.g. a 1-on-1 date). Each turn is a coming event
 *          with a time and place; after it passes, the next slot gets the next
 *          event, "repeat every" days later.
 *
 * A rotation slot is a single name ("Noa") or a group joined with "+" ("Dad+Noa").
 *
 * Sheets (created by setup()):
 *   Users      — family members, personal link token, role, notification prefs
 *   Activities — tasks and fun activities with their rotation state
 *   Turns      — every assignment / event and its outcome
 *   Board      — shared notes everyone can post
 *
 * Access model: this script is only the backend (a JSON API). The screens are
 * a static page on GitHub Pages (APP_URL) that POSTs to this web app. Each
 * member opens a personal link (APP_URL#u=<token>); the token identifies them,
 * so kids do not need a Google account. Treat each link like a password.
 */

const APP_NAME = 'Family Hub';
// Where the screens are hosted. Personal links in emails point here.
const APP_URL = 'https://roycaspi77.github.io/family-hub/';
const TZ = Session.getScriptTimeZone();

const GRACE_HOURS = 2;       // after the due time, between yellow and red card
const REMINDER_HOURS = 2;    // task reminder before the due time
const FUN_EVENT_HOURS = 2;   // fun events count as over this long after they start

const OPEN_STATUSES = ['assigned', 'in_progress', 'upcoming'];

const HEADERS = {
  Users: ['token', 'name', 'email', 'phone', 'role', 'whatsapp_apikey',
          'notify_email', 'notify_calendar', 'notify_whatsapp'],
  Activities: ['id', 'type', 'name', 'rotation', 'current_index', 'penalty_queue',
               'frequency_days', 'next_due', 'place', 'active'],
  Turns: ['id', 'activity_id', 'type', 'title', 'assignee', 'due_at', 'place',
          'status', 'card', 'yellow_at', 'started_at', 'completed_at',
          'completed_by', 'extra_request', 'extra_requested_at', 'extra_reason',
          'reminder_sent', 'calendar_event_id', 'note'],
  Board: ['id', 'created_at', 'author', 'text'],
};

// ============================================================================
// Setup (run once from the Apps Script editor)
// ============================================================================

function setup() {
  const ss = SpreadsheetApp.getActive();
  Object.keys(HEADERS).forEach(name => {
    const sh = ss.getSheetByName(name) || ss.insertSheet(name);
    if (sh.getLastRow() === 0) {
      sh.appendRow(HEADERS[name]);
      sh.setFrozenRows(1);
    }
  });

  const props = PropertiesService.getScriptProperties();
  if (!props.getProperty('CALENDAR_ID')) {
    const cal = CalendarApp.createCalendar(APP_NAME, { timeZone: TZ });
    props.setProperty('CALENDAR_ID', cal.getId());
  }

  if (readAll_('Users').length === 0) {
    writeRow_('Users', {
      token: newToken_(), name: 'Admin',
      email: Session.getEffectiveUser().getEmail(), role: 'admin',
      notify_email: true, notify_calendar: true, notify_whatsapp: false,
    });
  }

  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'tick')
    .forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('tick').timeBased().everyMinutes(15).create();

  Logger.log('Setup done. Next: Deploy > New deployment > Web app, then run printLinks().');
}

/** Logs every member's personal link. */
function printLinks() {
  readAll_('Users').forEach(u => Logger.log(`${u.name}: ${personalLink_(u)}`));
}

// ============================================================================
// Web app entry (JSON API) + client API
// ============================================================================

// Only these functions can be called from the page; every one takes the
// caller's token as its first argument.
const API = {
  getState, startTurn, completeTurn, requestExtraTime, postNote, deleteNote,
  adminSaveActivity, adminAssignTask, adminEditTurn, adminAnswerExtraTime,
  adminExcuseTurn, adminSaveUser, adminGetLinks, adminRunCheck,
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
  const activities = readAll_('Activities').filter(a => admin || bool_(a.active));

  return {
    me: { name: me.name, role: me.role, isAdmin: admin },
    config: { graceHours: GRACE_HOURS },
    users: users_().map(u => admin ? {
      name: u.name, role: u.role, email: u.email, phone: String(u.phone || ''),
      notify_email: bool_(u.notify_email), notify_calendar: bool_(u.notify_calendar),
      notify_whatsapp: bool_(u.notify_whatsapp), has_whatsapp_key: !!u.whatsapp_apikey,
    } : { name: u.name, role: u.role }),
    activities: activities.map(a => ({
      id: a.id, type: a.type, name: a.name, active: bool_(a.active),
      rotation: list_(a.rotation).join(', '),
      frequency_days: Number(a.frequency_days) || 0,
      open: open.filter(t => t.activity_id === a.id).map(turnView_),
      upcoming: upcoming_(a, 5),
    })),
    cards: users_().map(u => {
      const mine = turns.filter(t => members_(t.assignee).indexOf(u.name) >= 0);
      return { name: u.name,
               yellow: mine.filter(t => t.card === 'yellow').length,
               red: mine.filter(t => t.card === 'red').length };
    }),
    open: open.map(turnView_),
    history: turns.filter(t => !isOpen_(t))
      .sort((a, b) => (ms_(b.completed_at) || ms_(b.due_at)) - (ms_(a.completed_at) || ms_(a.due_at)))
      .slice(0, 60).map(turnView_),
    board: readAll_('Board').slice(-40).reverse().map(n => ({
      id: n.id, author: n.author, text: String(n.text), created_at: ms_(n.created_at),
    })),
  };
}

/** Task button, step 1: the member begins working on it. */
function startTurn(token, turnId) {
  return withLock_(() => {
    const me = auth_(token);
    const turn = openTask_(turnId);
    requireParticipant_(me, turn);
    if (turn.status !== 'assigned') throw new Error('This task was already started.');
    turn.status = 'in_progress';
    turn.started_at = new Date();
    writeRow_('Turns', turn);
    return getState(token);
  });
}

/** Task button, step 2: finished. */
function completeTurn(token, turnId, note) {
  return withLock_(() => {
    const me = auth_(token);
    const turn = openTask_(turnId);
    requireParticipant_(me, turn);
    if (turn.status !== 'in_progress') throw new Error('Press Start first.');
    closeTurn_(turn, 'done', me.name, clean_(note, 300));
    return getState(token);
  });
}

function requestExtraTime(token, turnId, reason) {
  return withLock_(() => {
    const me = auth_(token);
    const turn = openTask_(turnId);
    if (members_(turn.assignee).indexOf(me.name) < 0) {
      throw new Error('Only the assigned member can ask for extra time.');
    }
    if (turn.extra_request === 'pending') throw new Error('A request is already waiting for an answer.');
    turn.extra_request = 'pending';
    turn.extra_requested_at = new Date();
    turn.extra_reason = clean_(reason, 200);
    writeRow_('Turns', turn);
    notifyAdmins_(`⏳ Extra time request: ${turn.title}`,
                  `${me.name} is asking for more time on "${turn.title}" (due ${fmt_(turn.due_at)}).`
                  + (turn.extra_reason ? `\nReason: ${turn.extra_reason}` : '')
                  + '\n\nAnswer it in the Admin tab.', []);
    return getState(token);
  });
}

function postNote(token, text) {
  return withLock_(() => {
    const me = auth_(token);
    const body = clean_(text, 500);
    if (!body) throw new Error('Note is empty.');
    writeRow_('Board', { id: uid_(), created_at: new Date(), author: me.name, text: body });
    return getState(token);
  });
}

function deleteNote(token, noteId) {
  return withLock_(() => {
    const me = auth_(token);
    const note = readAll_('Board').find(n => n.id === noteId);
    if (!note) throw new Error('Note not found.');
    if (note.author !== me.name && !isAdmin_(me)) throw new Error('You can only delete your own notes.');
    sheet_('Board').deleteRow(note._row);
    return getState(token);
  });
}

// ---------- Admin API ----------

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
    if (isNew) {
      if (input.type !== 'task' && input.type !== 'fun') throw new Error('Unknown activity type.');
      activity = { id: uid_(), type: input.type, current_index: 0, penalty_queue: '' };
      if (activity.type === 'fun') {
        if (!input.first_at) throw new Error('Set the time of the first event.');
        activity.next_due = new Date(Number(input.first_at));
        activity.place = clean_(input.place, 100);
      }
    }
    const wasActive = !isNew && bool_(activity.active);
    activity.name = name;
    activity.rotation = rotation.join(',');
    activity.current_index = (Number(activity.current_index) || 0) % rotation.length;
    if (activity.type === 'fun') activity.frequency_days = int_(input.frequency_days, 1, 365, 7);
    activity.active = input.active !== false;
    writeRow_('Activities', activity);

    if (!activity.active) {
      readAll_('Turns')
        .filter(t => t.activity_id === activity.id && isOpen_(t))
        .forEach(t => closeTurn_(t, 'cancelled', '', 'Activity deactivated'));
    } else if (activity.type === 'fun' && (isNew || !wasActive)) {
      startFunTurn_(activity);
    }
    return getState(token);
  });
}

/** Assign a task to the next slot in the queue. */
function adminAssignTask(token, activityId, dueMs) {
  return withLock_(() => {
    requireAdmin_(auth_(token));
    const activity = readAll_('Activities').find(a => a.id === activityId);
    if (!activity || activity.type !== 'task' || !bool_(activity.active)) throw new Error('Task not found.');
    const due = new Date(Number(dueMs));
    if (isNaN(due.getTime()) || due.getTime() <= Date.now()) throw new Error('The due time must be in the future.');

    const assignee = consumeAssignee_(activity);
    writeRow_('Activities', activity);
    const turn = {
      id: uid_(), activity_id: activity.id, type: 'task', title: activity.name,
      assignee: assignee, due_at: due, status: 'assigned', card: '',
      extra_request: '', reminder_sent: false,
    };
    turn.calendar_event_id = addCalendar_(turn);
    writeRow_('Turns', turn);
    notify_(assignee, `🧹 New task: ${turn.title}`,
            `${display_(assignee)}: you've been assigned "${turn.title}". Due: ${fmt_(due)}.\n`
            + 'Press Start when you begin and Done when you finish.');
    return getState(token);
  });
}

/** Change who / when (and, for fun events, where) of an open turn. */
function adminEditTurn(token, turnId, changes) {
  return withLock_(() => {
    requireAdmin_(auth_(token));
    const turn = readAll_('Turns').find(t => t.id === turnId);
    if (!turn || !isOpen_(turn)) throw new Error('Not found or already closed.');
    if (changes.assignee) {
      const slot = normalizeSlot_(changes.assignee);
      validateSlot_(slot);
      turn.assignee = slot;
    }
    if (changes.due_at) {
      const due = new Date(Number(changes.due_at));
      if (isNaN(due.getTime())) throw new Error('Invalid date.');
      turn.due_at = due;
      turn.reminder_sent = false;
    }
    if (turn.type === 'fun' && changes.place !== undefined) turn.place = clean_(changes.place, 100);
    refreshCalendar_(turn);
    writeRow_('Turns', turn);

    if (turn.type === 'fun') {
      notify_(turn.assignee, `📅 Updated: ${turn.title}`,
              `${display_(turn.assignee)}: "${turn.title}" is now on ${fmt_(turn.due_at)}`
              + (turn.place ? ` at ${turn.place}` : '') + '.');
    } else {
      notify_(turn.assignee, `📝 Task updated: ${turn.title}`,
              `${display_(turn.assignee)}: "${turn.title}" is due ${fmt_(turn.due_at)}.`);
    }
    return getState(token);
  });
}

/** hours = 0 refuses the request; hours > 0 extends the due time. */
function adminAnswerExtraTime(token, turnId, hours) {
  return withLock_(() => {
    requireAdmin_(auth_(token));
    const turn = openTask_(turnId);
    if (turn.extra_request !== 'pending') throw new Error('No pending request on this task.');
    const add = int_(hours, 0, 72, 0);

    if (add === 0) {
      turn.extra_request = 'refused';
      writeRow_('Turns', turn);
      notify_(turn.assignee, `⏳ Extra time refused: ${turn.title}`,
              `${display_(turn.assignee)}: no extra time for "${turn.title}". It is still due ${fmt_(turn.due_at)}.`);
    } else {
      // Extend from the due time, or from now if that has already passed.
      const base = Math.max(new Date(turn.due_at).getTime(), Date.now());
      // A yellow card given while the request was still waiting is withdrawn.
      if (turn.card === 'yellow' && turn.yellow_at instanceof Date &&
          turn.extra_requested_at instanceof Date && turn.extra_requested_at < turn.yellow_at) {
        turn.card = '';
        turn.yellow_at = '';
      }
      turn.due_at = new Date(base + hours_(add));
      turn.extra_request = 'granted';
      turn.reminder_sent = false;
      refreshCalendar_(turn);
      writeRow_('Turns', turn);
      notify_(turn.assignee, `⏳ Extra time granted: ${turn.title}`,
              `${display_(turn.assignee)}: you got ${add} more hour${add > 1 ? 's' : ''}. "${turn.title}" is now due ${fmt_(turn.due_at)}.`);
    }
    return getState(token);
  });
}

/** Task: close without a card. Fun: cancel this event and move to the next slot. */
function adminExcuseTurn(token, turnId) {
  return withLock_(() => {
    const me = auth_(token);
    requireAdmin_(me);
    const turn = readAll_('Turns').find(t => t.id === turnId);
    if (!turn || !isOpen_(turn)) throw new Error('Not found or already closed.');
    closeTurn_(turn, turn.type === 'fun' ? 'cancelled' : 'excused', me.name,
               (turn.type === 'fun' ? 'Cancelled by ' : 'Excused by ') + me.name);
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
      if (!name || /[,+]/.test(name)) throw new Error('Name is required and cannot contain "," or "+".');
      if (all.some(u => u.name === name)) throw new Error('That name already exists.');
      user = { token: newToken_(), name: name };
    }
    user.email = clean_(input.email, 100);
    user.phone = clean_(input.phone, 20).replace(/[^\d+]/g, '');
    user.role = input.role === 'admin' ? 'admin' : 'member';
    user.notify_email = !!input.notify_email;
    user.notify_calendar = !!input.notify_calendar;
    user.notify_whatsapp = !!input.notify_whatsapp;
    if (input.whatsapp_apikey) user.whatsapp_apikey = clean_(input.whatsapp_apikey, 40);
    writeRow_('Users', user);
    usersCache_ = null;
    return getState(token);
  });
}

function adminGetLinks(token) {
  requireAdmin_(auth_(token));
  return users_().map(u => ({ name: u.name, url: personalLink_(u) }));
}

function adminRunCheck(token) {
  requireAdmin_(auth_(token));
  tick();
  return getState(token);
}

// ============================================================================
// Scheduler (time-driven trigger every 15 minutes)
// ============================================================================

function tick() {
  withLock_(() => {
    const now = Date.now();
    const activities = readAll_('Activities');
    const open = readAll_('Turns').filter(isOpen_);

    open.forEach(turn => {
      if (turn.type === 'fun') {
        if (now > new Date(turn.due_at).getTime() + hours_(FUN_EVENT_HOURS)) {
          closeTurn_(turn, 'done', '', '');
        }
      } else {
        checkTaskDeadline_(turn, activities.find(a => a.id === turn.activity_id), now);
      }
    });

    // A fun activity always has one coming event.
    activities
      .filter(a => a.type === 'fun' && bool_(a.active) && !open.some(t => t.activity_id === a.id))
      .forEach(startFunTurn_);
  });
}

function checkTaskDeadline_(turn, activity, now) {
  const due = new Date(turn.due_at).getTime();
  const redAt = due + hours_(GRACE_HOURS);
  const who = display_(turn.assignee);

  // Guests on the family calendar don't get the event's own popup reminder,
  // so the 2-hour reminder is also sent as a message.
  if (!bool_(turn.reminder_sent) && now >= due - hours_(REMINDER_HOURS) && now < due) {
    turn.reminder_sent = true;
    writeRow_('Turns', turn);
    notify_(turn.assignee, `🔔 Reminder: ${turn.title}`,
            `${who}: "${turn.title}" is due ${fmt_(turn.due_at)}.`);
  }

  if (!turn.card && now > due) {
    turn.card = 'yellow';
    turn.yellow_at = new Date();
    writeRow_('Turns', turn);
    markCalendar_(turn, '🟨 ');
    notifyWithAdmins_(turn, `🟨 Yellow card: ${turn.title} (${who})`,
                      `${who} did not finish "${turn.title}" by ${fmt_(turn.due_at)}.\n`
                      + `Grace: ${GRACE_HOURS} more hours, until ${fmt_(redAt)}. After that it's a red card and an extra turn.`);
  }

  if (turn.card === 'yellow' && now > redAt) {
    turn.card = 'red';
    turn.status = 'missed';
    turn.completed_at = new Date();
    writeRow_('Turns', turn);
    markCalendar_(turn, '🟥 ');
    if (activity) {
      activity.penalty_queue = [turn.assignee].concat(list_(activity.penalty_queue)).join(',');
      writeRow_('Activities', activity);
    }
    notifyWithAdmins_(turn, `🟥 Red card: ${turn.title} (${who})`,
                      `${who} did not finish "${turn.title}" by the end of the grace period (${fmt_(redAt)}).\n`
                      + `${who} gets an extra turn in the next rotation.`);
  }
}

// ============================================================================
// Rotation logic
// ============================================================================

/** Penalty turns jump the queue; otherwise walk the rotation in order. */
function consumeAssignee_(activity) {
  const queue = list_(activity.penalty_queue);
  if (queue.length) {
    const slot = queue.shift();
    activity.penalty_queue = queue.join(',');
    return slot;
  }
  const rotation = list_(activity.rotation);
  if (!rotation.length) throw new Error(`"${activity.name}" has an empty rotation.`);
  const index = (Number(activity.current_index) || 0) % rotation.length;
  activity.current_index = (index + 1) % rotation.length;
  return rotation[index];
}

function upcoming_(activity, count) {
  const queue = list_(activity.penalty_queue);
  const rotation = list_(activity.rotation);
  let index = Number(activity.current_index) || 0;
  const out = [];
  while (out.length < count && (queue.length || rotation.length)) {
    if (queue.length) out.push({ name: queue.shift(), penalty: true });
    else out.push({ name: rotation[index++ % rotation.length], penalty: false });
  }
  return out;
}

function startFunTurn_(activity) {
  if (!(activity.next_due instanceof Date) || !list_(activity.rotation).length) return null;
  const freq = Math.max(1, Number(activity.frequency_days) || 7);
  let due = activity.next_due;
  // After a pause, jump to the first future slot instead of creating past events.
  while (due.getTime() + hours_(FUN_EVENT_HOURS) < Date.now()) due = addDays_(due, freq);

  const assignee = consumeAssignee_(activity);
  activity.next_due = addDays_(due, freq);
  writeRow_('Activities', activity);

  const turn = {
    id: uid_(), activity_id: activity.id, type: 'fun', title: activity.name,
    assignee: assignee, due_at: due, place: activity.place || '', status: 'upcoming',
  };
  turn.calendar_event_id = addCalendar_(turn);
  writeRow_('Turns', turn);
  notify_(assignee, `🎉 Coming up: ${turn.title}`,
          `${display_(assignee)}: "${turn.title}" — ${fmt_(due)}` + (turn.place ? ` at ${turn.place}` : '') + '.');
  return turn;
}

function closeTurn_(turn, status, byName, note) {
  turn.status = status;
  turn.completed_at = new Date();
  turn.completed_by = byName;
  if (note) turn.note = note;
  writeRow_('Turns', turn);
  markCalendar_(turn, { done: '✅ ', excused: '➖ ', cancelled: '🚫 ' }[status] || '');

  // The next fun event follows the one that just ended (or was cancelled).
  if (turn.type === 'fun') {
    const activity = readAll_('Activities').find(a => a.id === turn.activity_id);
    if (activity && bool_(activity.active)) {
      activity.next_due = addDays_(new Date(turn.due_at), Math.max(1, Number(activity.frequency_days) || 7));
      activity.place = turn.place || activity.place || '';
      startFunTurn_(activity);
    }
  }
}

function isOpen_(turn) { return OPEN_STATUSES.indexOf(turn.status) >= 0; }

function openTask_(turnId) {
  const turn = readAll_('Turns').find(t => t.id === turnId);
  if (!turn || turn.type !== 'task' || !isOpen_(turn)) throw new Error('Task not found or already closed.');
  return turn;
}

function requireParticipant_(user, turn) {
  if (members_(turn.assignee).indexOf(user.name) < 0 && !isAdmin_(user)) {
    throw new Error('Only the assigned member or an admin can do this.');
  }
}

// ---------- Rotation slots ("Noa" or "Dad+Noa") ----------

function members_(slot) { return String(slot || '').split('+').map(x => x.trim()).filter(Boolean); }
function normalizeSlot_(slot) { return members_(slot).join('+'); }
function display_(slot) { return members_(slot).join(' & '); }

function validateSlot_(slot) {
  const names = users_().map(u => u.name);
  const unknown = members_(slot).filter(n => names.indexOf(n) < 0);
  if (!members_(slot).length) throw new Error('Empty rotation slot.');
  if (unknown.length) throw new Error('Unknown names: ' + unknown.join(', '));
}

// ============================================================================
// Notifications: email, WhatsApp (CallMeBot), Google Calendar
// ============================================================================

/** Notifies every person in a slot ("Dad+Noa" notifies both). */
function notify_(slot, subject, body) {
  members_(slot).forEach(name => notifyUser_(name, subject, body));
}

/** The assigned member(s) plus every admin, each only once. */
function notifyWithAdmins_(turn, subject, body) {
  const names = members_(turn.assignee);
  users_().filter(isAdmin_).forEach(u => { if (names.indexOf(u.name) < 0) names.push(u.name); });
  names.forEach(name => notifyUser_(name, subject, body));
}

function notifyAdmins_(subject, body, exceptNames) {
  users_().filter(u => isAdmin_(u) && exceptNames.indexOf(u.name) < 0)
    .forEach(u => notifyUser_(u.name, subject, body));
}

function notifyUser_(name, subject, body) {
  const user = userByName_(name);
  if (!user) return;

  if (bool_(user.notify_email) && user.email) {
    const link = `\n\nOpen the app: ${personalLink_(user)}`;
    try { MailApp.sendEmail(user.email, subject, body + link); }
    catch (e) { console.warn('email failed', e); }
  }

  // The personal link is deliberately left out of WhatsApp: it would pass
  // through CallMeBot's servers.
  if (bool_(user.notify_whatsapp) && user.phone && user.whatsapp_apikey) {
    const url = 'https://api.callmebot.com/whatsapp.php'
      + '?phone=' + encodeURIComponent(user.phone)
      + '&text=' + encodeURIComponent(subject + '\n' + body)
      + '&apikey=' + encodeURIComponent(user.whatsapp_apikey);
    try { UrlFetchApp.fetch(url, { muteHttpExceptions: true }); }
    catch (e) { console.warn('whatsapp failed', e); }
  }
}

function calendar_() {
  const id = PropertiesService.getScriptProperties().getProperty('CALENDAR_ID');
  return id ? CalendarApp.getCalendarById(id) : null;
}

function calendarTitle_(turn) { return `${display_(turn.assignee)}: ${turn.title}`; }

function addCalendar_(turn) {
  try {
    const cal = calendar_();
    if (!cal) return '';
    const guests = members_(turn.assignee).map(userByName_)
      .filter(u => u && bool_(u.notify_calendar) && u.email).map(u => u.email);
    const start = new Date(turn.due_at);
    const minutes = turn.type === 'fun' ? FUN_EVENT_HOURS * 60 : 30;
    const options = {
      description: turn.type === 'fun' ? 'Family Hub' : 'Press Start and Done in the Family Hub app.',
    };
    if (turn.place) options.location = turn.place;
    if (guests.length) {
      options.guests = guests.join(',');
      options.sendInvites = true;
    }
    const event = cal.createEvent(calendarTitle_(turn), start,
                                  new Date(start.getTime() + minutes * 60000), options);
    event.addPopupReminder(REMINDER_HOURS * 60);
    return event.getId();
  } catch (e) {
    console.warn('calendar failed', e);
    return '';
  }
}

/** Recreate the event so time, place and guests all update (guests get a new invite). */
function refreshCalendar_(turn) {
  try {
    const event = turn.calendar_event_id && calendar_().getEventById(turn.calendar_event_id);
    if (event) event.deleteEvent();
  } catch (e) { console.warn('calendar delete failed', e); }
  turn.calendar_event_id = addCalendar_(turn);
}

function markCalendar_(turn, prefix) {
  try {
    const event = turn.calendar_event_id && calendar_().getEventById(turn.calendar_event_id);
    if (event) event.setTitle(prefix + calendarTitle_(turn));
  } catch (e) { console.warn('calendar update failed', e); }
}

// ============================================================================
// Sheet + misc helpers
// ============================================================================

let usersCache_ = null;

function sheet_(name) { return SpreadsheetApp.getActive().getSheetByName(name); }

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
    assignee: t.assignee, members: members_(t.assignee), due_at: ms_(t.due_at),
    place: String(t.place || ''), status: t.status, card: t.card || '',
    started_at: ms_(t.started_at), completed_at: ms_(t.completed_at),
    completed_by: t.completed_by, extra_request: t.extra_request || '',
    extra_reason: String(t.extra_reason || ''), note: String(t.note || ''),
  };
}

/** The token goes in the #fragment, which browsers never send to GitHub's servers. */
function personalLink_(user) { return `${APP_URL}#u=${user.token}`; }

function bool_(v) { return v === true || String(v).toUpperCase() === 'TRUE'; }
function list_(s) { return String(s || '').split(',').map(x => x.trim()).filter(Boolean); }
function clean_(s, max) { return String(s || '').trim().slice(0, max); }
function ms_(d) { return d instanceof Date ? d.getTime() : null; }
function hours_(h) { return (Number(h) || 0) * 3600000; }
function uid_() { return Utilities.getUuid().slice(0, 8); }
function newToken_() { return Utilities.getUuid().replace(/-/g, ''); }
function fmt_(d) { return Utilities.formatDate(new Date(d), TZ, 'EEE dd/MM HH:mm'); }

function int_(v, min, max, fallback) {
  const n = parseInt(v, 10);
  return isNaN(n) ? fallback : Math.min(max, Math.max(min, n));
}

/** Calendar-day arithmetic (keeps the same clock time across DST changes). */
function addDays_(d, days) {
  const x = new Date(d.getTime());
  x.setDate(x.getDate() + days);
  return x;
}
