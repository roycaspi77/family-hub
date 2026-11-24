# Family Hub

This is the family's app for **tasks**, the **shopping list**, **cards**, **dates**, **good words** and **allowance**. It runs on a Google Sheet with Apps Script plus GitHub Pages, costs nothing, and needs no app-store install.

**Nothing is sent automatically.** Everything is shown in the app (badges show what's waiting), and messages go through **💬 WhatsApp buttons**. A button opens WhatsApp with the message ready; you pick the chat (the family group) and tap **Send**. There are no direct-to-member buttons.

## Screens
| Tab | What's there |
|---|---|
| 🧹 **Tasks** | Requests for you (Accept / Decline), my tasks, the rotations, other one-time tasks, history |
| 🛒 **Shopping** | The family's shopping list: add, edit, delete, tick off in the store, wishes, usuals and "running low?" |
| 🟨 **Cards** | Each member's current yellow and total reds, every card with its explanation. Admins also get ⚠️ Warn and 💬 Send. |
| 🎉 **Fun Stuff** | Coming dates, 🏅 achievements and 🏆 rewards, 🌟 good words, allowance, past dates |
| ⚙️ **Admin** | Admins only: replacement requests, tasks, the rotation line editor, dates, cards, good words, family, links |

## Tasks
### 🔁 Rotating tasks
- **Fields:** a name and a rotation order (e.g. `Noa, Yuval, Yael`). There's no due date.
- **Current turn:** there's always one. When that member taps **✓ Done**, the turn goes to the next in line.
- **The admin's line editor** (Admin → Rotating tasks):
  - **➕ Add a turn:** an *extra* turn for someone anywhere in the line, without changing the rotation. With `X-Y-Z-X…`, an extra turn for X right after X gives `X-X-Y-Z-X…`, and one for Y after Y gives `X-Y-Y-Z-X…`.
  - **↑ / ↓:** change the order of the coming turns. After those turns, the rotation returns to its normal order.
  - **✕:** removes an extra turn. Regular turns can only be moved.
  - **Back to normal order:** undoes every change.
  - **Reassign:** gives the current turn to someone else. **Skip turn** moves on to the next in line.
- **Members:**
  - **Pass to…:** another member takes this turn, with nothing in return.
  - **Switch with…:** the other member does this turn now, and you do their next turn in that task.
  - **Ask to be replaced:** the admins see the request (with a badge on Admin) and either pick who does this turn or decline. The rotation doesn't change.

  The other member accepts or declines in their Tasks tab. You can **💬 Nudge** them on WhatsApp.

### 📌 One-time tasks
- **Fields:** a name, a member and a due date (default 21:00 today). **✓ Done** ends it.
- **Members** can **Pass to…** or **Ask to be replaced**.
- **Admins** can edit it, reassign it, or cancel it.

### 💬 Reminders
An admin taps **💬 Remind** on a task, and WhatsApp opens with a ready message for the group:
- Rotating: *"Hi Noa, it's your turn for "Dishes" 🧹 …"*
- One-time: *"… is due Sun 21:00 …"*

## 🛒 Shopping
One shared list. **Everyone** can add, edit and delete items. Took the last apple? Add "apples" and it's on the list for the next trip.
- **Adding:** a name, and optionally how much ("2 kg", "the big pack") and ⚡ **Urgent** (we're out of it). As you type, the app suggests names the family used before.
- **Sorted by category** (🥬 Fruit & vegetables, 🥛 Dairy & eggs…) in the order you walk through the store. *Auto category* uses the category the item had last time, or guesses it from the name (English and Hebrew). You can change it when adding, or later.
- **No duplicates:** if it's already on the list, the app says who added it and doesn't add it again. Adding it as urgent makes the existing item urgent.
- **Edit:** tap an item's name. **🗑 Delete** shows an **Undo** for a few seconds.
- **In the store:** tap ○ to put an item in the cart (it moves to *In the cart*); tap ✓ to put it back. Two people shopping see each other's ticks (the list refreshes every 20 s). **✓ Finish shopping** marks everything in the cart as bought; the rest stays for next time.
- **⭐ Our usuals:** the things the family buys most, one tap to add.
- **🔔 Running low?** Items bought at least 3 times show up when it's been longer than usual since the last time ("Milk · 9d"). Tap to add, or ✕ to hide it for a while.
- **🙋 Wishes:** when a member (not an admin) adds something in a *wish* category (by default 🍫 Snacks & sweets), it waits for an admin's **OK** or **Not now**.
- **💬 WhatsApp:** *I'm going shopping* (asks the family to add what they need) and *Send the list* (the whole list as text). WhatsApp asks which chat to send to, e.g. the family group.
- **Admins:** Admin → **🛒 Shopping categories** sets the categories and their order, and which ones are wish categories. Renaming a category moves its items to *Not sorted*.

## 🟨 Cards
- An admin gives a **yellow card** with an explanation everyone can see.
- A **second** yellow makes a **red card**, and the admin picks a rotating task where the member gets an **extra turn** right after the current one.
- **WhatsApp:**
  - **⚠️ Warn** (Cards tab, per member): *"⚠️ Noa, this is a warning. Next time you'll get a yellow card 🟨"*. If the member already has a yellow, the message says the next card will be red.
  - **💬 Send** on each card tells the member about it.

## 🎉 Fun Stuff
- **Dates:**
  - **Fields:** a name, one or more members (e.g. Dad and Noa), a time and a place. Dates don't repeat.
  - **Admins** can add, edit and delete dates, and tap **💬 Remind** to message each member.
  - A date moves to *Past dates* 3 hours after it starts.
- **🌟 Good words** (one list of both kinds):
  - **Done on your own task:** pressing **Done** on your own task earns one ("✅ Noa did "Dishes""). When an admin presses Done for you, it doesn't (History shows "🌟 Noa" vs "by Dad").
  - **From an admin:** with an explanation everyone can see (**+🌟** next to the member, or Admin → **🌟 Good word**). Admins can **💬 Send** each one to the group.
- **🏅 Achievements** (like the badges in word-games):
  - Each member has a badge per rotating task, one for one-time tasks, and one for good words from an admin. Locked badges are grey, and each shows a progress bar to its next level.
  - Levels: 🥉 Bronze, 🥈 Silver, 🥇 Gold, 🏅 Champion, 💎 Diamond, 👑 Royal, 🚀 Legend. A task's levels come at 3 / 10 / 20 / 35 / 50 / 75 / 100 Dones, then every 25. Good words come at 1 / 3 / 6 / 10 / 15 / 20 / 30 / 40 / 50, then every 10. Each level reached is one achievement.
  - Every **5** achievements of any kind earn a **🏆 reward**. Each reward has a **💬 Announce the reward** button for the family group.
  - To change the levels, edit `TASK_LEVELS`, `WORD_LEVELS` and `ACHIEVEMENTS_PER_REWARD` at the top of `Code.gs`.
- **💰 Allowance:** a monthly amount per member, set in Admin → Edit member. Each member sees their next two paydays (the 1st of each month), and admins see everyone's.

## How it's built
- **`docs/`:** the screens, a static web app on **GitHub Pages** (`https://roycaspi77.github.io/family-hub/`).
- **`apps-script/`:** the backend, a Google Apps Script bound to the Google Sheet (JSON API). `docs/config.js` holds its `/exec` URL.
- **Personal links:** they look like `https://roycaspi77.github.io/family-hub/#u=<token>`. The token goes after `#`, so it is never sent to GitHub, and the phone remembers it.

## Upgrading from the previous version
1. Open the Google Sheet → **Extensions → Apps Script**. Replace all of `Code.gs` with [`apps-script/Code.gs`](apps-script/Code.gs) and save.
2. Run **`setup`** once. It keeps all data and:
   - adds the `Groceries`, `GroceryCatalog` and `Settings` sheets for the shopping list;
   - removes the automatic 5-minute check;
   - turns red-card penalty turns into extra turns;
   - stops recurring dates (the coming one stays as a one-off date);
   - gives every rotating task its current turn.
3. **Deploy → Manage deployments → ✏️ Edit → New version → Deploy.** The link stays the same.
4. **Optional cleanup:**
   - Delete the `FIREBASE_SERVICE_ACCOUNT` script property.
   - Delete the Firebase project (console.firebase.google.com → Project settings → Delete project).
   - Delete the "Family Hub" calendar in Google Calendar.
   - Delete the `Board` sheet.
   - Old columns in the sheets are ignored.

## First-time setup (new Sheet)
1. Create a Google Sheet → **Extensions → Apps Script**. Paste `apps-script/Code.gs` into `Code.gs` (check that `APP_URL` is your GitHub Pages address). In **Project Settings → Show "appsscript.json"**, paste in `apps-script/appsscript.json`.
2. Run **`setup`** and approve the permissions. In the **Users** sheet, rename `Admin` to your name.
3. **Deploy → New deployment → Web app**, with *Execute as: Me* and *Who has access: Anyone*. Put the `/exec` URL in `docs/config.js`.
4. Run **`printLinks`** and open your link. In **Admin**, add the family, then send each person their link (**Personal links → Share…**).
5. On each phone: open the link → **Add to Home Screen**.

If parental controls block it, approve `roycaspi77.github.io` and `script.google.com` (Family Link: Controls → Content restrictions → Google Chrome → Manage sites → Approved).

## Notes
- **Each personal link works like a password.** If one leaks, replace that user's `token` cell in the Users sheet with a new random string and send them the new link.
- **Member names** are used as keys and can't contain `,` `+` or `*`.
