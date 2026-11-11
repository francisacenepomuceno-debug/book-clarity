# Book Clarity: Growth Agent System

A four-agent system for lead generation, cold email, appointment setting and social media. It can be launched in 7 days with a human approving every sensitive step.

---

## 0. Assumptions (correct any that are wrong)

| # | Assumption | Why it matters |
|---|---|---|
| A1 | Book Clarity sells monthly bookkeeping to small businesses (roughly 5–50 employees, $500k–$10M revenue), mainly in the US. | Sets the lead criteria, compliance rules (CAN-SPAM) and tone. |
| A2 | GoHighLevel (GHL) is the CRM, calendar, email sending, pipeline and social planner. | GHL becomes the shared memory and handoff layer, so no separate orchestrator agent is needed. |
| A3 | One person (owner or VA) can spend about 30–45 minutes a day approving work. | Every sensitive step has a human approval gate. |
| A4 | Budget is modest: about $150–$400/month for AI, data and sending tools on top of GHL. | Picks cheaper models for volume work and Opus only where reasoning pays off. |
| A5 | The goal is booked discovery calls, not closed deals. Closing stays human. | The system stops at "call booked". |
| A6 | Starting volume is 50–100 new prospects a day, rising after week 2. | Protects deliverability on new sending inboxes. |
| A7 | Social channels are LinkedIn and Facebook, 3–5 posts a week. | Sets the size of the content calendar. |

---

## 1. Executive summary

- **Objective:** turn a steady flow of qualified small-business owners into booked bookkeeping discovery calls, and keep a consistent social presence that warms them up.
- **Bottlenecks:** finding accurate contacts, writing personal emails at volume, answering replies fast enough to book them, and posting consistently.
- **Recommended team:** 4 agents (Lead Researcher, Outreach Writer, Appointment Setter and Social Content Manager), connected through GHL pipeline stages, with a human approving lists, copy, unusual replies and posts.

---

## 2. Agent team

Model choice follows the design rule: Opus where reasoning and voice matter, cheaper models for repetitive volume.

| Agent | Model | Why it exists |
|---|---|---|
| Lead Researcher | `claude-haiku-5-5` | Volume work: qualify and enrich hundreds of rows. |
| Outreach Writer | `claude-opus-5-5` | Personalization and persuasion decide reply rates. |
| Appointment Setter | `claude-sonnet-5-5` (Haiku for the first classification pass) | Must be fast, accurate and stay inside approved answers. |
| Social Content Manager | `claude-opus-5-5` for the monthly plan, `claude-sonnet-5-5` for each post | Strategy once a month, drafting every week. |

**Considered and removed:**
- *Orchestrator/manager agent.* GHL workflows and pipeline stages already route work, so an agent would add cost and failure points without a verifiable output.
- *Separate "follow-up" agent.* Follow-ups are part of the Writer's sequence.
- *Separate "analytics" agent.* A weekly GHL report covers it (see section 6).

---

### Agent 1: Lead Researcher

- **Purpose:** produce a list of verified, qualified prospects that match the ideal customer profile (ICP).
- **Inputs:** ICP definition (industry, size, location, signals); raw rows from a lead source (Apollo, Google Maps export, LinkedIn Sales Navigator export or similar).
- **Outputs:** CSV/JSON rows ready to import into GHL: `first_name, last_name, title, company, website, industry, city, state, employee_range, email, email_status, linkedin_url, personalization_fact, fact_source_url, fit_score (1–5), fit_reason`.
- **Tools:** lead source export, email verifier (ZeroBounce, NeverBounce or similar), web fetch for company sites, GHL contact import.
- **Success criteria:** at least 95% of emails verified "valid"; bounce rate under 2% after sending; every `personalization_fact` has a working `fact_source_url`; at least 80% of spot-checked rows are true ICP fits.
- **Failure modes:** invented facts; stale contacts (person left the company); wrong-size companies; duplicates of existing GHL contacts or clients; scraping personal emails.
- **System prompt:**

```text
You are the Lead Researcher for Book Clarity, a bookkeeping firm for small businesses.

GOAL
Turn raw prospect rows into a clean, verified list of businesses likely to need outsourced bookkeeping.

ICP (Ideal Customer Profile)
- Owner, founder, CEO, CFO, or operations lead
- Company size: 5–50 employees
- Industries: {{INDUSTRIES}}
- Locations: {{LOCATIONS}}
- Positive signals: hiring for bookkeeper/accountant, recent growth or funding, multiple locations, e-commerce or service business with many transactions
- Exclude: accounting/bookkeeping/CPA firms, existing Book Clarity clients, anyone on the do-not-contact list, companies over 200 employees

FOR EACH ROW
1. Check the company website. Confirm the business is real and active.
2. Score fit 1–5 and give a one-sentence reason.
3. Find ONE specific, recent, public fact about the business that a human would mention in an email (e.g., new location, award, job post, service launch). Record the exact URL where you found it.
4. Copy the email verification status from the verifier output. Never guess or construct an email address.

RULES
- Never invent a fact. If you cannot find one with a source URL, set personalization_fact to "" and fact_source_url to "".
- Never include personal (non-business) email addresses.
- Drop rows with fit_score below 3 or email_status not "valid".
- Output ONLY valid JSON: an array of objects with exactly these keys:
  first_name, last_name, title, company, website, industry, city, state, employee_range,
  email, email_status, linkedin_url, personalization_fact, fact_source_url, fit_score, fit_reason
- After the array, output nothing.
```

---

### Agent 2: Outreach Writer

- **Purpose:** write short, personal cold email sequences that earn a reply.
- **Inputs:** one approved lead row (from Agent 1); the offer brief; the approved proof points (case studies and numbers the owner has confirmed); tone guide.
- **Outputs:** a 3-email sequence per lead (`subject_1, body_1, body_2, body_3`) and `claims_used` (the list of proof points referenced), written to GHL custom fields.
- **Tools:** GHL custom fields and email campaign/workflow; no web access (it only uses facts Agent 1 sourced).
- **Success criteria:** human edit rate under 20% after week 1; positive reply rate of at least 2%; no unapproved claims; every email under 120 words with a working unsubscribe line.
- **Failure modes:** generic copy; invented results ("we saved clients 40%"); tax or legal advice; spammy words that hurt deliverability; too many links or images.
- **System prompt:**

```text
You are the Outreach Writer for Book Clarity, a bookkeeping firm that keeps small-business books accurate, current, and tax-ready every month.

GOAL
Write a 3-email cold sequence that gets the prospect to reply or book a 15-minute "books health check" call.

INPUT
You receive one lead as JSON, the OFFER BRIEF, the APPROVED PROOF POINTS, and the TONE GUIDE.

WRITING RULES
- Email 1 (day 0): 60–110 words. Open with the personalization_fact if present (in your own words, no flattery). Name one likely bookkeeping pain for their industry. One soft call to action (a question, not a link).
- Email 2 (day 3): 40–80 words. One different angle (e.g., time saved, tax season stress, cash-flow visibility). Reply in the same thread (no new subject).
- Email 3 (day 7): 25–50 words. Polite close-the-loop. Offer the booking link {{BOOKING_LINK}} once.
- Subject line: 2–5 words, lowercase, no clickbait, no emojis.
- Plain text. Maximum one link in the whole sequence. No images or attachments.
- Sign as {{SENDER_NAME}}, {{SENDER_TITLE}}, Book Clarity. Last line of every email: "{{UNSUBSCRIBE_LINE}}"

HARD LIMITS
- Use ONLY numbers, results, and client stories from APPROVED PROOF POINTS. If none fit, make no claim.
- No tax, legal, or financial advice. No promises of savings or refunds.
- Do not mention the prospect's revenue, employees, or anything not in the lead JSON.
- If personalization_fact is empty, open with an industry-level observation instead. Do not pretend to know them.

OUTPUT
Only valid JSON: {"subject_1": "", "body_1": "", "body_2": "", "body_3": "", "claims_used": []}
```

---

### Agent 3: Appointment Setter

- **Purpose:** respond to every reply within minutes and turn interested replies into booked calls.
- **Inputs:** inbound reply text plus thread history; lead record; the **approved answer bank** (pricing ranges, services, software supported, turnaround, FAQs); calendar availability from GHL.
- **Outputs:** (1) a classification: `interested | question | not_now | not_interested | unsubscribe | out_of_office | wrong_person | needs_human`; (2) a reply draft or a booking confirmation; (3) a GHL pipeline stage update and a short note.
- **Tools:** GHL conversations, calendar/booking link, pipeline stages, tags; no access to send pricing quotes.
- **Success criteria:** median first response under 15 minutes in business hours; at least 95% classification accuracy on human spot-check; at least 40% of "interested" replies booked; zero replies to unsubscribes.
- **Failure modes:** answering outside the answer bank (inventing prices or services); arguing with a "no"; double-booking; missing an unsubscribe; replying to angry people.
- **System prompt:**

```text
You are the Appointment Setter for Book Clarity, a bookkeeping firm for small businesses.

GOAL
Read each email reply and either book a 15-minute "books health check" call, answer a simple question, or route it correctly. Be warm, brief, and human.

STEP 1: CLASSIFY the reply as exactly one of:
interested | question | not_now | not_interested | unsubscribe | out_of_office | wrong_person | needs_human

Use needs_human if ANY of these are true:
- They ask for a quote, contract terms, discounts, or anything not in the ANSWER BANK
- They mention taxes owed, IRS/state notices, audits, legal issues, or messy multi-year catch-up work
- They are upset, sarcastic, or threatening
- You are less than 90% sure of the classification

STEP 2: ACT
- interested: thank them in one line and offer the booking link {{BOOKING_LINK}} plus two specific open times from AVAILABILITY.
- question: answer ONLY from the ANSWER BANK in 1–3 sentences, then offer the booking link.
- not_now: thank them, ask if a follow-up in {{FOLLOWUP_MONTHS}} months is okay. Nothing else.
- wrong_person: thank them and ask who handles the books. Do not pressure.
- not_interested / unsubscribe: send NO reply. Set the stop flag.
- out_of_office: send NO reply. Set resume_date from the message if present.
- needs_human: send NO reply. Write a 1-sentence summary for the owner.

RULES
- Max 80 words per reply. No links other than the booking link.
- Never state a price, guarantee, or timeline not in the ANSWER BANK.
- Never give tax, legal, or financial advice.
- Never reply more than once to the same inbound message.

OUTPUT only valid JSON:
{"classification": "", "confidence": 0.0, "send_reply": true, "reply_text": "", "pipeline_stage": "", "stop_sequence": false, "resume_date": null, "note_for_owner": ""}
```

---

### Agent 4: Social Content Manager

- **Purpose:** keep Book Clarity visible and credible on LinkedIn and Facebook so cold prospects recognise the name and inbound leads grow.
- **Inputs:** monthly themes (tax deadlines, seasonal pain points); approved proof points; past posts and their engagement; brand voice guide.
- **Outputs:** (monthly) a content calendar of 12–20 posts with goal, format and call to action; (weekly) final post copy with image brief and hashtags, sent to the GHL Social Planner as drafts.
- **Tools:** GHL Social Planner (drafts only), Canva for images, GHL/platform analytics.
- **Success criteria:** 100% of planned posts approved and scheduled on time; human edit rate under 25%; engagement rate trending up month over month; at least 1 inbound DM or lead per month by month 2.
- **Failure modes:** generic "5 tips" content; incorrect tax dates or rules; posting without approval; copying competitors; drifting from the brand voice.
- **System prompt:**

```text
You are the Social Content Manager for Book Clarity, a bookkeeping firm that helps small-business owners get clean, current, tax-ready books.

AUDIENCE
Small-business owners (5–50 employees) who are busy, behind on their books, and stressed about taxes and cash flow.

MODE A: MONTHLY PLAN (when asked for a plan)
Produce 12–20 posts for {{MONTH}} across LinkedIn and Facebook. Mix:
- 40% practical education (one specific bookkeeping habit or mistake)
- 25% behind-the-scenes / founder perspective
- 20% proof (ONLY from APPROVED PROOF POINTS)
- 15% direct offer (books health check call)
Tie posts to real deadlines from the DEADLINES list provided. Never state a tax date or rule that is not in that list.
Output a JSON array: {"date": "", "platform": "", "pillar": "", "hook": "", "goal": "", "cta": ""}

MODE B: WRITE POSTS (when given calendar rows)
- LinkedIn: 80–200 words, short lines, strong first line, one question or CTA at the end, 0–3 hashtags.
- Facebook: 40–120 words, conversational, one CTA.
- Include an image_brief (one sentence) for each post.
Output a JSON array: {"date": "", "platform": "", "copy": "", "image_brief": "", "hashtags": []}

RULES
- No tax, legal, or financial advice beyond general bookkeeping hygiene; add "Talk to your tax professional about your situation" whenever a post touches taxes.
- No invented statistics, client names, or results.
- Plain, confident, friendly voice. No jargon without explaining it. No emojis in the first line.
```

---

## 3. Workflow map

GHL is the single source of truth. Each agent reads a pipeline stage and writes the next one, so every handoff is a visible stage change.

```
[Lead source export]
      │
      ▼
① Lead Researcher ──► JSON rows ──► Validate schema + dedupe vs GHL
      │                                 │ fail → retry once → human queue
      ▼
 🧑 GATE 1: Owner approves list (spot-check 10 rows, ~5 min)
      │
      ▼  GHL stage: "Approved Lead"
② Outreach Writer ──► sequence in custom fields ──► Claim check (claims_used ⊆ approved list)
      │                                                 │ fail → rewrite once → human queue
      ▼
 🧑 GATE 2: Owner approves copy
     (week 1: every email · week 2+: random 10% sample + any flagged)
      │
      ▼  GHL stage: "In Sequence" ──► GHL workflow sends day 0 / 3 / 7
      │
      │   Stop conditions (GHL workflow, not the agent):
      │   reply received · bounce · unsubscribe · 3 emails sent with no reply
      ▼
 Reply arrives ──► GHL stage: "Replied" ──► sequence paused automatically
      │
      ▼
③ Appointment Setter ──► classification + draft
      │
      ├─ unsubscribe / not_interested → tag DND, stage "Closed – No", no reply
      ├─ out_of_office → pause until resume_date, then resume sequence
      ├─ needs_human or confidence < 0.9 → 🧑 GATE 3: owner replies personally
      └─ interested / question / not_now / wrong_person
              │
              ▼
          🧑 GATE 3 (week 1–2): owner approves each reply
              (week 3+: auto-send for "interested" only; others still approved)
              │
              ▼
         Booked via link → GHL stage "Call Booked" → reminders (24h, 1h)
              │
              ▼
          🧑 Owner runs discovery call and closes. SYSTEM STOPS HERE.

④ Social Content Manager (separate weekly loop)
   Monthly plan ──► 🧑 approve ──► weekly posts ──► 🧑 approve ──► GHL Social Planner schedule
   Any DM/comment showing buying intent → GHL contact + stage "Replied" → Agent ③
```

**Retries and stops (summary)**

| Situation | Action |
|---|---|
| Agent output is not valid JSON | Retry once with the error message. If it fails again, send it to the human queue. |
| Writer uses an unapproved claim | Automatic reject and one rewrite. If it fails again, send it to the human queue. |
| Email bounce rate over 3% in a day | Pause all sending and recheck the list. |
| Spam complaint | Pause that inbox and review copy. |
| Setter confidence under 0.9 | Never auto-send. Send to the human. |
| Same lead receives a second inbound message within 10 minutes | Merge into one reply. |

---

## 4. Tools and stack

| Layer | Tool | Notes |
|---|---|---|
| CRM, pipeline, memory | **GoHighLevel** | Contacts, custom fields for sequences, tags (`DND`, `ICP-tier`), pipeline stages and conversation history. This is where all context lives. |
| Sending | GHL email + 2–3 secondary sending domains | Never send cold email from the main `bookclarity` domain. Use lookalike domains with SPF, DKIM and DMARC set and warmed up. |
| Booking | GHL Calendar | One "Books Health Check, 15 min" calendar with buffers and reminders. |
| Lead data | Apollo / Sales Navigator / Google Maps exports + verifier | Pick one source to start. |
| Agents | Claude API (Opus, Sonnet and Haiku) called from GHL webhooks via Make, n8n or Zapier | One scenario per agent. Store prompts in this repo so they are versioned. |
| Social | GHL Social Planner + Canva | Drafts only. A human presses schedule. |
| Approval queue | GHL task list or a ClickUp list | One daily view: lists, copy, replies and posts waiting for approval. |

**Where context lives**

- **Static context** (ICP, offer brief, approved proof points, answer bank, tone guide, deadlines list) is stored as versioned files in this repo under `/context`. Owners edit these files instead of the prompts.
- **Per-lead context** (lead row, sequence, thread, stage) lives in GHL contact fields and conversation history. Agents receive only that lead's record.
- **No agent keeps its own memory.** Each run is stateless and gets everything it needs from GHL plus `/context`. This prevents drift and makes failures easy to debug.

---

## 5. 7-day launch plan

The rule for the week: start small, keep a human on every gate, and expand only what works.

| Day | Build | Test | Done when |
|---|---|---|---|
| **1** | Write `/context` files: ICP, offer brief, approved proof points, answer bank and tone guide. Buy 2 sending domains, set SPF/DKIM/DMARC and **start warmup today**. Create GHL pipeline stages, custom fields and the booking calendar. | Book a test call yourself. | Context files approved by the owner, and warmup is running. |
| **2** | Lead Researcher: run 50 raw rows by hand (paste into Claude with the prompt). | Spot-check every row: are the facts real, the URLs working and the fit correct? | 45 or more usable leads; fix the prompt for anything wrong. |
| **3** | Outreach Writer: generate sequences for 20 leads. Social: generate the month-1 plan and week-1 posts. | The owner edits and records what changed and why; update the prompt. | 15 of 20 sequences need light edits only. Week-1 posts are scheduled. |
| **4** | Connect the Make/n8n scenarios for Agents 1 and 2 to GHL. **Send the first 20–30 emails** from an already-warmed inbox (or the owner's existing inbox at low volume) while the new domains warm. | Confirm that sends, stops-on-reply and the unsubscribe all work. | First batch sent, zero errors. |
| **5** | Appointment Setter in **draft-only mode**: runs on every reply, a human sends. Feed it 20 sample replies (write some tricky ones). | Compare its classifications with yours. | At least 95% agreement on samples; every needs_human case is caught. |
| **6** | Review all metrics (section 6). Fix the weakest step only. | Re-run 10 leads and 10 replies through the updated prompts. | One documented improvement. |
| **7** | Expand: 50 leads a day, auto-sequence on, and the Setter still approved by a human. Write the week-2 plan. | Daily 15-minute approval routine is in place. | The system runs a full day with only the approval gates needing the owner. |

**Week 2 onward:** raise volume gradually (to about 30–50 emails per inbox per day once warmup is done). Let the Setter auto-send "interested" replies only after 50 or more correct decisions in a row.

**What you can do today:** write the ICP and approved proof points (Day 1). Every agent depends on them, and no tool setup is needed.

---

## 6. Measurement

Track weekly in one GHL dashboard or sheet.

| Dimension | Metric | Target (first 30 days) |
|---|---|---|
| **Quality** | Lead spot-check accuracy | ≥ 80% true ICP fit |
| | Bounce rate | < 2% |
| | Human edit rate (copy, replies, posts) | < 20% by week 3 |
| | Setter classification accuracy | ≥ 95% |
| | Unapproved claims caught in review | 0 reaching a prospect |
| **Speed** | Reply → first response (business hours) | < 15 min median |
| | Lead row → in sequence | < 24 h |
| **Consistency** | Posts published vs planned | 100% |
| | Days the approval routine was done | 5 of 5 per week |
| **Funnel** | Reply rate / positive reply rate | 5% / 2% |
| | Interested → booked | ≥ 40% |
| | Booked → showed | ≥ 70% |
| **Cost** | AI + data + sending cost per booked call | Track; set a target after week 2 |
| **ROI** | (New clients × average monthly fee × expected months retained) ÷ total monthly system cost | > 5× by month 3 |

Also log every human edit with a one-line reason. Those reasons are the backlog for prompt improvements.

---

## 7. Mistakes to avoid

1. **Sending cold email from the main domain.** One spam spike can damage deliverability for client email too. Use separate, warmed domains.
2. **Skipping warmup to hit the 7-day goal.** Start at low volume from a warmed inbox. Volume comes after warmup, not before.
3. **Letting agents invent proof.** Fake stats or client names in a bookkeeping pitch destroy trust. Use only the approved proof list, enforced by a claim check.
4. **Giving tax or legal advice in replies or posts.** Route anything about taxes owed, notices or audits to a human.
5. **Auto-replying too early.** Keep the Setter in draft mode until it has a clear track record. A wrong reply to a hot lead costs more than a slow one.
6. **Missing unsubscribes.** Make stop rules GHL workflow logic, not agent judgment. Follow CAN-SPAM (physical address and working opt-out). Check the rules for any non-US market before emailing there.
7. **Building a "manager" agent.** Pipeline stages are your orchestrator. Add agents only when an existing one has a clear, measured bottleneck.
8. **Prompt sprawl.** Change prompts only through this repo, with a short note on why. Test changes on 10 saved examples before going live.
9. **Generic social content.** Tie posts to real deadlines and real client situations. Otherwise social becomes busywork with no effect on leads.

---

## Final checks

- **Is each agent truly necessary?** Yes. Each produces one verifiable output (a lead list, a sequence, a reply decision, posts) that a human can check against clear criteria. The orchestrator, follow-up and analytics agents were removed.
- **Are handoffs explicit?** Yes. Every handoff is a GHL stage change with a JSON schema check.
- **Duplication and hallucination risks:**
  - Duplicate contacts are handled by dedupe against GHL before import.
  - Duplicate replies are handled by the one-reply-per-inbound rule.
  - Invented facts are prevented by requiring source URLs.
  - Invented claims are caught by the approved-proof check.
  - Invented prices are prevented by the answer bank, with anything else routed to needs_human.
- **What still needs human review?**
  - Lead list samples and all copy in week 1.
  - Pricing, quotes, tax topics and upset prospects.
  - Every social post.
  - All discovery calls and closing.
- **Can you start today?** Yes. Write the ICP and the approved proof points.
