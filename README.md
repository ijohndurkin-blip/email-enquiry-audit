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

## Telling real enquiries from other mail

Automated mail (newsletters, notifications, receipts, no-reply senders, account emails) is filtered by rules. Emails from real people about something else, such as suppliers, the accountant or friends, look like enquiries to the rules. Three tools deal with them:

1. **Untick it** on the Counted tab. Your ticks and unticks always win over the rules and the AI.
2. **Never count…** on any row. Choose the exact address, or everyone at that company's domain (not offered for Gmail, Hotmail and similar). The sender is added to the business's "Never count mail from" list, saved with the business and applied to every future audit. "Count again" undoes it.
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
| `lib/secret.js` | Encrypts and decrypts saved connections (AES-256-GCM) |
| `public/mailboxes.js` | Mailbox cards: test connection, saved connections, Sent folder choice |
| `lib/discover.js` | Finds IMAP settings from an email address (ported from the enquiry app); certificate-name retry, STARTTLS on port 143, lockout-safe sign-in |
| `lib/mailbox.js` | Read-only header fetch from the Inbox and Sent folders |
| `lib/build.js` | Groups mail into enquiries, filters junk and matches replies |
| `public/metrics.js` | Median reply times, working-hours maths and time spent, shared by the browser and the tests |
| `public/app.js` | The page |
