# Family Hub

This is the family's app for **tasks** (chores), **cards**, **good words**, **allowance** and **fun** (dates, outings). It runs on Google Sheets and Apps Script plus GitHub Pages, costs nothing, and needs no app-store install.

A **rotation slot** is one person (`Noa`) or several people joined with `+` (`Dad+Noa`). For a group, everyone in it is notified.

## Screens
| Tab | What's there |
|---|---|
| 🧹 **Tasks** | Requests for you (Accept / Decline), my tasks, everyone else's, who's next in each rotation, history |
| 🟨 **Cards** | Each member's current yellow and total reds, and every card with its explanation |
| 🎉 **Fun Stuff** | Coming dates, good words (with prizes), allowance |
| ⚙️ **Admin** | Admins only: extra-time requests, give cards / good words, tasks, fun, family, links |

## Tasks 🧹
- **Rotating tasks** have a name, a rotation order (e.g. `Noa, Yuval, Yael`) and **reminders**. An admin taps **Assign to &lt;next person&gt;** and sets the due time (default 21:00 today). The member gets an email and a calendar invite.
- **One-time tasks:** an admin sets a name, a member, a due time and reminders. There's no rotation.
- **Reminders (per task):** one or more of:
  - *N minutes/hours before*, e.g. 30 minutes before
  - *N days before at HH:MM*, e.g. the day before at 19:00

  Each reminder is sent once. Reminders whose time has already passed when the task is assigned are skipped. Changes to a task's reminders apply from its next assignment.
- **Start → Done:** the member taps **▶ Start** when they begin and **✓ Done** when they finish.
- **Overdue:** if a task isn't done by its due time, the member and the admins get one *overdue* message. Cards are **not** automatic; the admins decide.
- **⏳ Extra time:** the member asks, the admins get the request in the Admin tab, and can **Refuse** or **Add N hours**.
- **Pass to…:** before starting, the member can ask another member to take the task. The other member gets a request and can **Accept** or **Decline**.
- **Switch with…:** the same, but as a trade. *"You do my turn now, I do your next turn in this task."* After it's accepted, "Who's next" shows the owed turn with 🔄. Not available for one-time tasks.
- Admins can also **reassign** an open task or change its due time, or **excuse** it.

## Cards 🟨🟥
- An admin gives a **yellow card** to a member, with an explanation everyone can see, and optionally a related task.
- A yellow card stays until the member gets a **second** one. The two then become a **red card**, and the admin picks the task in which the member gets an **extra turn**. They're put at the front of that task's queue, shown with 🟥 in "Who's next".
- Card messages go to the member and the admins.

## Good words 🌟
- An admin gives a good word with an explanation everyone can see.
- Every **3rd** good word comes with a **prize** the admin chooses when giving it. It's shown with the good word and sent to the member.

## Allowance 💰
- An admin sets each member's monthly amount in **Admin → Edit member**.
- Each member sees their next two paydays: the 1st of the coming months. Admins see everyone's.

## Fun 🎉
- **Fields:** name, rotation (e.g. `Dad+Noa, Mom+Yuval`), repeat every N days, and the coming event's time and place.
- An admin can **Update time & place** at any time. The people in that slot get an email and an updated calendar invite.
- Two hours after the event starts it counts as done, and the next event is created for the next slot. **Cancel this one** skips to the next slot.

## How it's built
- **`docs/`:** the screens, a static web app on **GitHub Pages** (`https://roycaspi77.github.io/family-hub/`).
- **`apps-script/`:** the backend, a Google Apps Script bound to the Google Sheet. It stores the data, sends emails and calendar invites, and checks reminders every 5 minutes. The page talks to it as a JSON API (`docs/config.js` holds its `/exec` URL).

Personal links look like `https://roycaspi77.github.io/family-hub/#u=<token>`. The token goes after `#`, so it is never sent to GitHub. The phone also remembers it, so the home-screen icon keeps working.

## Upgrading to this version (from the earlier one)
1. Open your Google Sheet → **Extensions → Apps Script**.
2. Replace all of `Code.gs` with [`apps-script/Code.gs`](apps-script/Code.gs), then **Save** (Ctrl+S).
3. Choose the **`setup`** function in the toolbar and click **Run**. It is safe to run again:
   - It adds the new sheets (`Cards`, `GoodWords`) and the new columns, and keeps all existing data.
   - It switches the automatic check to every 5 minutes.
   - If Google asks for permissions again, approve them.
4. **Deploy → Manage deployments → ✏️ Edit → Version: *New version* → Deploy.** The URL stays the same, so `config.js` doesn't change.
5. In the app: set each member's **allowance** (Admin → Edit), and open each task's **Edit** to set its reminders (they start at "2 hours before").

The screens update by themselves from GitHub. Phones that already have the app open may need a refresh, or up to 10 minutes.

Old yellow/red cards from the earlier version were stored on tasks. They aren't carried into the new Cards tab, which starts empty.

## First-time setup (new Sheet)
1. Create a Google Sheet → **Extensions → Apps Script**. Paste `apps-script/Code.gs` into `Code.gs` (check that `APP_URL` is your GitHub Pages address). In **Project Settings → Show "appsscript.json"**, paste in `apps-script/appsscript.json`.
2. Run **`setup`** and approve the permissions. In the **Users** sheet, rename `Admin` to your name.
3. **Deploy → New deployment → Web app**, with *Execute as: Me* and *Who has access: Anyone*. Put the `/exec` URL in `docs/config.js`.
4. Run **`printLinks`**, open your link, then add the family in **Admin** and send each person their link (**Personal links → Send via WhatsApp**).
5. On each phone: open the link → **Add to Home Screen**.

### If a phone blocks it
Approve `roycaspi77.github.io` in the parental controls (Family Link: Controls → Content restrictions → Google Chrome → Manage sites → Approved). Approve `script.google.com` too if the app opens but says "No connection to the server".

### WhatsApp (optional)
To also send notifications over WhatsApp through [CallMeBot](https://www.callmebot.com/blog/free-api-whatsapp-messages/), a free third-party service:
1. On the member's phone, add the CallMeBot number (listed on that page) to contacts.
2. Send it `I allow callmebot to send me messages`.
3. Enter the phone number (`+9725…`) and the API key you receive in **Admin → Edit member**, and tick **WhatsApp**.

## Notes
- **Each personal link works like a password.** If one leaks, replace that user's `token` cell in the Users sheet with a new random string and send them the new link.
- **Timing:** reminders are checked every 5 minutes. **Run check now** in the Admin tab runs the check immediately.
- **Member names** are used as keys and can't contain `,` `+` or `>`.
- **Quotas:** Gmail allows about 100 emails a day from a free account, which is plenty for one family.
