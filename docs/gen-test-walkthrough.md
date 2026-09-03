# IBC Scheduler — 5-minute test walkthrough

This uses a **safe sandbox** (fake people: *Alex Rivera*, *Sam Chen*, *Courtney Remekie*) so nothing touches the real IBC schedule. You just need **two browser tabs**. Passphrase for the admin side: **test**.

- **Staff app:** `staff-scheduler.compass-xsc.workers.dev/?event=demo-test`
- **Admin app:** `staff-scheduler.compass-xsc.workers.dev/admin.html?event=demo-test`

---

## Part 1 — A shift change, start to finish

**Tab 1 (staff — pretend you're Alex):**
1. Open the **staff app** link → **My Schedule** → type **Alex Rivera** → pick it.
2. On Alex's Friday shift, tap **Request change**.
3. Under **Ask**, choose **Courtney Remekie** → **Submit request**.
4. You'll see **"Sent to Courtney to accept"** — and under your schedule, **"Your change request: … waiting for Courtney to respond."**

**Tab 2 (staff — pretend you're Courtney):**
5. Open the **staff app** link again → **My Schedule** → type **Courtney Remekie** → pick it.
6. At the top you'll see **"Alex Rivera asked you to cover …"** with **Accept / Decline**.
7. Tap **Accept**. It says it's been sent to the admin to confirm.

**Tab 3 (admin — you, Geneliz):**
8. Open the **admin app** link → unlock with **test**.
9. Under **Shift change requests** you'll see Alex's request (Courtney accepted) → tap **Approve**.
10. Done — the shift is now Courtney's. It shows under **Recently applied**.

👉 Back in **Tab 1 (Alex)**, the status now reads **"covered by Courtney ✓."**

*(Nothing changes the schedule until you tap Approve — that's the point.)*

---

## Part 2 — What happens on a decline

1. In **Tab 1 (Alex)**, request a change again and **Ask Courtney**.
2. In **Tab 2 (Courtney)**, this time tap **Decline**.
3. In **Tab 1 (Alex)**, the status now reads **"Courtney declined — ask someone else."** Alex can pick a different person, and it never hits your admin queue.

---

## Part 3 — Phone alerts (optional, do this on your phone)

So your phone buzzes when something needs you:
1. On your iPhone, open the **admin app** link in **Safari**.
2. **Share** ⬆️ → **Add to Home Screen** → **Add**.
3. Open it from the **home-screen icon**, unlock, tap **Enable phone alerts → Allow**.
4. Now do Part 1 from your laptop — when Courtney accepts, your phone buzzes.

Staff do the same on the **staff app** link to get their "you've been asked to cover" buzz.

---

## Notes
- This is the **sandbox** — reset anytime, real data is untouched.
- For the real event, drop `?event=demo-test` from the links (they default to IBC 2026).
- Questions → ping Courtney.
