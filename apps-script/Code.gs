/**
 * Family Hub — Google Apps Script backend, bound to a Google Sheet.
 *
 * Activities rotate between family members:
 *   task — chores. An admin assigns the next person in the queue with a due
 *          time (or creates a one-time task). The member presses Start, then
 *          Done. Each task has its own reminder rules. Members can pass a turn
 *          to someone else, or switch (you do mine now, I do your next one).
 *   fun  — recurring events (e.g. a 1-on-1 date). Each turn is a coming event
 *          with a time and place; after it passes, the next slot gets the next
 *          event, "repeat every" days later.
 *
 * Admins also give yellow cards (the 2nd unused yellow becomes a red card,
 * which gives the member an extra turn in a task the admin picks) and good
 * words (every 3rd one comes with a prize). Each member has a monthly
 * allowance, paid on the 1st.
 *
 * A rotation slot is a single name ("Noa") or a group joined with "+" ("Dad+Noa").
 *
 * Notifications go by email, Google Calendar invites, and push notifications
 * to the installed app (Firebase Cloud Messaging). Push needs the script
 * property FIREBASE_SERVICE_ACCOUNT (the service-account JSON from Firebase).
 *
 * Sheets (created / upgraded by setup()):
 *   Users      — family members, personal link token, role, notification prefs, allowance, push devices
 *   Activities — tasks and fun activities with their rotation state
 *   Turns      — every assignment / event and its outcome
 *   Cards      — yellow and red cards
 *   GoodWords  — good words and prizes
 *   Board      — notes from older versions (no longer shown)
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

const FUN_EVENT_HOURS = 2;   // fun events count as over this long after they start
const GOOD_WORDS_PER_PRIZE = 3;
const DEFAULT_RULES = [{ kind: 'before', minutes: 120 }];
const MAX_RULES = 5;

const OPEN_STATUSES = ['assigned', 'in_progress', 'upcoming'];

const HEADERS = {
  Users: ['token', 'name', 'email', 'role', 'notify_email', 'notify_calendar',
          'allowance', 'notify_push', 'push_tokens'],
  Activities: ['id', 'type', 'name', 'rotation', 'current_index', 'penalty_queue',
               'frequency_days', 'next_due', 'place', 'active', 'notify_rules',
               'swap_queue'],
  Turns: ['id', 'activity_id', 'type', 'title', 'assignee', 'due_at', 'place',
          'status', 'card', 'yellow_at', 'started_at', 'completed_at',
          'completed_by', 'extra_request', 'extra_requested_at', 'extra_reason',
          'reminder_sent', 'calendar_event_id', 'note', 'notify_rules',
          'reminders_sent', 'overdue_sent', 'offer_to', 'offer_kind', 'offer_by'],
  Cards: ['id', 'member', 'color', 'explanation', 'task_id', 'red_task_id',
          'used', 'created_at', 'by'],
  GoodWords: ['id', 'member', 'explanation', 'prize', 'created_at', 'by'],
  Board: ['id', 'created_at', 'author', 'text'],
};

// ============================================================================
// Setup / upgrade (run from the Apps Script editor; safe to run again)
// ============================================================================

function setup() {
  const ss = SpreadsheetApp.getActive();
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

  const props = PropertiesService.getScriptProperties();
  if (!props.getProperty('CALENDAR_ID')) {
    const cal = CalendarApp.createCalendar(APP_NAME, { timeZone: TZ });
    props.setProperty('CALENDAR_ID', cal.getId());
  }

  if (readAll_('Users').length === 0) {
    writeRow_('Users', {
      token: newToken_(), name: 'Admin',
      email: Session.getEffectiveUser().getEmail(), role: 'admin',
      notify_email: true, notify_calendar: true, notify_push: true, allowance: 0,
    });
  }

  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'tick')
    .forEach(t => ScriptApp.deleteTrigger(t));
  // Every 5 minutes so a "30 minutes before" reminder goes out on time.
  ScriptApp.newTrigger('tick').timeBased().everyMinutes(5).create();

  Logger.log('Setup done. Next: Deploy > Manage deployments > Edit > New version.');
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
  getState, startTurn, completeTurn, requestExtraTime, offerTurn, answerOffer,
  registerPush, unregisterPush, testPush,
  adminSaveActivity, adminAssignTask, adminCreateOneTimeTask, adminEditTurn,
  adminAnswerExtraTime, adminExcuseTurn, adminGiveCard, adminGiveGoodWord,
  adminSaveUser, adminGetLinks, adminRunCheck,
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
  const allActivities = readAll_('Activities');
  const activityName = id => {
    const a = allActivities.find(x => x.id === id);
    return a ? a.name : '';
  };
  const cards = readAll_('Cards');
  const goodWords = readAll_('GoodWords');

  return {
    me: { name: me.name, role: me.role, isAdmin: admin,
          pushDevices: list_(me.push_tokens).length, pushReady: !!pushAccount_() },
    users: users_().map(u => admin ? {
      name: u.name, role: u.role, email: u.email,
      notify_email: bool_(u.notify_email), notify_calendar: bool_(u.notify_calendar),
      notify_push: bool_(u.notify_push), push_devices: list_(u.push_tokens).length,
      allowance: Number(u.allowance) || 0,
    } : { name: u.name, role: u.role }),
    activities: allActivities.filter(a => admin || bool_(a.active)).map(a => ({
      id: a.id, type: a.type, name: a.name, active: bool_(a.active),
      rotation: list_(a.rotation).join(', '),
      frequency_days: Number(a.frequency_days) || 0,
      notify_rules: rulesOf_(a.notify_rules),
      open: open.filter(t => t.activity_id === a.id).map(turnView_),
      upcoming: upcoming_(a, 5),
    })),
    open: open.map(turnView_),
    offers: open.filter(t => t.offer_to === me.name).map(turnView_),
    history: turns.filter(t => !isOpen_(t))
      .sort((a, b) => (ms_(b.completed_at) || ms_(b.due_at)) - (ms_(a.completed_at) || ms_(a.due_at)))
      .slice(0, 40).map(turnView_),
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
      summary: users_().map(u => ({
        name: u.name, count: goodWords.filter(g => g.member === u.name).length,
      })),
      perPrize: GOOD_WORDS_PER_PRIZE,
    },
    allowance: users_().filter(u => admin || u.name === me.name)
      .map(u => ({ name: u.name, amount: Number(u.allowance) || 0 })),
  };
}

/** Task button, step 1: the member begins working on it. */
function startTurn(token, turnId) {
  return withLock_(() => {
    const me = auth_(token);
    const turn = openTask_(turnId);
    requireParticipant_(me, turn);
    if (turn.status !== 'assigned') throw new Error('This task was already started.');
    if (turn.offer_to) throw new Error(`Waiting for ${turn.offer_to} to answer the pass / switch request.`);
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

/**
 * Ask another member to take this turn.
 *   pass   — they take it, nothing in return.
 *   switch — they take it now; the asker takes their next turn in the same task.
 */
function offerTurn(token, turnId, toName, kind) {
  return withLock_(() => {
    const me = auth_(token);
    const turn = openTask_(turnId);
    if (members_(turn.assignee).indexOf(me.name) < 0) throw new Error('This is not your task.');
    if (turn.status !== 'assigned') throw new Error('You can only pass a task before starting it.');
    if (turn.offer_to) throw new Error(`Already waiting for ${turn.offer_to} to answer.`);
    if (kind !== 'pass' && kind !== 'switch') throw new Error('Unknown request.');
    if (kind === 'switch' && !turn.activity_id) throw new Error('One-time tasks can only be passed, not switched.');
    const target = userByName_(toName);
    if (!target || target.name === me.name) throw new Error('Pick another family member.');
    if (members_(turn.assignee).indexOf(target.name) >= 0) throw new Error(`${target.name} is already on this task.`);

    turn.offer_to = target.name;
    turn.offer_kind = kind;
    turn.offer_by = me.name;
    writeRow_('Turns', turn);
    notifyUser_(target.name, `🔄 ${me.name} asks you to take "${turn.title}"`,
                `${me.name} asks you to do "${turn.title}" (due ${fmt_(turn.due_at)}).`
                + (kind === 'switch' ? `\nIn return, ${me.name} will do your next "${turn.title}" turn.` : '')
                + '\n\nAccept or decline in the Tasks tab.');
    return getState(token);
  });
}

/** The asked member accepts / declines; the asker can also withdraw (accept = false). */
function answerOffer(token, turnId, accept) {
  return withLock_(() => {
    const me = auth_(token);
    const turn = openTask_(turnId);
    if (!turn.offer_to) throw new Error('There is no pending request on this task.');
    const asker = turn.offer_by;
    const target = turn.offer_to;
    const kind = turn.offer_kind;

    if (me.name === asker) {
      clearOffer_(turn);
      writeRow_('Turns', turn);
      notifyUser_(target, `🔄 Request withdrawn: ${turn.title}`,
                  `${asker} withdrew the request about "${turn.title}".`);
      return getState(token);
    }
    if (target !== me.name) throw new Error('This request is not for you.');
    clearOffer_(turn);
    if (!accept) {
      writeRow_('Turns', turn);
      notifyUser_(asker, `🔄 ${me.name} declined: ${turn.title}`,
                  `${me.name} declined to take "${turn.title}". It is still yours, due ${fmt_(turn.due_at)}.`);
      return getState(token);
    }

    turn.assignee = members_(turn.assignee).map(n => n === asker ? me.name : n).join('+');
    initReminders_(turn);
    turn.overdue_sent = false;
    refreshCalendar_(turn);
    writeRow_('Turns', turn);
    if (kind === 'switch') {
      const activity = readAll_('Activities').find(a => a.id === turn.activity_id);
      if (activity) {
        activity.swap_queue = list_(activity.swap_queue).concat([`${me.name}>${asker}`]).join(',');
        writeRow_('Activities', activity);
      }
    }
    notifyUser_(asker, `🔄 ${me.name} accepted: ${turn.title}`,
                `${me.name} will do "${turn.title}" (due ${fmt_(turn.due_at)}).`
                + (kind === 'switch' ? `\nYou will do ${me.name}'s next "${turn.title}" turn.` : ''));
    return getState(token);
  });
}

// ---------- Push notifications (this phone) ----------

const MAX_PUSH_DEVICES = 5;

/** Saves this phone's Firebase token so the member gets push notifications on it. */
function registerPush(token, fcmToken) {
  return withLock_(() => {
    const me = auth_(token);
    const device = clean_(fcmToken, 4096);
    if (!device || /[,\s]/.test(device)) throw new Error('Invalid device token.');
    const tokens = list_(me.push_tokens).filter(t => t !== device);
    tokens.push(device);
    me.push_tokens = tokens.slice(-MAX_PUSH_DEVICES).join(',');
    me.notify_push = true;
    writeRow_('Users', me);
    return getState(token);
  });
}

function unregisterPush(token, fcmToken) {
  return withLock_(() => {
    const me = auth_(token);
    me.push_tokens = list_(me.push_tokens).filter(t => t !== fcmToken).join(',');
    writeRow_('Users', me);
    return getState(token);
  });
}

function testPush(token) {
  const me = auth_(token);
  if (!pushAccount_()) throw new Error('Push is not set up yet (FIREBASE_SERVICE_ACCOUNT is missing in Apps Script).');
  if (!list_(me.push_tokens).length) throw new Error('Turn on notifications on this phone first.');
  const sent = withLock_(() => sendPush_(me, '🔔 Test from Family Hub', `Hi ${me.name}, notifications work!`));
  if (!sent) throw new Error('Firebase did not accept the notification. Turn notifications off and on again on this phone.');
  return getState(token);
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
      activity = { id: uid_(), type: input.type, current_index: 0, penalty_queue: '', swap_queue: '' };
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
    if (activity.type === 'task') activity.notify_rules = JSON.stringify(parseRules_(input.notify_rules));
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

/** Assign a rotating task to the next slot in the queue. */
function adminAssignTask(token, activityId, dueMs) {
  return withLock_(() => {
    requireAdmin_(auth_(token));
    const activity = readAll_('Activities').find(a => a.id === activityId);
    if (!activity || activity.type !== 'task' || !bool_(activity.active)) throw new Error('Task not found.');
    const due = futureDate_(dueMs);
    const assignee = consumeAssignee_(activity);
    writeRow_('Activities', activity);
    createTaskTurn_({ activity_id: activity.id, title: activity.name, assignee: assignee,
                      due_at: due, rules: rulesOf_(activity.notify_rules) });
    return getState(token);
  });
}

function adminCreateOneTimeTask(token, input) {
  return withLock_(() => {
    requireAdmin_(auth_(token));
    const title = clean_(input.title, 60);
    if (!title) throw new Error('Task name is required.');
    const assignee = normalizeSlot_(input.assignee);
    validateSlot_(assignee);
    createTaskTurn_({ activity_id: '', title: title, assignee: assignee,
                      due_at: futureDate_(input.due_at), rules: parseRules_(input.notify_rules) });
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
      if (slot !== turn.assignee) clearOffer_(turn);
      turn.assignee = slot;
    }
    if (changes.due_at) {
      const due = new Date(Number(changes.due_at));
      if (isNaN(due.getTime())) throw new Error('Invalid date.');
      turn.due_at = due;
      turn.overdue_sent = false;
    }
    if (turn.type === 'fun' && changes.place !== undefined) turn.place = clean_(changes.place, 100);
    if (turn.type === 'task') initReminders_(turn);
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
      turn.due_at = new Date(base + hours_(add));
      turn.extra_request = 'granted';
      turn.overdue_sent = false;
      initReminders_(turn);
      refreshCalendar_(turn);
      writeRow_('Turns', turn);
      notify_(turn.assignee, `⏳ Extra time granted: ${turn.title}`,
              `${display_(turn.assignee)}: you got ${add} more hour${add > 1 ? 's' : ''}. "${turn.title}" is now due ${fmt_(turn.due_at)}.`);
    }
    return getState(token);
  });
}

/** Task: close without doing it. Fun: cancel this event and move to the next slot. */
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

/**
 * Give a yellow card. If the member already has an unused yellow, both turn
 * into a red card, and red_task_id (required then) gets the member as its next
 * assignee.
 */
function adminGiveCard(token, input) {
  return withLock_(() => {
    const me = auth_(token);
    requireAdmin_(me);
    const member = userByName_(input.member);
    if (!member) throw new Error('Pick a family member.');
    const explanation = clean_(input.explanation, 300);
    if (!explanation) throw new Error('Write why the card is given.');
    const activities = readAll_('Activities');
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
      notifyWithAdmins_(member.name, `🟨 Yellow card for ${member.name}`,
                        `${member.name} got a yellow card from ${me.name}.\nWhy: ${explanation}\n`
                        + 'A second yellow card becomes a red card.');
      return getState(token);
    }

    const redTask = activities.find(a => a.id === input.red_task_id && a.type === 'task' && bool_(a.active));
    if (!redTask) throw new Error('This is the 2nd yellow card: pick the task for the extra turn.');
    yellow.used = true;
    writeRow_('Cards', yellow);
    activeYellows.forEach(c => { c.used = true; writeRow_('Cards', c); });
    writeRow_('Cards', {
      id: uid_(), member: member.name, color: 'red', explanation: explanation,
      task_id: yellow.task_id, red_task_id: redTask.id, used: false,
      created_at: new Date(), by: me.name,
    });
    redTask.penalty_queue = [member.name].concat(list_(redTask.penalty_queue)).join(',');
    writeRow_('Activities', redTask);
    notifyWithAdmins_(member.name, `🟥 Red card for ${member.name}`,
                      `${member.name} got a second yellow card from ${me.name}, which makes a red card.\n`
                      + `Why: ${explanation}\nPenalty: an extra turn in "${redTask.name}".`);
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
    notifyUser_(member.name, `🌟 Good word for ${member.name}!`,
                `${me.name}: ${explanation}`
                + (prize ? `\n\n🎁 That's ${count} good words — your prize: ${prize}` : ''));
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
      if (!name || /[,+>]/.test(name)) throw new Error('Name is required and cannot contain ",", "+" or ">".');
      if (all.some(u => u.name === name)) throw new Error('That name already exists.');
      user = { token: newToken_(), name: name };
    }
    user.email = clean_(input.email, 100);
    user.role = input.role === 'admin' ? 'admin' : 'member';
    user.notify_email = !!input.notify_email;
    user.notify_calendar = !!input.notify_calendar;
    user.notify_push = !!input.notify_push;
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

function adminRunCheck(token) {
  requireAdmin_(auth_(token));
  tick();
  return getState(token);
}

// ============================================================================
// Scheduler (time-driven trigger every 5 minutes)
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
        checkTaskDeadline_(turn, now);
      }
    });

    // A fun activity always has one coming event.
    activities
      .filter(a => a.type === 'fun' && bool_(a.active) && !open.some(t => t.activity_id === a.id))
      .forEach(startFunTurn_);
  });
}

/** Sends each reminder rule once, then one overdue alert. No automatic cards. */
function checkTaskDeadline_(turn, now) {
  const due = new Date(turn.due_at).getTime();
  const who = display_(turn.assignee);
  const sent = list_(turn.reminders_sent);
  let changed = false;

  if (now < due) {
    rulesOf_(turn.notify_rules).forEach((rule, i) => {
      if (sent.indexOf(String(i)) >= 0 || now < fireTime_(rule, due)) return;
      sent.push(String(i));
      changed = true;
      notify_(turn.assignee, `🔔 Reminder: ${turn.title}`,
              `${who}: "${turn.title}" is due ${fmt_(turn.due_at)}.`);
    });
  }
  if (changed) turn.reminders_sent = sent.join(',');

  if (!bool_(turn.overdue_sent) && now > due) {
    turn.overdue_sent = true;
    changed = true;
    notifyWithAdmins_(turn.assignee, `⏰ Overdue: ${turn.title} (${who})`,
                      `"${turn.title}" was due ${fmt_(turn.due_at)} and is not done yet (${who}).`);
  }
  if (changed) writeRow_('Turns', turn);
}

// ============================================================================
// Reminder rules
//   { kind: 'before', minutes: 30 }                    — 30 minutes before the due time
//   { kind: 'daysBefore', days: 1, time: '19:00' }     — the day before at 19:00
// ============================================================================

function parseRules_(input) {
  const rules = (Array.isArray(input) ? input : []).slice(0, MAX_RULES).map(r => {
    if (r && r.kind === 'before') {
      return { kind: 'before', minutes: int_(r.minutes, 1, 7 * 24 * 60, 120) };
    }
    if (r && r.kind === 'daysBefore' && /^\d{1,2}:\d{2}$/.test(String(r.time))) {
      const parts = String(r.time).split(':').map(Number);
      if (parts[0] > 23 || parts[1] > 59) throw new Error('Invalid reminder time.');
      return { kind: 'daysBefore', days: int_(r.days, 1, 14, 1), time: String(r.time).padStart(5, '0') };
    }
    throw new Error('Invalid reminder rule.');
  });
  return rules;
}

/** Stored rules (JSON text); missing ones fall back to the default. */
function rulesOf_(text) {
  if (text === '' || text === undefined || text === null) return DEFAULT_RULES.slice();
  try { return parseRules_(JSON.parse(text)); } catch (e) { return DEFAULT_RULES.slice(); }
}

function fireTime_(rule, dueMs) {
  if (rule.kind === 'before') return dueMs - rule.minutes * 60000;
  const d = new Date(dueMs);
  const parts = rule.time.split(':').map(Number);
  d.setDate(d.getDate() - rule.days);
  d.setHours(parts[0], parts[1], 0, 0);
  return d.getTime();
}

/** Rules whose time already passed count as sent, so a fresh turn doesn't get a burst of late reminders. */
function initReminders_(turn) {
  const now = Date.now();
  const due = new Date(turn.due_at).getTime();
  turn.reminders_sent = rulesOf_(turn.notify_rules)
    .map((rule, i) => fireTime_(rule, due) <= now ? String(i) : null)
    .filter(x => x !== null).join(',');
}

// ============================================================================
// Rotation logic
// ============================================================================

/**
 * Next slot: penalty turns (red cards) jump the queue; otherwise walk the
 * rotation. A pending switch ("Yuval>Noa") then hands Yuval's turn to Noa once.
 */
function consumeAssignee_(activity) {
  let slot;
  const queue = list_(activity.penalty_queue);
  if (queue.length) {
    slot = queue.shift();
    activity.penalty_queue = queue.join(',');
  } else {
    const rotation = list_(activity.rotation);
    if (!rotation.length) throw new Error(`"${activity.name}" has an empty rotation.`);
    const index = (Number(activity.current_index) || 0) % rotation.length;
    activity.current_index = (index + 1) % rotation.length;
    slot = rotation[index];
  }
  const swaps = list_(activity.swap_queue);
  slot = applySwap_(slot, swaps);
  activity.swap_queue = swaps.join(',');
  return slot;
}

/** Replaces the first member of the slot that owes a switch; consumes that entry. */
function applySwap_(slot, swaps) {
  const names = members_(slot);
  for (let i = 0; i < swaps.length; i++) {
    const parts = swaps[i].split('>');
    const at = names.indexOf(parts[0]);
    if (at >= 0 && parts[1]) {
      names[at] = parts[1];
      swaps.splice(i, 1);
      return names.join('+');
    }
  }
  return slot;
}

function upcoming_(activity, count) {
  const queue = list_(activity.penalty_queue);
  const rotation = list_(activity.rotation);
  const swaps = list_(activity.swap_queue);
  let index = Number(activity.current_index) || 0;
  const out = [];
  while (out.length < count && (queue.length || rotation.length)) {
    const penalty = queue.length > 0;
    const slot = penalty ? queue.shift() : rotation[index++ % rotation.length];
    const swapped = applySwap_(slot, swaps);
    out.push({ name: swapped, penalty: penalty, switched: swapped !== slot });
  }
  return out;
}

function createTaskTurn_(fields) {
  const turn = {
    id: uid_(), activity_id: fields.activity_id, type: 'task', title: fields.title,
    assignee: fields.assignee, due_at: fields.due_at, status: 'assigned', card: '',
    extra_request: '', notify_rules: JSON.stringify(fields.rules), overdue_sent: false,
  };
  initReminders_(turn);
  turn.calendar_event_id = addCalendar_(turn);
  writeRow_('Turns', turn);
  notify_(turn.assignee, `🧹 New task: ${turn.title}`,
          `${display_(turn.assignee)}: you've been assigned "${turn.title}". Due: ${fmt_(turn.due_at)}.\n`
          + 'Press Start when you begin and Done when you finish.');
  return turn;
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
  clearOffer_(turn);
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

function clearOffer_(turn) {
  turn.offer_to = '';
  turn.offer_kind = '';
  turn.offer_by = '';
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

function futureDate_(ms) {
  const due = new Date(Number(ms));
  if (isNaN(due.getTime()) || due.getTime() <= Date.now()) throw new Error('The due time must be in the future.');
  return due;
}

// ---------- Rotation slots ("Noa" or "Dad+Noa") ----------

function members_(slot) { return String(slot || '').split('+').map(x => x.trim()).filter(Boolean); }
function normalizeSlot_(slot) { return members_(slot).join('+'); }
function display_(slot) { return members_(slot).join(' & '); }

function validateSlot_(slot) {
  const names = users_().map(u => u.name);
  const unknown = members_(slot).filter(n => names.indexOf(n) < 0);
  if (!members_(slot).length) throw new Error('Pick at least one family member.');
  if (unknown.length) throw new Error('Unknown names: ' + unknown.join(', '));
}

// ============================================================================
// Notifications: email, push (Firebase Cloud Messaging), Google Calendar
// ============================================================================

/** Notifies every person in a slot ("Dad+Noa" notifies both). */
function notify_(slot, subject, body) {
  members_(slot).forEach(name => notifyUser_(name, subject, body));
}

/** The slot's member(s) plus every admin, each only once. */
function notifyWithAdmins_(slot, subject, body) {
  const names = members_(slot);
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

  if (bool_(user.notify_push) && list_(user.push_tokens).length) {
    try { sendPush_(user, subject, body); }
    catch (e) { console.warn('push failed', e); }
  }
}

/** The Firebase service account from the script properties, or null if push isn't set up. */
function pushAccount_() {
  const raw = PropertiesService.getScriptProperties().getProperty('FIREBASE_SERVICE_ACCOUNT');
  if (!raw) return null;
  try {
    const account = JSON.parse(raw);
    return account.client_email && account.private_key && account.project_id ? account : null;
  } catch (e) {
    console.warn('FIREBASE_SERVICE_ACCOUNT is not valid JSON');
    return null;
  }
}

/** OAuth access token for FCM, from a service-account JWT; cached for 50 minutes. */
function fcmAccessToken_(account) {
  const cache = CacheService.getScriptCache();
  const cached = cache.get('fcm_access_token');
  if (cached) return cached;

  const now = Math.floor(Date.now() / 1000);
  const b64 = s => Utilities.base64EncodeWebSafe(s).replace(/=+$/, '');
  const unsigned = b64(JSON.stringify({ alg: 'RS256', typ: 'JWT' })) + '.' + b64(JSON.stringify({
    iss: account.client_email,
    scope: 'https://www.googleapis.com/auth/firebase.messaging',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now, exp: now + 3600,
  }));
  const signature = Utilities.base64EncodeWebSafe(
    Utilities.computeRsaSha256Signature(unsigned, account.private_key)).replace(/=+$/, '');
  const response = UrlFetchApp.fetch('https://oauth2.googleapis.com/token', {
    method: 'post', muteHttpExceptions: true,
    payload: { grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: unsigned + '.' + signature },
  });
  if (response.getResponseCode() !== 200) {
    throw new Error('Firebase login failed: ' + response.getContentText().slice(0, 200));
  }
  const accessToken = JSON.parse(response.getContentText()).access_token;
  cache.put('fcm_access_token', accessToken, 50 * 60);
  return accessToken;
}

/**
 * Sends a notification to every phone the user registered. Phones Firebase
 * reports as gone (app removed, notifications reset) are dropped from the list.
 * Returns true if at least one phone accepted it.
 */
function sendPush_(user, title, body) {
  const account = pushAccount_();
  const tokens = list_(user.push_tokens);
  if (!account || !tokens.length) return false;
  const url = `https://fcm.googleapis.com/v1/projects/${account.project_id}/messages:send`;
  const accessToken = fcmAccessToken_(account);
  const alive = [];
  let delivered = false;

  tokens.forEach(device => {
    const response = UrlFetchApp.fetch(url, {
      method: 'post', contentType: 'application/json', muteHttpExceptions: true,
      headers: { Authorization: 'Bearer ' + accessToken },
      payload: JSON.stringify({ message: {
        token: device,
        webpush: {
          notification: { title: title, body: String(body).slice(0, 300),
                          icon: APP_URL + 'icon-192.png', badge: APP_URL + 'icon-192.png' },
          fcm_options: { link: APP_URL },
        },
      } }),
    });
    const code = response.getResponseCode();
    const text = response.getContentText();
    if (code === 200) {
      delivered = true;
      alive.push(device);
    } else if (code === 404 || /UNREGISTERED|registration token/i.test(text)) {
      console.warn('dropping a push device of ' + user.name);
    } else {
      alive.push(device);  // a temporary error: keep the phone
      console.warn('push error ' + code + ': ' + text.slice(0, 200));
    }
  });

  if (alive.length !== tokens.length) {
    user.push_tokens = alive.join(',');
    writeRow_('Users', user);
  }
  return delivered;
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
    // Popups on the family calendar mirror the task's "before" rules (guests use their own defaults).
    if (turn.type === 'task') {
      rulesOf_(turn.notify_rules).filter(r => r.kind === 'before')
        .forEach(r => event.addPopupReminder(Math.min(r.minutes, 40320)));
    } else {
      event.addPopupReminder(120);
    }
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
    one_time: t.type === 'task' && !t.activity_id,
    assignee: t.assignee, members: members_(t.assignee), due_at: ms_(t.due_at),
    place: String(t.place || ''), status: t.status,
    started_at: ms_(t.started_at), completed_at: ms_(t.completed_at),
    completed_by: t.completed_by, extra_request: t.extra_request || '',
    extra_reason: String(t.extra_reason || ''), note: String(t.note || ''),
    notify_rules: t.type === 'task' ? rulesOf_(t.notify_rules) : [],
    offer_to: t.offer_to || '', offer_kind: t.offer_kind || '', offer_by: t.offer_by || '',
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
