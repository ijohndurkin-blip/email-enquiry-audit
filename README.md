# Enquiry Audit

Reads a business's enquiry mailboxes and shows:

- how many enquiries came in
- how quickly they were answered, in clock time and in working hours
- how many got no reply
- when enquiries arrive
- how much time the business spends on them

Use it to get a "before" baseline for a case study, then run it again after the [enquiry app](https://github.com/ijohndurkin-blip/rare-email-enquiry) goes live to show the difference.

It works with any email host that supports IMAP: cPanel and most UK hosting, GoDaddy, IONOS, 123 Reg, Hostinger, Zoho, Gmail with an app password, and others. You enter the email address and password, and it finds the server settings itself.

## What it does and doesn't touch

- **Read-only.** Mailboxes are opened in read-only mode (IMAP `EXAMINE`), so nothing is marked as read, moved or deleted.
- **Headers only, with two exceptions.** It reads sender, recipient, subject, date and the reply-chain headers, and never downloads attachments. The exceptions:
  - A website-form email with no reply-to address has its first 60 KB read, only to find the customer's email address.
  - With AI sorting turned on, the first lines of each possible enquiry are read and sent to the AI (see below).
- **No database.** Results stay in your browser until you download them. Passwords are never logged or sent back.
- **Saved connections are encrypted.** When a mailbox connects, the server sends back an encrypted token, and your browser keeps that instead of the password. The token can only be opened by this deployment's server, using a key made from `AUDIT_ACCESS_KEY`. If you change the access key, saved connections stop working and each mailbox needs connecting again. Saved audit files never contain tokens or passwords.
- **Locked with an access key.** Without `AUDIT_ACCESS_KEY` set, the API refuses every request, so nobody else can use your deployment to try passwords against mail servers.

## Deploy on Vercel

1. In Vercel, choose **Add New → Project** and import this repository. Leave the framework preset as **Other**, and leave the build command and output directory empty.
2. Under **Settings → Environment Variables**, add `AUDIT_ACCESS_KEY` with a long random value, such as the output of `openssl rand -hex 24`.
3. Deploy, open the site and enter the access key at the top of the page. The page remembers it in that browser.

`AUDIT_ACCESS_KEY` is the only variable needed. To turn on AI sorting (below), also add `ANTHROPIC_API_KEY` with a key from [console.anthropic.com](https://console.anthropic.com/settings/keys). The AI uses Claude Opus 5.5 by default; set `AUDIT_AI_MODEL` to use a different model. You can optionally add `AUDIT_ENCRYPTION_KEY` to encrypt saved connections with a separate key, so changing the access key doesn't sign you out of saved mailboxes.

The audit function is allowed to run for up to 60 seconds (`vercel.json`). Two mailboxes covering 30–60 days usually take 10–30 seconds.

## Running an audit

1. **Business and mailboxes.** For each address enquiries arrive at (for example `enquiries@` and the owner's own address), enter the email and password and press **Test connection**.
   - It finds the server, signs in read-only, counts the emails in the inbox and finds the Sent folder.
   - Once connected, the mailbox shows a green tick, and the business is saved on this browser under **Saved businesses**. Next time, pick it from the list and everything is already connected.
   - If a mailbox has no Sent folder, choose the right folder from the list on its card.
   - An email sent to both addresses is counted once.
   - Under *More options*, list any other address the business replies from, such as a personal Gmail, so those replies are matched too.
2. **Period.** The default is the last 30 days. Tick *Compare with a second period* to see before and after side by side.
3. **Working hours and time spent.** Reply times are shown both in clock time and in opening hours only, so an enquiry sent at 9 pm and answered at 9 am the next day doesn't look like a 12-hour wait. Email can't show how long someone spends on each enquiry, so enter the average minutes per enquiry. Time 10–20 enquiries with a stopwatch to get it.
4. **Review.** Check the *Counted* and *Not counted* tabs. Untick anything that isn't a real enquiry, and tick anything that was wrongly left out. The numbers update immediately.
5. **Keep it.** Use **Save audit file** to keep a copy you can reopen later (passwords are never saved), **Download spreadsheet** for a CSV, or **Print / PDF** for the case study.

Save the "before" audit file straight away. If the business later deletes or archives old emails, re-running the before period won't give the same numbers.

## Tracking companies before and after the enquiry app

With Supabase connected, every company you set up is saved in your Supabase. Their mailboxes, settings and every audit you run are available from any browser that has the access key.

**Set-up (once):** in Vercel → Settings → Environment Variables, add the following, then redeploy:

| Name | Value |
|---|---|
| `SUPABASE_URL` | `https://jrtrsiptbfeueosfpnrw.supabase.co` (the "Rare2 Invoice Processor" project) |
| `SUPABASE_SECRET_KEY` | Supabase dashboard → Project Settings → API Keys → a **secret** key (`sb_secret_…`). The legacy `service_role` key also works. |

The tables `audit_companies` and `audit_runs` already exist in that project. They have row-level security turned on with no public access, so only this tool's server, using the secret key, can read them; the publishable key and the invoice app's users can't. Never put the secret key in browser code. Mailbox passwords are stored only as encrypted tokens that need this deployment's `AUDIT_ACCESS_KEY` to open. Companies previously saved in a browser are moved across automatically the first time.

**Using it:** pick a company under **Companies**, enter the date the enquiry app went live (or will), and the **Before-and-after checks** card lists:

| Check | Period |
|---|---|
| Before the app | the 30 days before go-live (run it before go-live; it's the baseline) |
| Week 1 / Week 2 | days 1–7 / 8–14 after go-live |
| Month 1 / Month 2 / Month 3 | days 1–30 / 31–60 / 61–90 |

Each check shows **Ready to run** once its period has ended, or **Due …** before then; **Run so far** runs it early. Every run is saved, so ticking/unticking, AI sorting and the AI summary are saved too. **Open** brings it back, and **Run again** replaces it. Checks are compared automatically with the saved "Before" audit. The Summary tab gets a **Progress so far** table and the Charts tab a **Progress since go-live** section, both of which print in the PDF. For time saved, use "Minutes per enquiry before the app" and "Minutes per enquiry with the app".

Audits you run with your own dates are saved as "Other saved audits". Without Supabase, companies are saved in the browser as before and nothing is tracked over time.

## The results

Results open in three tabs, written for business owners rather than analysts. **Print / PDF** prints all three in order, with your logo, a link to www.raresquaredlabs.co.uk and a dated footer.

- **Summary**
  - **At a glance:** four checks, each with a plain-English verdict: Good, Could be better, Needs attention, or Worth knowing. They cover reply speed, enquiries without a reply, enquiries arriving when closed, and back-and-forth emails. These are worked out from the numbers, so they don't need AI.
  - **In plain English (AI, optional):** a headline, "What's going well", "What needs attention" and "What could help". **Only the totals and percentages are sent to the AI**, never emails, names or addresses. It's written automatically after an AI-sorted audit, or with the **Write a summary** button. If you tick or untick enquiries afterwards, it offers to update.
  - The before/after table, the case-study paragraph and hours saved.
- **Charts**
  - how quickly enquiries got a reply
  - which days and what times enquiries arrive, with opening hours shaded
  - enquiries each week
  - website form versus direct email

  Each chart has a one-line takeaway, numbers on the bars, details when you hover over a bar, and a "Show the numbers" table. When comparing periods, "Before" is blue and "After" is cyan. These colours were checked so people with colour blindness can tell them apart, in both light and dark mode.
- **Enquiries:** the Counted and Not counted lists, with ticking and "Never count…".

## Replies that went astray, and enquiries the audit can't see

- **Replies sent to the business's own address:** replies are matched by the customer's address *and* by the email reply chain (In-Reply-To / References). If the business pressed Reply on a website-form notification, the reply goes to the website's own address, not the customer. That reply is shown as **"Reply went to your own address"**, and "At a glance" flags **Replies that never reached the customer**. A reply that reached the customer at a different address of theirs is counted normally.
- **Possible missed enquiries:** if the business replied to someone ("Re: …") whose original enquiry isn't in any audited mailbox, they're listed on the Summary tab. The enquiry usually came in another way: another email address, a website form or forwarding that doesn't send to this mailbox, or it was deleted.
- **Other folders:** by default the audit also reads Archive and the business's own folders, not only the inbox, so filed enquiries are found. It skips Sent, Drafts, Trash, Spam and Gmail's "All Mail". You can turn this off under More options.
- **Reply quality** judges the first reply against **everything the customer sent before it**, including subject lines, because the question is often only in the subject.

## Downloads

The **Download** menu above the results has four files:

| File | What's in it |
|---|---|
| **Enquiries summary (CSV)** | One row per enquiry: dates, reply times, where it stands, outcome, reply quality, AI check, reason if not counted. |
| **Enquiries with emails (CSV)** | **Just the counted enquiries** (what's ticked on the Counted tab), one row each with the summary columns plus three text columns: **the customer's enquiry** (every email they sent before the first reply, with subjects), **the business's first reply**, and **the rest of the conversation** (each email labelled Customer/Business with date and subject). The easiest file for reading through enquiries in Excel. |
| **Conversations with email text (CSV)** | Every enquiry (counted and not), one row per email in it: customer emails and business replies **with their full text**, plus the quality score and tip on the first reply. Use it to check the scoring and see what's really being said. |
| **All emails with text (CSV)** | **Every email the audit read**, received and sent, with its full text and **what the audit decided about it**. For example: counted as enquiry #12, not counted (newsletter, receipt…), customer follow-up, business reply, duplicate, internal, sent but not a reply to any enquiry, or before the period. Filter on "What the audit decided" to spot enquiries the tool missed. |

Email text is read live from the mailbox, read-only, when you download, and goes straight into the file. It isn't saved anywhere else, so the files contain customers' emails and should be kept private. The two text downloads need the mailbox to be connected. "All emails" is only available straight after running an audit, because the per-email list isn't kept in saved audits.

## Quality of replies (AI, optional)

With AI turned on, each counted enquiry's **first reply from the business** is checked against five plain questions:

1. Answered their question?
2. Gave a price or a clear next step (quote, visit time, booking)?
3. Asked for what's needed (phone number, address, photos) or gave an easy way to book or call?
4. Friendly and professional?
5. Clear and easy to read?

Each reply gets a score out of 5 and a one-line tip.

How the verdict works:
- **The two checks that win work decide it.** "Good" needs an average of 4 or more **and** at least 80% of replies answering the question and giving a price or next step. Polite replies that don't answer can't score "Good".
- **Small samples:** under 5 replies there's no verdict ("too few to judge yet") and it gives counts, e.g. "1 of 2 didn't answer the question". Under 10 it's called a rough guide and still uses counts.
- **Real patterns only:** a missing check is only mentioned when at least 2 replies and 20% of them missed it.
- **Holding replies:** if the first reply is a quick "thanks, we've got your enquiry" and the real answer follows within a day, the AI judges both together. Reply speed is still measured from the first one.
- A **chase** (for "went quiet") means a follow-up sent at least about a day after the business's reply; a holding reply plus the answer doesn't count. The report shows the average score, the check most often missed ("At a glance"), a badge on each enquiry, the five ticks and crosses in **View**, a before-and-after comparison, and a "Quality of replies" progress chart. It runs automatically after AI sorting, or later with **Check reply quality** (the mailbox must be connected).

**What's sent:** the customer's first email and the business's first reply, read live from the mailbox, with quoted history trimmed and up to about 2,000 characters each. Only the scores and tips are kept.

## Estimating "minutes per enquiry before the app"

After running the **Before the app** audit, press **Work out "before" from the emails** in section 3. It reads the business's real replies (up to 40 enquiries spread across the period) and estimates the time each took by hand:

| Part | Rule |
|---|---|
| Reading the customer's emails | 240 words a minute |
| Writing the replies (thinking + typing) | 20 words a minute, with quoted text and the sign-off/signature left out |
| Admin per reply (opening, sending, switching tasks) | +1 min |
| The work behind a reply, judged by AI from its content | +2 min if it quotes prices · +8 for a worked-out quote (sizes, quantities, several items) · +2 for dates, times or stock · +2 for a technical answer |
| Attachments (from the email itself) | +3 min |
| Mostly a standard / copy-paste reply (AI) | writing counts 30% |

It fills in the box with the average and shows the breakdown, how often each kind of work came up, and the rates used. Each enquiry's estimate is in the summary CSVs. Without AI it uses word counts only. Only the minutes and short notes come back from the server; no email text is kept.

It's an estimate: emails can't show phone calls or time spent thinking before writing. To make the figure solid for a case study, time 3–5 replies with a stopwatch and adjust it if needed. It's meant for replies written **by hand**, so run it on the Before audit; for the "with the app" figure, see the README's suggestion to log handling time in the enquiry app.

## Follow-ups, outcomes and existing customers

**Where each enquiry stands** is worked out from who emailed last:

| Status | Meaning |
|---|---|
| No reply found | The business never emailed back. |
| Waiting for your reply | The customer's latest email hasn't been answered. |
| In progress | Last email was from the business, less than 3 days ago. |
| Went quiet: not chased | The business replied, the customer went silent for 3+ days, and the business sent no follow-up. |
| Went quiet: chased | As above, but the business sent at least one follow-up. |

These feed "At a glance" (*Following up when customers go quiet*, *Customers waiting on you*), the figures, the AI summary and the progress over time.

**Outcomes:** email can't show whether a customer rang up and bought. On the Enquiries tab, mark each enquiry **Won** or **Lost** when you know. The report shows how many became work and the win rate. Outcomes are saved with the audit.

**Existing customers:** under *Existing customers*, paste the business's customer list or import a CSV. Any rows with an email address work, and a name is optional. Enquiries from those addresses are tagged **Existing customer**, and the report shows how many were new. Marking an enquiry **Won** adds that person to the list automatically. The list is saved with the company.

**View:** opens an enquiry's emails, customer and business side by side. They're read live from the mailbox, read-only, only when you click, with quoted history trimmed. Nothing is saved. It needs the mailbox to be connected, and works for audits run since this feature was added.

**Always skip** (on each row) stops counting a sender, or a whole company domain, in this and future audits.

## Telling real enquiries from other mail

Automated mail (newsletters, notifications, receipts, no-reply senders, account emails) is filtered by rules. Emails from real people about something else, such as suppliers, the accountant or friends, look like enquiries to the rules. Three tools deal with them:

1. **Untick it** on the Counted tab. Your ticks and unticks always win over the rules and the AI.
2. **Always skip** on any row. Choose the exact address, or everyone at that company's domain (not offered for Gmail, Hotmail and similar). The sender is added to the business's "Never count mail from" list, saved with the business and applied to every future audit. "Count again" undoes it.
3. **AI sorting (optional).** Tick *Use AI to check which emails are real enquiries* before running. Each email the rules counted is sorted by Claude into one of: new enquiry, about a job already booked, supplier or trade, personal, sales pitch, automated, spam or other. Anything that isn't a new enquiry moves to Not counted with the AI's reason, so you can tick it back.
   - **What's sent:** the sender's name and address, the subject, whether the business replied, and the first ~800 characters of the customer's latest message, with quoted history removed. Emails the rules already filtered out are never read or sent. Nothing is stored by this tool. Anthropic's commercial terms cover how API data is handled; by default it isn't used to train models.
   - **What it costs:** a few pence per audit. It runs in batches of 15 at low effort.
   - **Better results:** fill in *What the business does* (e.g. "Plumber in Liverpool: boilers, bathrooms, leaks").
   - If the AI declines a batch, Anthropic's server-side fallback re-runs it on another model. If the AI fails, the rule-based results stay and you can press **Check with AI** to try again.

## When a mailbox won't connect

Every failed test shows the reason, with a **What it tried** list of each step.

| Message | What to do |
|---|---|
| *The mail server rejected the password* | Sign in to webmail with exactly the same details to check them. Gmail, Yahoo, iCloud and Zoho with two-step sign-in need an **app password**. Some hosts want only the part before the @ as the username: enter that under Server settings. It stops after the first server that refuses the password, so the host doesn't lock the mailbox. |
| *The security certificate is for server42.hostco.com, not mail.yourdomain.co.uk* | Common on cPanel and shared hosting. It retries with the name on the certificate automatically. If that doesn't work, press **Use server42.hostco.com**, or, for a host you trust, **Allow this certificate and try again**. |
| *Couldn't find the mail server automatically* | Open Server settings and enter the incoming (IMAP) server from the host's email set-up page or webmail help, usually `mail.yourdomain.co.uk`, port 993, SSL on. |
| *This port doesn't offer encryption* | Use port 993 with SSL on. The tool never sends a password unencrypted. |
| *Couldn't connect … timed out* | Wrong server name or port, or the host blocks connections from outside the UK or from cloud servers. Ask the host to allow IMAP access. |
| Microsoft 365 / Outlook.com | Microsoft has mostly switched off password sign-in for IMAP. Use a forwarding mailbox or an export instead. |

## How it counts

- **Enquiry:** a conversation with one customer email address. A customer who writes again after 14 quiet days, without replying to an earlier email, starts a new enquiry.
- **Website-form emails:** form emails sent from `wordpress@`, `no-reply@`, Wix, Squarespace or the business's own domain are credited to the customer address in Reply-To. If there's no Reply-To, it reads the form email's text for the customer's address. Only if no address is found is the email counted without a reply time.
- **First reply:** the first email any audited mailbox sent to that customer address after their enquiry. Replies are read from each mailbox's Sent folder.
- **Left out automatically, unless the business replied:**
  - newsletters (`List-Unsubscribe` headers)
  - no-reply and notification senders
  - receipts and invoices
  - out-of-office replies and other auto-replies
  - bounces
  - mail the server marked as spam
  - mail from the business itself
  - website and system notifications (WordPress, form plugins)
  - account and service emails from companies like Google, Microsoft, PayPal or your web host (lead sites like Checkatrade are deliberately not on this list)
  - senders on your "Never count mail from" list
- **Conversations already under way:** if a conversation started before the period, or the customer was replying to an email the business sent first, it appears under *Not counted* with that reason.
- **Phone replies** can't be seen, so "No reply found" may include some enquiries that were answered by phone.

The definitions match the enquiry app's dashboard ("typical reply time" there is the same median first-reply time), so the numbers compare like for like.

## Measuring the "after" with the enquiry app

The enquiry app sends replies from the business's own mailbox and files a copy in the Sent folder on hosts that don't do this automatically. That means this audit sees replies sent through the app in the same way as replies Darryn types himself. After the app has been running for a month:

1. Open the saved "before" audit file, or run the before period again.
2. Tick *Compare with a second period* and set the after dates.
3. Enter the new minutes per enquiry. Time a few checks of the app's drafted replies; auto-sent replies take close to zero.

Hours saved per month = enquiries per month after × (minutes before − minutes after) ÷ 60.

## Development

```bash
npm install
npm test                               # counting rules, metrics, API
AUDIT_ACCESS_KEY=test npm run dev      # http://localhost:3000
```

| Path | What it is |
|---|---|
| `api/connect.js` | Vercel function: tests a mailbox and returns an encrypted saved-connection token |
| `api/audit.js` | Vercel function: checks the access key, reads the mailboxes, builds the enquiries |
| `api/status.js` / `api/classify.js` | Reports whether AI sorting is on / sorts a batch of up to 20 emails with Claude |
| `lib/ai.js` | The AI prompts (sorting and plain-English summary) with JSON-schema structured output |
| `api/summary.js` | Writes the plain-English summary from the audit totals (no email content) |
| `public/charts.js` | The charts, in plain HTML/CSS with no library, so they print cleanly |
| `api/store.js` / `lib/store.js` | Saved companies and audits in Supabase (server-side, secret key) |
| `api/thread.js` | Opens one enquiry's emails on request (read-only, nothing stored) |
| `api/effort.js` / `lib/effort.js` | Estimates minutes per enquiry from the replies' length and the work behind them |
| `api/quality.js` | Checks the quality of first replies with AI (scores and tips only are returned) |
| `lib/bodies.js` | Reads specific emails' text from a mailbox on request (read-only) |
| `lib/secret.js` | Encrypts and decrypts saved connections (AES-256-GCM) |
| `public/mailboxes.js` | Mailbox cards: test connection, saved connections, Sent folder choice |
| `lib/discover.js` | Finds IMAP settings from an email address (ported from the enquiry app); certificate-name retry, STARTTLS on port 143, lockout-safe sign-in |
| `lib/mailbox.js` | Read-only header fetch from the Inbox and Sent folders |
| `lib/build.js` | Groups mail into enquiries, filters junk and matches replies |
| `public/metrics.js` | Median reply times, working-hours maths and time spent, shared by the browser and the tests |
| `public/app.js` | The page |
