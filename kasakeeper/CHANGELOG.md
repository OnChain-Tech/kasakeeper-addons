# 0.3.24

Smaller than the last one, but one of these could have marked the wrong job done and paid for it.

## A trade's reply lands on the job it's actually about

If you'd emailed one tradesperson about **two** jobs on the same asset — a mower and a tree lopper on the garden, a panel cleaner and an inverter tech on the solar — their reply came from one address, so nothing could tell the two conversations apart. Whichever job happened to be stored first simply took the reply.

That wasn't only a mislabelled card. Confirming the date books it, and marking the booking done completes the job the *quote* names — so the wrong job got marked done at the wrong price, while the one you were really waiting on stayed overdue.

Now the reply's own words decide: "re the inverter job" goes to the inverter. When the words don't settle it — a bare "Tuesday works" — **nothing is changed at all** and you get a message asking which job it was about. Guessing here is worse than asking, so it asks. You'll hear about it once, not every couple of minutes.

## Electrical is a standard part of a house

Every home has a switchboard, so new homes now start with an **Electrical & switchboard** asset: an RCD push-button test every six months (yours to do, no cost) and a switchboard safety inspection every two years, which is the interval an electrician actually works to. Adding it to an existing home is a couple of taps under Assets.

## Fixes

- **A new home's cleaning schedule no longer assumes twice a week.** It defaulted to a clean every 3 days — the app's own "twice weekly" cadence — so a fresh home nagged constantly. It's weekly now, matching the House cleaning option the app offers first. Anyone who really does clean twice a week can still pick that.
- Removed a duplicate Vehicle category that silently overrode the first one.

# 0.3.23

The release for real user testing. Two things the app was quietly getting wrong about *your* house, and one that made a feature look broken.

## It scans the right mailbox folder now — and looks for your things, not just your tradespeople

"Scan my email for trades" reported nothing at all. It wasn't finding nothing; it was reading **zero messages**. Gmail's inbox is only a label, and the scan only ever looked there — so everything you'd archived was invisible to it. One mailbox here held 4 messages in the inbox and 51 in All Mail.

- **It reads All Mail.** Discovered from the server rather than assumed, so it still works on a Gmail account in another language, and falls back to the inbox rather than failing if it can't find it. Still strictly read-only: nothing is ever marked, moved or deleted.
- **It looks for the things a house *has*, not just the people who invoice it.** The old terms — quote, invoice, booking, tax invoice — are the vocabulary of a tradesperson's paperwork. They can't see something you simply bought. A spa bought once a decade arrives as "Your order has shipped", and no amount of searching for "invoice" will ever find it. The scan now also looks for spa, sauna, pool, heat pump, solar, irrigation, alarm and camera. Deliberately *not* included: generic shopping words like order, receipt and purchase — they'd find more, but every match is sent away for reading, and against a real inbox they'd sweep up your whole shopping history.
- **Receipts forwarded as attachments are read properly.** A receipt often arrives as a forwarded bundle rather than a plain message, and the old code saw those as empty. One household's entire spa history — supplier, model, a cover replacement and three years of chemical orders — was invisible for this reason alone.
- **A preview first, always.** The import screen now shows you what it *would* bring in before anything is written: which folder it read, how many messages each search matched, and what it found. Importing is a separate, deliberate second tap.
- **A loud search can't drown out a quiet one.** Results are gathered per search and interleaved, so a mailbox full of invoices can no longer crowd out the single message from the one tradesperson you actually use. If anything is dropped for size, it says so instead of silently truncating.

## Auto-book works again on a house with more than one trade

Ticking 🤖 auto on a job did nothing, silently, if *any* other quote was open on the same asset. On a garden with a mower, a lopper and an irrigation contractor, one open quote stopped all three. A quote now only holds back the job it was actually raised for. An older quote that doesn't name a job still holds back the whole asset — it can't say which job it covers, and guessing would email a tradesperson about work they're already quoting.

# 0.3.22

Seven defects an independent adversarial pass found and confirmed at the data layer, plus a follow-up pass that re-reviewed the fix batch itself and found four residual gaps in it — all reproducible, all invisible to the existing test suites, all fixed with a regression test that failed before the fix and passes after.

A **third** adversarial pass went over that fix batch again and found ten more defects (labelled A–J) built on top of an otherwise-sound sync engine — the field-level merge itself, the double-409 fix, and the base-snapshot degrade path all held up against a live server with real conflicts. All ten are fixed below with their own regression tests — see `docs/QA-STORIES.md` SY-8/SY-9 and SC-9 for the full, current guarantee.

- **The shared store merges field by field, not row by row — and now survives more than one conflict in a row.** With a second writer active — the quote-reply poller, auto-book, the daily digest, or just another device — tapping ✓ Done used to bank the cost but leave the task reading "735d overdue" forever, because a sync conflict let the server's whole row win over yours even when your edit was the newer one. Every action that updates an existing row now merges per field against a real base snapshot, so your edit survives — including a SECOND writer landing while the first conflict is still being retried, which used to lose the edit and the new log again, through a narrower door — and a sibling field the other side changed independently still keeps theirs. ↩︎ Restore on a snoozed task — previously silent — now sticks too.
- **A device re-link no longer reverts a sibling edit hiding inside the same field.** The merge above used to treat a whole nested object — an asset's `ha` (its Home Assistant link + watch list), `usage`, `recall`, `pack`, or a home's own `settings` — as ONE field, so re-linking a device on one screen while another device's fault scanner added a watch entry to the same asset meant one of the two was silently reverted (previously claimed fixed; it wasn't, for this shape). Those five known nested objects now merge one level deeper, so independent sub-field edits on both sides survive together. Still last-write-wins, not merged: two devices editing the exact same sub-field before either has synced, any nested object outside that documented list (a task's whole `fault`), and the list-shaped sub-fields inside them (`ha.watch`, `ha.entities`) — those stay whole-value by design, since a single action always rewrites them as a unit.
- **Tapping ✓ Done twice — the same device, or a second one — banks the job once.** The tablet and a stale phone both marking the same job done used to each write their own log with a random id, so the merge kept both and doubled the recorded spend for a single job. A done log's identity is now the task and the day it was done, so a repeat tap (or a second device that hadn't synced yet) converges on the same record instead of minting another one.
- **✓ Done on a task with a booking already pending settles that booking instead of logging a second job.** Marking a scheduled task done used to write a brand-new history row even when a trade's booking for that exact job was still sitting there pending — two entries for one job, the booking stuck "booked" forever, nagging as a slipped booking once its date passed, and able to bank the cost again if its own ✓ was tapped later. It now completes the pending booking in place: one record, the quote closes to "done", and nothing is left to double-bank. The ✓ Done prompt itself now defaults to that booking's real agreed price rather than the task's rough estimate, so accepting the pre-filled amount unedited no longer quietly overwrites the correct cost. (DEFECT C/F)
- **✓ Done can no longer settle the WRONG booking.** The fix above briefly used the same guesswork the dashboard uses to avoid showing a booking twice (a note/title overlap, or "the only other pending booking on this asset") to decide which booking a ✓ Done should complete — good enough for a display, not for a write. In the real shape, a taskless booking from Find-a-service (say, a $1,200 job) could get silently completed at whatever price and date you'd just ticked off on an unrelated task, its quote closed and the real job gone from Coming up with no undo. ✓ Done now only ever completes a booking it can point at with certainty (it names the task directly, or its quote does) — anything looser gets its own fresh history entry instead of a guess.
- **A second ✓ Done on the same job — a slipped (past-dated) booking especially — no longer banks the cost twice.** Re-tapping ✓ Done used to look for an already-settled booking by today's date, but a past-dated booking is deliberately left at its own date when it's completed, so the second tap never found it and quietly logged the job again. A repeat tap is now recognised regardless of the booking's own date, and clearing the cost field on that repeat tap no longer blanks an already-recorded real price, note, or trade.
- **Changing a booked job's date updates that one history entry, even after it's marked done.** 📌 Change date on a completed job used to add a second entry instead of updating the first, quietly doubling the recorded spend. Completing a job now closes its quote properly, and re-booking always finds and updates the same entry.
- **Picking one of a trade's offered dates now books the job properly.** Tapping a date used to set the quote to "booked" without writing anything to the asset's history — invisible on Coming up and impossible to ever mark done. Both ways of booking (picking a date, or the full booking form) now produce the same job-history record.
- **A trade's offered date is read properly, not guessed at.** "Tue 12 Aug, morning" (free text off an email reply) used to fail a silent ISO check and get booked as *today* instead — the card said 12 Aug, the history said today, and it nagged as an overdue booking up to two weeks before the trade was actually due. Offered dates are now genuinely parsed (day names, "12 Aug", "Aug 12", "12/08", day-first) and the job history lands on the real day. When it truly can't be read, nothing is booked and nothing is guessed — you're taken to 📌 Book with what the trade wrote shown above the date field, to pick it yourself.
- **A quote with nothing to book against can no longer be booked into a dead end.** A quote whose asset had gone missing (or was never set) used to flip to "booked" while writing zero history — invisible on Coming up, and with no ✓ Done ever possible for it. Booking now refuses until a real asset is attached; 📌 Book offers a picker for exactly this case.
- **Typing 0 for an agreed price is honoured, and clearing the price now means the same thing everywhere.** A warranty callout or goodwill job with no charge used to silently record the original quoted amount instead — real money the household never spent. Leave the field alone and it still keeps the shown price; type 0, or clear the field entirely, and it's recorded as $0 — the booking form's "Agreed price" now says so and matches the ✓ Done prompt's own "leave as-is or clear it if there was none" instead of the two disagreeing on what an empty field means.
- **A job that's overdue AND has a pending booking no longer shows up twice — including the common case where the booking never named a task.** "Needs attention" used to only catch the duplicate when the booking happened to carry the task's own ID; a quote born from Find-a-service or the enquiry email never sets one, so that overdue task and its own slipped booking rendered as two separate rows and summed to more money than the job actually cost (a $300 task + a $420 booking read as $720 "overdue" for one $420 job). It's now one row everywhere, and the hero's overdue count and its "$Y overdue" figure always describe the exact same jobs. A booking that covers a task and is dated in the FUTURE now also removes the task's own row (instead of leaving both the row and a phantom "0 overdue, $X owing" mismatch) — but the booking itself still shows up under Coming up, so a booked-ahead job is never invisible. (DEFECT A/B)
- **A typed Location is never silently discarded.** If Home Assistant resolves an area while you're still typing a location by hand, your typed value used to vanish on save with no warning. It's now kept as your value; the field only locks itself to Home Assistant's own answer when that's genuinely what's governing it — and if Home Assistant is unreachable rather than just missing an area, the hint now says so instead of the misleading "no area set".
- **A typed Location also survives a background area refresh, not just a save.** Tapping away from the Location field without focusing another input (so it's blurred but nothing else is "typing") used to leave a periodic Home Assistant area refresh free to repaint the whole screen from the store and wipe out what you'd just typed — no warning, same as the save-time version of this bug (previously fixed) but through the redraw path instead. Both the redraw and the same-home patch now check the field for unsaved text first.
- **"$X next 90 days" means the next 90 days.** It used to include years-old overdue backlog and miss every booked job entirely. It's now scheduled work plus confirmed bookings due in the window, nothing older · a separate "$Y overdue" figure carries the backlog instead of hiding inside it.
- A booked job whose date has quietly passed now shows up in Needs attention and its cost enters spend once you mark it done — nothing nagged about these before.
- An HA-linked asset whose Home Assistant is unreachable right now gets its own honest hint instead of being told there's "no area set" — the two are different problems with different fixes.
- An asset's History header count now matches the rows actually listed beneath it.
- A failed write (or a corrupted read) of the device's own sync snapshot now degrades to "no snapshot", same as a fresh install — not a stale one that would have quietly kept winning every future merge with old data.
- **Which home you're viewing is now yours, per device.** Switching homes on one device used to be able to silently switch BACK on the next sync — the server's last-known "current home" won outright, so a new asset or provider could get filed under the wrong house with no warning, and the sync's own conflict-recovery visibly jumped the screen to a different home mid-use. Home selection is now remembered per device, not fought over between them; a home this device had selected that's since been deleted elsewhere falls back sensibly instead of vanishing. (DEFECT G)
- **A failed push is reported as a failure, not silently read as success.** `_pushNow()` used to treat any HTTP response that wasn't a `409` as a clean save — a `400`, a `5xx`, or a network error surfacing as some other status went unnoticed. It now only reports success when the response is genuinely OK, so a caller waiting on a save before deleting local data no longer acts on a push that never actually landed (DEFECT J).

A **fourth** pass over the same ✓ Done path found the prefill it hands to the price prompt could itself go stale, and that the chat assistant's own "mark done" tool was a second, unhardened writer of the same record. Both are fixed below against the same shared definition of what completing a job means, not patched separately again.

- **A second ✓ Done on a job no longer offers to silently downgrade its real price to the rough estimate.** Once a booking was settled, the ✓ Done prompt's pre-filled amount stopped looking at what was actually recorded and fell back to the task's generic estimate — accepting that pre-filled value unedited on a re-tap (the common case) quietly rewrote a real price (say $450) down to the estimate (say $180), with no undo. The prompt now always defaults to whatever was actually logged, and a re-tap on a job already marked done today is labelled honestly as updating that price, not logging a fresh one.
- **Marking a job done from the chat assistant now behaves exactly like tapping ✓ Done.** The chat tool used to be a separate path that ignored a job's real booked price, never closed the booking or its quote, and — because it left no trace that it had run — a later completion of the same job (through chat again, or the ✓ Done button) couldn't find its own work and logged the job a second time. It now settles the same booking, closes the same quote, and recognises a same-day repeat exactly like the button does.
- **A job settled long after its booking slipped now banks its cost in the right year.** A booking that had been pending for months or years and only just got marked done used to keep its original (long-past) date, so the money quietly filed itself under a calendar year that had already closed. It's now dated as of the day it was actually marked done whenever that crosses into a new year; a booking that only slipped by a few weeks within the same year still keeps its own date, unchanged.
- **The dashboard now shows what you've spent this year**, alongside the existing "next 90 days" and "overdue" figures, once you've logged your first job.

A **fifth** pass, aimed specifically at the chat assistant's own write endpoint (`/api/chat/apply`), found its arguments were passed straight from the model to the shared store with no validation at all.

- **The chat assistant completing a job with no price now records $0, not the task's rough estimate.** It used to silently bank the task's estimated cost as if it were the real spend the moment you asked it to log a job without mentioning a price — feeding "$X this year" a number nobody actually paid. The confirmation you approve now says so plainly ("no cost recorded", or the actual amount), and you can add the real price afterwards with a second ✓ Done.
- **The chat assistant can no longer be talked into a nonsense or future completion date.** "Tomorrow", a typo'd date, or a date that hasn't happened yet used to be written straight into the task's history, which either broke its "overdue" display outright or silently kept a genuinely overdue task — a smoke alarm, a gas check — looking fine for years. It now asks again if the date isn't real or hasn't happened yet; backdating a job into the past still works as before.
- **The chat assistant no longer drops the connection when handed a garbage price.** A non-numeric amount ("N/A", a stray list) used to crash the request outright with no message reaching the app. It now asks again instead — and a negative, absurdly large, or otherwise bogus number is refused rather than quietly recorded.

## Security · a quote's reply token is no longer a password

- **Someone who learns a quote's reply code can no longer speak for your trade.** Every enquiry KasaKeeper sends carries a short code in the subject line so replies find their way back to the right job. That code travels to the trade, to everyone they copy in, and to anyone the thread is ever forwarded to — and it was being treated as proof of identity. A stranger holding one could set that job's price, and put their own address behind the Reply button, so your booking confirmation and every later email went to them, shown in the app under your trade's real name. The code now only routes a reply; the sender still has to be someone we already know for that job — the address we wrote to, another mailbox at the same firm, or your own address when you forward mail in. Genuine replies are unaffected.
- **One reply can't be counted twice.** A trade answering about two jobs on the same asset in one email had it applied to both quotes, so both showed the same price and the total double-counted.

## Who does each job — a trade per task, not per asset

Some assets genuinely need more than one trade. A garden has a mower and a tree lopper; solar panels need a cleaner *and* a technical pro. The app could already store that — a task's own provider has always beaten the asset's — but every way of *setting* one was attached to the asset, so households ended up with one trade per asset whether that was true or not.

- **Find a service, run from a job, now searches for that job.** Starting from "Clean solar panels" searches for panel cleaners rather than for "Solar + battery", which finds installers. Whoever you pick is saved against that job, leaving the asset's own trade alone — and the quote that comes out of it knows which job it belongs to.
- **The asset page says who does each job.** Every maintenance row names its own trade, with a quiet "(default)" on the ones falling back to the asset's. Tap the name to change it without opening the full edit form. A job nobody's assigned to offers "who does this? →" rather than just reading blank.
- **The asset-level trade is now labelled as what it is** — the default used when a job doesn't name its own. Nothing moved and nothing needs redoing: an asset with one trade, and jobs that don't override it, behaves exactly as before.
- **A quote raised for one job can no longer be hijacked by another.** Found while reviewing the above: searching from a second job on the same asset used to grab the quote already in flight for the first, repoint it, and swap its trade — and because a booking finds its job through that link, the wrong job would get marked done and paid for while the real one stayed due. Each job now keeps its own quote, a second job raises its own instead of stealing one, and the asset page shows both rather than hiding one.
- **Every job's row shows its own quote.** With two quotes possible on one asset, the schedule and dashboard rows showed whichever came first — so the inverter row could carry the panel cleaner's price, and its "manage" button opened the wrong quote.
- **Deleting a job no longer strands the quote raised for it.** The quote survives with its price and its email thread intact, and reattaches to the asset instead of pointing at a job that no longer exists.

# 0.3.21

Four fixes from using the app on real bookings.

- **A booked job's date can be changed.** A booked quote now offers 📌 Change date · the trade rings to move Thursday to the week after and you just re-confirm. The job history updates in place instead of gaining a second entry, and your calendar event moves rather than duplicating.
- **Confirm a trade's offered date without emailing them.** Tapping an offered date books it locally; sending a confirmation is a separate, explicit choice. A date already agreed on the phone or in your own inbox no longer forces a redundant email at the trade.
- **"Find suppliers" only shows when it's the next step** · it's gone from booked jobs and from quotes that already have a trade attached.
- Outbound emails now use house punctuation throughout.

# 0.3.20

- **Research now hunts the actual manual, not just a link to a page about it.** Looking up an asset strongly prefers the manufacturer's direct PDF — and when the first find is only a support page, it spends one more focused search hunting the PDF itself. Result: manuals Ask can actually read, instead of app-style pages with no readable text.
- **A found PDF is saved to your house automatically.** No more remembering to tap ⤓ keep a copy — a direct-PDF manual is fetched onto your own box the moment research finds it (with the same safety checks as the manual button), so a dead link later can't take it from you.
- **Never someone else's manual.** A manual for a near-identical sibling model (say, a TA60SS offered up for your TA90SS) is now rejected outright — both by the research itself and by a server-side check on the link — because a wrong manual is worse than none.
- Honest labelling when only a page exists: the lookup now says whether it found the PDF or just the product page, so nothing pretends to be more than it is.

# 0.3.19

- **Confirm a booking without emailing anyone.** The booking screen now offers two clear actions · **✓ Confirm booking** records the job and sends nothing, and **✓ Confirm & send confirmation** also drafts the email for your approval. A job you agreed on the phone is now one honest tap; the send option only appears when there's actually an address to send to.
- **Put it in your calendar.** Confirming can send you a real calendar invite (a proper iCalendar event, so Gmail offers "add to calendar" and it lands with the date, time, trade, address and agreed price). It goes to your own inbox, works with either confirm button, and re-confirming updates the same event instead of making a second one. All-day when no time was agreed, rather than inventing 9am.

# 0.3.18

- **Levels, beds and baths are gone.** They were manual entry nothing could verify and nothing downstream used · the research no longer asks for them, the home form no longer offers them, and Ask no longer receives them. Any values already saved are simply left alone and ignored; nothing is deleted from your data.

# 0.3.17

- **Ask now reads the manual before it answers.** Questions about an asset are grounded in its actual documentation: the saved copy in your vault wins, otherwise the asset's manual link is fetched — a PDF is consulted directly (and quietly saved to the vault for next time), a support page has its readable text extracted and cached for a week. Assets with a manual on file get a 📖 chip on grounded answers; assets without one get an honest "no manual on file" rather than a guess.
- **Contact changes suggested in chat now wait for your ✓.** Because chat context can carry text from third parties, an Ask-suggested change to a provider's email, phone, or website is held as pending until you confirm it — same as sending an enquiry.
- Under the hood: every URL the server is asked to fetch — stored manual links, saved documents, and the reachability probe behind order links on consumable faults — now goes through one hardened fetcher that refuses private and internal addresses even when a public-looking hostname points at them, re-checks every redirect, and bounds how much it reads.
- **The user guide caught up.** It now covers the first-run key wizard, per-home Home Assistant modes, locations coming from HA, the quote loop as it actually works (including forwarding a trade's reply from your own inbox), device watch, and Ask's starter questions.

# 0.3.16

- **Home Assistant knows where things are, so KasaKeeper stops asking.** An asset linked to an HA device now shows that device's area — on the asset, in lists, on task cards — labelled 📍 via Home Assistant. Move a device to another room in HA and KasaKeeper follows, with no import and no editing. Things HA can't know about (a wall, the gutters, a garden bed) keep their typed location, and an asset falls back to it whenever HA has no area, is unreachable, or the home isn't connected.

# 0.3.15

Hardening release · a new fuzzing suite went looking for trouble and found seven real bugs.

- **Ask and the morning brief can no longer be taken down by one bad row.** A single malformed entry anywhere in your assets used to crash them for the whole home; malformed rows are now skipped, and the sync endpoint refuses to store them in the first place.
- **A trade's malformed email can no longer stall the quote poller** for every other quote.
- **Amounts are sane or absent**: a nonsense figure parsed out of an email no longer becomes an infinite number, and nothing ever renders as "$nan".
- Under the hood: the test suite grew from ~91 checks to 170 offline plus 51 API checks, all running automatically on every commit, with a staging environment and a release gate between main and your house.

# 0.3.14

- **No more system pop-ups.** Every confirmation and every "how much did it cost?" now uses KasaKeeper's own dark (or Paper) dialog instead of the browser's grey OS box · twenty of them, from marking a job done to erasing everything. Destructive choices are labelled and red ("Delete asset", not "OK"), Escape and a tap outside both cancel, and Enter accepts. On the wall tablet a system dialog looked like the app had crashed; now it looks like the app.

# 0.3.13

Security and correctness pass over the quote email loop, from a full review of this week's releases.

- **Only the real trade can fill in your quote card.** Reply matching is now a true ladder (exact sender → the address we wrote to → their domain), every hit is verified against the message's real sender rather than a header substring, free-mail domains are never used as a domain match, and a message already belonging to another quote's thread is left alone. A stranger who knows the KasaKeeper mailbox address can no longer stage a quote, a price, or their own address behind the Reply button.
- **Quote tokens are validated** before they ever reach the mail server, and rejected at the store boundary.
- **One reply, one notification** · a busy moment can no longer turn a single trade reply into a burst of duplicate pushes.
- **Replying no longer rewinds a quote**: sending an in-app reply on a priced quote keeps the price and the state instead of dropping it back to "awaiting reply".
- Amounts parsed out of email are coerced properly ("$250" no longer becomes $0), and email-derived text is length-bounded everywhere it's stored or shown.
- New offline test suite `tools/test-quote-matching.py` covers seventeen matching and parsing cases, including the attack scenarios above.
# 0.3.12

- **Restarting an address search can't be hijacked by the first try**: if you rerun the Create-a-Home research while a slow earlier attempt is still thinking, the old attempt's late answer is now dropped instead of overwriting the new one.

# 0.3.11

- **The watch picker now looks at the whole appliance, not just the linked device**: an Eight Sleep "Side" is the device your asset links to, but "needs priming" lives on the pod's hub · discovery now follows the device family (hub ↔ sides) so those sensors show up in the picker instead of "No problem sensors found".

# 0.3.10

- **Device watch finds shy sensors too**: some integrations report problems as plain True/False sensors instead of proper binary sensors (Eight Sleep's "needs priming", a dishwasher's "salt low") · the sensor picker now offers those as watchable fault candidates instead of "No problem sensors found". Healthy-when-True sensors (has water, is priming) are left out so they can't raise a task that never clears.

# 0.3.9

- **Worn part? The order link is on the card**: when a device reports a consumable running out (brushes, filters, bags), KasaKeeper finds the exact replacement part's real product page for your model and puts a tappable 🛒 Order link right on the task · manufacturer's store first, validated before it lands.

# 0.3.8

- **Your devices can now raise their own hand**: an HA-linked asset can watch its device's problem sensors · bin full, fault codes, filter life. When one trips, a task lands on that asset ("reported today"), and one tap drafts the enquiry email with what the device is saying · every send still approved by you. Pick the sensors from the asset page under Device watch.

# 0.3.7

- **Times survive messy threads**: when a trade corrects themselves ("13:00 tomorrow" · "sorry, that is Thursday"), the offered date now lands as the corrected day with its time attached · "Thu 30 Jul 1:00 PM", not just "Thursday".

# 0.3.6

- **Ask knows what to ask**: the empty Ask screen now offers twenty starter questions in six groups · Right now, Money, Assets & warranties, Trades & quotes, Make changes, and (when connected) Live house. Chips adapt to your data — quote questions only appear when there are quotes to talk about.

# 0.3.5

- **Forward a trade's email and KasaKeeper reads it**: trades often reply to your personal inbox instead of the enquiry thread · forward that email to the KasaKeeper mailbox and the quote fills itself in on the next check, with the reply address kept as the trade's, not yours.

# 0.3.4

- **Reply matching got three tiers**: exact sender, the address the enquiry went to, then anyone at the trade's domain (with a job-mail relevance check so newsletters can't pose as replies) · catches the trade who answers from a different mailbox with a fresh subject.

# 0.3.3

- **Follow-ups without the tracking token are heard too**: when a trade sends a fresh email instead of replying (dropping the [KK-] subject token), KasaKeeper now also checks recent mail from their known address · Breezy's date offer is exactly this case.

# 0.3.2

- **KasaKeeper watches the whole conversation now**: replies keep being read until the job is booked · a trade who quotes first and offers dates in a second email no longer goes unheard.
- **Payments are read too**: a mentioned deposit shows on the card as "✓ $X paid · receipt #N · $Y owing" · recorded facts, never actions.
- **Reply without leaving**: quote cards gained an in-app ✉︎ Reply that keeps the tracked thread (and your approval step) · no more bouncing to a mail app.
- **Book from anywhere**: a phone-confirmed job books straight from the reply-in card · 📌 Book captures date and time, the confirmation email stays optional.

# 0.3.1

- **Trade replies now surface properly**: a reply that isn't a clean quote (a dispute, a question, "need to see it first") flips the card to a blue **reply in** state with the summary, a one-tap Log quote and a direct ✉︎ Reply · no more cards stuck on "awaiting reply" after the trade has answered. Existing stuck cards repair themselves on the next mail poll.
- **Proposed costs and dates are decisions, not facts**: the quote card leads with the number on Book it and adds ✎ Change; date offers stay one-tap confirmable. Every processed reply now pushes to your phone · a priced quote leads with the amount.
- **Idle devices stay fresh**: the wall tablet reconciles with the shared store every 3 minutes, so quote updates appear without touching it.

# 0.3.0

The multi-home release · KasaKeeper now works for houses beyond the one it runs in, and for households beyond the first.

- **Every home gets its own settings**: suburb, "due soon" window and notification target now live per home, with your existing global values still honoured as the fallback.
- **Every home picks its Home Assistant**: this add-on (as always, zero setup), a different Home Assistant (URL + long-lived token, kept server-side only), or none at all · schedules stay calendar-only and nothing nags about a connection that isn't there. Drift detection, weather, the daily brief and usage tracking all follow each home's choice.
- **First-run key wizard**: a new install now walks you through getting and testing each API key · Anthropic (research, snap, ask, recalls), Google Places (richer find-a-service) and Gmail (quote emails) · straight from the setup screen or Settings. Keys are tested against the real service before saving, stored on the server only, and never shown back.
- **Safer by construction**: pasted remote-HA URLs are strictly validated (private, loopback and cloud-metadata addresses rejected; connections pinned to the vetted IP; redirects refused), and the find-a-service fallback no longer carries any location baked into the source.
- For developers: CONTRIBUTING.md is new · zero-build philosophy, dev setup and the cache-bump rule, ready for the project's first outside contributor.

# 0.2.3

- Last of the punctuation pass: the start-tracking banner and the push-test result now use the house `·` instead of em-dashes, and the Cc-me helper text reads as a proper muted note.

# 0.2.2

- **One design language everywhere**: the full-UI consistency pass lands — Find-a-service, Add-a-service, the edit forms, Snap, Triage and every legacy sub-section (snoozed tasks, quote lists, correspondence, asset packs) now speak the same instrument row language as the rebuilt screens. Status is always colour *plus* text, every tap target clears 44px, helper notes read as notes, and the setup banners sit flat on the surface in both themes.
- **Assets list tells you why**: the bare status dot is now a labelled pill ("3d overdue" · "ok"), and empty states offer the next tap instead of a dead end.
- **Under the hood**: dead code removed across the stylesheet, app and server; the three vault-serving endpoints share one guarded helper; dev tools no longer ship inside the add-on image.
- Hygiene for the public add-on repository: the owner's street address is scrubbed from source — the offline research stub, the address-field placeholder and prompt examples are now generic.

# 0.2.1

Five roadmap items land at once — built in parallel by the big-feature fan-out, each reviewed and verified in its own thread.

- **The re-research sweep lives on the server now**: close the tab, walk away — it keeps going, every device watches the same live progress, and proposals appear everywhere as each asset finishes. Skip and Stop are server calls; a reloaded page reattaches automatically.
- **Scheduled recall sweep**: once a month (capped and staggered) every make/model asset is checked against ACCC Product Safety and the manufacturer. A found recall lands on the asset with the remedy and source, adds a morning-brief line until you tap "OK, seen", and there's a manual "Run recall sweep now" in Settings → Developer.
- **Registry drift detection**: KasaKeeper now notices when Home Assistant disagrees with an asset (firmware moved, device vanished, new hardware appeared) — a Settings banner and a morning-brief sentence point you at the import screen; nothing changes without your approval, and vanished devices get a clean Unlink.
- **Smarter import**: cars are cars now (climate + odometer + tracker → 🚗 Vehicle, metered by energy), and a smart lock can never overwrite a non-lock asset — the proposal that tried to turn a timber front door into an August lock is structurally impossible.
- **Distribution pipeline**: `tools/publish-dist.sh` assembles the complete public add-on repo, verified by `tools/verify-dist.sh` — one push from shipping to the first external user.

# 0.2.0

The roadmap milestone release — R1 through R4 of the original plan are complete, so the minor version steps up per the versioning policy.

- **Vehicles are first-class assets**: a 🚗 Vehicle category with a sensible default schedule (annual service, tyre rotation & pressure, rego renewal). Born from importing a real Tesla Model X from Home Assistant — it arrived metered by its own lifetime-energy sensor.
- Roadmap refreshed: R1–R4 shipped; the live backlog is distribution, the scheduled recall sweep, HA drift detection, and import-filter tuning.

# 0.1.9

- **Watch the sweep work**: re-research now shows a live feed of what it finds per asset ("✓ Gutters — 3 tasks proposed · manual found") and a **⏭ Skip this one** button that moves on in under half a second. Stop also takes effect immediately.
- **Edit your home's facts**: address, levels, beds and baths are now correctable on the current home's Settings card — research proposes, you dispose.

# 0.1.8

The MOAT release — KasaKeeper talks to the hardware. QA-tested end to end (the LG-battery → Tesla Powerwall case is the acceptance test, and it passes).

- **Import from Home Assistant** (Settings → Home Assistant): KasaKeeper reads HA's device registry — the real manufacturer, model and serial of what's physically on the wall — and proposes new assets or field-level corrections to existing ones (make: LG → Tesla). You approve each item; a manual edit is never overwritten, even mid-race with another device.
- **Auto-linked telemetry**: imported assets (new *and* corrected) arrive with their usage entity already wired — service by real run-hours or kWh from day one, no entity ids typed. The Track-usage screen also gained a picker with a one-tap best-guess match.
- **Live readings** on the asset page for HA-linked assets.
- **Setup is a landing page**: the first screen now sells and teaches — brand hero, how-it-works, feature strip — with Google **address autocomplete**, a **test-home** option, and **quick add** (type assets one per line; research fills in the rest).
- **Test-home mode**: keep a friend's house or a demo without touching your Home Assistant — no live data, no weather nudges, no morning brief. Pick a street-view/aerial **photo for each home**, shown on the dashboard and in Settings.
- **Suburb is per-home now**: adding a second home no longer hijacks the first one's service searches. Each home keeps its own search location; the Settings field edits the home you're in.

# 0.1.7

Six parallel work-streams land at once — R2/R3/R4 roadmap features, each built and reviewed in its own thread.

- **Recall & safety check**: any asset with a make/model can be checked against ACCC Product Safety and the manufacturer ("🛡 Check for recalls"); a found recall becomes an urgent task with the remedy and source link, one tap.
- **Seasonal windows**: seasonal jobs (aircon, pool, gutters, heating) wear a "before summer"-style chip as their season approaches. Display-only — no due dates moved.
- **Ask, grounded in your real telemetry**: the assistant now sees your usage-tracked assets' live entity states and shows chips for what grounded each answer. Destructive actions (complete, snooze, reduce a pack) are now proposed, not executed — you confirm each one in the chat.
- **Trades rebuilt** in the instrument language (railed rows, provider logos, lifetime spend) + **warranty claim helper**: in-warranty assets get "🛡 Claim warranty" — a prefilled claim letter with model, serial and dates, approved by you before it sends.
- **Settings rebuilt** in the instrument language.
- **Sync that can't eat your work**: a version conflict now merges by entity instead of adopting the server copy wholesale — local additions survive, and deletions carry tombstones so a stale device can't resurrect them.
- **Inspection report import**: feed it a building/pest inspection PDF and the defects become schedule items you approve one by one.
- **Home logbook export** (Settings → Data): a branded PDF of the whole house — assets, service history, spend.
- **Distribution pack**: DOCS.md for the add-on's Documentation tab, install README, store artwork, and a quickstart for the first Melbourne install.

# 0.1.6

The transparency release — you can now SEE what KasaKeeper is doing, and correct it.

- **The search query is always visible**: Find a service shows exactly what it's searching for ("3D printer repair and maintenance") with a one-tap "wrong? edit the asset" escape hatch.
- **Developer drawer** (Settings → Developer): a live device-local panel showing the data behind every action — search queries, research payloads, results. Built for "tell Claude exactly what's wrong".
- **Live progress in API searches**: research and find jobs report their real stages as they run — including the actual web searches Claude performs ("Searched "Bambu X1C maintenance schedule"…").
- **Re-research all assets** (Settings → Data): reprocess existing assets with the current research smarts — older assets keep old guesses. Results wait as "✦ research ready" proposals; nothing changes without your Apply.
- **Asset-level DIY**: mark a whole asset as yours — "no service provider linked" now offers "mark it DIY". DIY assets stop nagging for suppliers everywhere.
- **Back button fixed**: ‹ Back now climbs the screen hierarchy (task → asset → assets → home) instead of replaying history — no more edit-task loops. The URL hash stays a shareable deep link.
- Fixed a crash on a provider profile with an open quote.

# 0.1.5

- **Find a service searches for the actual asset**: tapping find on a limestone wall now queries "Limestone wall repair and maintenance", not the category's generic trade (which sent gutter cleaners to a stone wall). A "Trade to call" override on the asset still wins verbatim.
- **User guide**: a full guide ships with the app — linked at the bottom of Settings, works offline.

# 0.1.4

- **Assets list rebuilt**: railed rows with brand-logo tiles in category groups; the Warranties tab gets status rails and mono pills (expired / days left). Untracked assets keep their honest hollow dot.

# 0.1.3

- **Schedule rebuilt** in the instrument language: railed rows grouped by who's on the hook (Needs a supplier · Awaiting a quote · Assigned · DIY), one context action per row (book / call / manage quote / find / DIY), status pills, brand-logo tiles. Editing, snoozing and deleting live one tap away on the asset page.

# 0.1.2

The "Every asset knows itself" release (roadmap R1), plus the full UI rebuild groundwork.

- **Snap 2.0**: photograph a nameplate → identify → maker research auto-runs → one-tap Apply for the manufacturer's schedule.
- **Feature lookup**: any asset with a make/model can fetch its real specs, the manufacturer's maintenance schedule, and the manual (Claude + web search, apply-on-approval).
- **Document vault (first slice)**: "keep a copy" fetches the manual PDF onto the add-on's own storage — survives dead links, opens on every device.
- **Provenance**: tasks tuned from the manual carry a "maker's interval" marker, and run-hour intervals convert straight into the live usage threshold ("42 / 150 hrs · maker's").
- **Brand logos** on every asset tile (make → logo, emoji fallback).
- **Two themes**: Night (wall tablet) and Paper (desktop), per-device choice in Settings → Appearance.
- **Rebuilt screens**: dashboard as an instrument (gauge, segmented status bar, railed rows, quote chips, date-rail) and the asset page in the same language.
- **DIY jobs**, quotes on the dashboard, honest quote cards, 13 UX-audit fixes, ~30 security/correctness hardenings, `ownerName` email sign-off setting.

# 0.1.1

- The KasaKeeper eye-house mark as the sidebar icon (custom `kk:` iconset).

# 0.1.0

- Initial add-on: research-a-home onboarding, schedules, trades CRM with approved-email quote loop, Home Assistant live data + usage tracking, morning brief.
