# Family Hub

This is the family's app for **tasks** (chores) and **fun** (dates, outings). It runs on Google Sheets and Apps Script, costs nothing, and needs no app-store install.

A **rotation slot** is one person (`Noa`) or several people joined with `+` (`Dad+Noa`). For a group, everyone in it is notified.

## Tasks 🧹
**Fields:** name and rotation order (e.g. `Noa, Yuval, Yael`).

1. **Assign:** whenever they want, an admin taps **Assign to &lt;next person&gt;** in the Admin tab and sets the due date and time. The default is 21:00 today, or tomorrow if it's already past 21:00. The member gets an **email** and a **calendar invite** with a 2-hour reminder.
2. **Start → Done:** the member taps **▶ Start** when they begin and **✓ Done** when they finish. Done is only available after Start.
3. **Reminder:** 2 hours before the due time, the member also gets a message. Google Calendar doesn't pass the organizer's reminder on to invited guests, so this message is the reminder that reliably reaches them.
4. **🟨 Yellow card:** if the task isn't done by the due time, the member gets a yellow card and 2 more hours.
5. **🟥 Red card:** if it's still not done after those 2 hours, the member gets a red card and an **extra turn** at the front of the next rotation. The task is closed as missed.
6. **⏳ Extra time:** the member can ask for more time, with an optional reason. The admins get an email, and the request appears at the top of the Admin tab (with a badge on the tab). An admin can **Refuse** it or **Add N hours** to the due time. If the due time has already passed, the hours are added from now instead.
   - If the member asked *before* getting a yellow card and the admin grants time after the card was given, the yellow card is withdrawn.
7. **Who is notified:** card notifications go only to the member and the admins. The card counts are visible to everyone on the **Schedule** tab, and cards also show on the task itself and in History.

Admins can also **reassign** an open task or change its due time, or **excuse** it (closes it with no card).

## Fun 🎉
**Fields:** name, rotation order (e.g. `Dad+Noa, Mom+Yuval, Dad+Yael, Mom+Noa, Dad+Yuval, Mom+Yael`), repeat every (days), and the coming event's time and place.

- There's always one **coming event**. Whenever they want, an admin can use **Update time & place** to change it, including who it's for. The people in that slot get an email and an updated calendar invite.
- Two hours after the event starts it counts as done. The next event is created automatically for the next slot in the rotation, *repeat every* days after the last one, at the same place by default.
- **Cancel this one** skips the current event and moves to the next slot. Fun activities never get cards.

## Screens
**My turns** (your tasks with Start / Done / Extra time, and your coming fun events) · **Schedule** (card counts, who's on now, who's next) · **History** · **Board** (shared notes) · **Admin** (admins only).

## How it's built
- **`docs/`:** the screens, a static web app hosted on **GitHub Pages** (`https://<user>.github.io/family-hub/`). This is what the phones open.
- **`apps-script/`:** the backend, a Google Apps Script bound to the Google Sheet. It stores the data, sends the emails and calendar invites, and runs the 15-minute check. The page talks to it as a JSON API.

Personal links look like `https://<user>.github.io/family-hub/#u=<token>`. The token goes after `#`, so it is never sent to GitHub. The phone also remembers it, so the home-screen icon keeps working.

## Setup (about 15 minutes, on a computer)
1. Create a new Google Sheet, for example "Family Hub".
2. **Extensions → Apps Script.** In the editor:
   - Replace the contents of `Code.gs` with `apps-script/Code.gs`. Then set `APP_URL` near the top to your GitHub Pages address.
   - **Project Settings → "Show appsscript.json"**, then paste in `apps-script/appsscript.json`. It sets the time zone to Asia/Jerusalem.
   - If an `Index.html` file is left over from the earlier version, delete it.
3. Select the `setup` function and click **Run**. Approve the permissions (Sheets, Calendar, send email, external requests, triggers). This creates the sheets, the "Family Hub" calendar, the 15-minute check and an `Admin` user.
4. In the **Users** sheet, rename `Admin` to your own name (do this before creating any activities).
5. **Deploy → New deployment → Web app.** Set *Execute as: Me* and *Who has access: Anyone*, then Deploy. Copy the **Web app URL** (it ends in `/exec`).
6. On GitHub, edit `docs/config.js` and paste that URL into `FAMILY_HUB_API`. GitHub Pages updates within a minute.
7. Run `printLinks`, then look in the Execution log. Open your own link on your phone.
8. In the app's **Admin** tab: add your wife as an admin, add the kids as members (each with an email, and with **Email** and **Calendar** ticked), then create tasks and fun activities. After that, **Personal links → Send via WhatsApp** to send each person their link.
9. On each phone, open the link and choose **Add to Home Screen** (Chrome menu on Android, Share menu on iPhone). It installs as an app with its own icon.

> **After changing `Code.gs`:** go to **Deploy → Manage deployments → Edit → Version: New version → Deploy**. This keeps the same `/exec` URL, so `config.js` doesn't need to change.

> **Upgrading from an earlier version:** the columns changed. Delete the `Activities` and `Turns` sheets (and `Chores` / `Tasks` if they're there), then run `setup` again. `Users` and `Board` are kept.

### If a phone still blocks it
Parental controls (Google Family Link, or Screen Time on iPhone) may block new sites. Approve `<user>.github.io` there:
- **Family Link:** Controls → Content restrictions → Google Chrome → Manage sites → Approved.

The page also has to reach `script.google.com` in the background, so approve that site too if calls fail.

### WhatsApp (optional)
Notifications go by email by default. To also send them over WhatsApp through [CallMeBot](https://www.callmebot.com/blog/free-api-whatsapp-messages/), a free third-party service:
1. On the member's phone, add the CallMeBot number (listed on the page linked above) to contacts.
2. Send it `I allow callmebot to send me messages`.
3. Enter the phone number and the API key you receive in **Admin → Edit member**, and tick **WhatsApp**.

## Notes
- **Each personal link works like a password.** If one leaks, replace that user's `token` cell in the Users sheet with a new random string and send them the new link.
- **Timing:** the check runs every 15 minutes, so a yellow or red card can arrive up to 15 minutes after the deadline. **Run check now** in the Admin tab runs it immediately.
- **The fixed rules** (2-hour grace, 2-hour reminder, fun events lasting 2 hours) are constants at the top of `Code.gs`.
- **Admins need email turned on**, because extra-time requests reach them through their notification settings.
- **Quotas:** Gmail allows about 100 emails a day from a free account, which is plenty for 5 people.
