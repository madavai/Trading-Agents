# Trading Agents: phases B to G (the approved plan)

Written 2026-10-20 and approved by the owner the same day, phase by phase, as written ("I approve phases B to G as
written in the document"). All six phases are now built: B #35, C #36, D #38 and #40, E #42, F #43, G #44, with later
refinements (#39 official sources, #47, #48, #49). This file is the plan as approved, kept in the repository so it stays
readable from any account; the status of each phase is in [`HANDOFF.md`](../../HANDOFF.md).

Six phases turn the desk into an adviser a beginner can live with: trust first, guard rails, a wider world, a morning
screen, care for what you hold, and a guided first week. Each was one pull request (D took two), built in this order.

**Three rules hold in every phase:**
- **Plain words.** No trading word on the page without a one-line meaning beside it.
- **Safe by default.** Every new switch ships off, every new limit ships small, and paper comes before money.
- **Honest.** The desk reads for you and keeps you honest; it does not predict tomorrow, and the scorecard shows its
  real record, good or bad.

**The order.** Trust and limits come before anything that tempts you to trade more: B (trust first) → C (guard rails)
→ D (a wider world) → E (the morning screen and market weather) → F (care for what you hold) → G (the first week).
The real end-to-end run was to come once all six were in (the owner ran the first real runs earlier, on 2026-10-21).

---

## Phase B: trust first

Before anyone risks money, every call the desk makes is followed on paper, and the dashboard opens on what following it
would have done against the market.

**What you would see**
- The dashboard opens on "How the desk is doing": one sentence such as "Following the desk on paper since 1 October:
  up 2.1%, the S&P 500 up 1.4%" (example figures), with a line of paper value against the S&P 500 and how many weeks
  and calls stand behind it.
- Every call carries a small "paper" badge showing what it did on paper so far.
- Beside the trading switch: "The desk has 3 weeks and 12 calls of record" (example).
- Switching trading on with less than four weeks of record shows that record first and asks for one extra
  "I understand" press.

**Decisions**

| Decision | Approved answer | Why |
|---|---|---|
| Paper money to start with | $10,000, changeable on the scorecard | A round number makes the result easy to read, and your real balance stays private |
| The price a call buys or sells at on paper | The first closing price after the call is recorded | A price you could really have had; nothing from hindsight |
| How much each call buys | The same size its order ticket would propose: the rating, a full position of 10%, your caps | Paper then tests the desk exactly as real money would use it |
| How sells work | The same ratings that sell for real: Underweight sells half, Sell sells everything | One set of rules for paper and money |
| Costs | None counted, since Robinhood charges no commission; said plainly on the page | Honest and simple |
| What it is compared with | The S&P 500 over the same days | The one yardstick a beginner knows; calls are already scored this way |
| Before trading can be switched on | Under four weeks of record: show the record and ask one extra press, never block | The choice stays yours, with the evidence in front of you |

**What was to be built:** a paper book in the desk's records (each call followed at its size, its positions and their
daily value from the Yahoo prices the desk already reads); the scorecard as the dashboard's opening section; the paper
badge on calls, the record line beside the trading switch, and the extra press; tests on past price rows, README and
guide. Nothing from Madav. One pull request.

## Phase C: guard rails

Four more limits sit beside your caps, set once by you and checked on every ticket, so one industry, one coin, one bad
week or one nervous morning cannot undo the rest.

**What you would see**
- Under your caps on "Your account": "one sector at most 30% of the account", "crypto at most 5%", "trading switches
  itself off after a 5% fall in a week", "a stock bought here is held at least 5 trading days", each changeable there.
- Every ticket's checklist shows each limit passing or failing, in words.
- If the weekly limit trips, the trading switch shows Off with the reason and the day; switching it back on asks you to
  confirm.

**Decisions**

| Decision | Approved answer | Why |
|---|---|---|
| Most of the account in one sector, after a buy | 30%, the sector taken from the company's own profile; a whole-market fund counts as no sector, a sector fund counts towards its sector | One industry's bad news cannot sink the account |
| A stock whose sector is not known | Counted as a sector of its own, and the check says so | Honest, and it never blocks you for missing data |
| Most of the account in crypto | 5%; for now on paper only, since Robinhood's agent doorway trades stocks only | Crypto swings far more than stocks |
| The weekly loss limit | Trading switches itself off when the Agentic account falls 5% below its highest value of the last seven days; a large withdrawal can trip it too, and you switch it back on | A bad week cannot become a bad month while you are away; a false alarm costs one press |
| The shortest hold | 5 trading days (the desk's scoring window) before the desk proposes selling a stock it bought; your own Sell still works, after a second press saying when you bought it | Stops a call being flipped the next morning, without locking you in |
| Where they live, who changes them | Beside the trading switch and caps, in your private folder, changed only on the dashboard; unreadable values fall back to these, never larger | No agent can loosen them |

(Built note: the sector now comes from the industry code the company gave the SEC, after Yahoo refused its company data
to the desk; see `HANDOFF.md`, "Decisions that stand".)

**What was to be built:** the four limits beside the caps, checked on every ticket and again just before an order is
sent, each with plain words; a daily record of the Agentic account's value from the dashboard's own reads, for the
weekly limit, and the switch turning itself off with its reason; the holding check on the desk's sell proposals, and the
extra press on your own early sells; tests, the safety page, README and guide. One pull request.

## Phase D: a wider world

The dashboard shows the world in three tiers (the whole market, sectors, single names) and steers a beginner towards the
first two, with funds analysed for what they are.

**What you would see**
- A "Start here" section at the top: the whole market, the eleven sectors and your own names, each with today's move
  and the desk's latest call.
- The robot works on a fund as on a stock; its call says what the fund holds and what it costs to own.
- Bitcoin and Ether analysed and followed on paper, within the crypto cap.
- The watchlist grouped by tier; each tier folds away.

**Decisions**

| Decision | Approved answer | Why |
|---|---|---|
| The whole-market tier | SPY (S&P 500), QQQ (Nasdaq 100), VT (the whole world), BND (US bonds); you can change the list | Four funds cover most of what a beginner needs |
| The sector tier | The eleven S&P sector funds: XLK technology, XLF financials, XLV health care, XLE energy, XLI industrials, XLY consumer discretionary, XLP consumer staples, XLU utilities, XLB materials, XLRE real estate, XLC communication | One widely traded fund per sector, easy to compare |
| How a fund is analysed | No new agent: the fundamentals analyst reads the fund's profile instead of company accounts (top holdings, yearly cost, size), and says "unavailable" for what a source does not give | Twelve agents stay twelve; a fund's accounts are its holdings and costs |
| Crypto | Bitcoin and Ether to start, on paper within the 5% cap, never sent to Robinhood while its agent doorway trades stocks only | Lets you learn how the desk reads crypto without risk |
| Where the tiers sit | A "Start here" section first on the page; single names after it | The layout itself points a beginner to broad, cheaper risk |

**What was to be built:** the desk knowing a fund when it sees one, and a desk tool for a fund's profile; the
fundamentals analyst's instructions for funds; the "Start here" section and the tiered watchlist; crypto followed on
paper, within its cap; tests, README and guide. Open point checked while building: how much of a fund's profile Yahoo
gives for free (built note: none, to the desk; a fund's holdings and size now come from its SEC N-PORT reports, #48,
and its yearly cost stays unavailable). One or two pull requests (it took two).

## Phase E: the morning screen and market weather

A cheap pass over your names and the sector funds says what is worth a look today, and one panel says what ground the
market is on, both from figures rather than from a model.

**What you would see**
- "Worth a look today": up to five names, ranked, each with its reason in one line, such as "fell 4% on three times its
  usual volume" or "a new 52-week high" (examples).
- A switch, off when shipped: "Analyse the top three each market morning", which puts them on the waiting list at
  shallow depth.
- "Market weather": three plain lines, the trend, the mood and what markets expect from rates, each with a colour and a
  one-line meaning, and never a forecast.

**Decisions**

| Decision | Approved answer | Why |
|---|---|---|
| What the screen looks at | Price against its 50- and 200-day averages, a day's move of 3% or more, volume at least twice its average, a new 52-week high or low, news published today | Plain signals from data the desk already reads; no model cost |
| How many, in what order | Five shown, ranked by how many signals fire, then by the size of the move | Short enough to read with a coffee |
| Sending them to analysis | Off when shipped; when on, the top three each market morning, at shallow depth | It costs only when you choose |
| When it runs | When the dashboard opens, and every hour while it is open; the morning routine reads the same list | No new background program |
| The trend line | S&P 500 above both averages: rising; between them: mixed; below both: falling | Three words a beginner can hold |
| The mood line | From the VIX: under 15 calm, 15 to 25 normal, over 25 wild | The market's own measure of nerves |
| The rates line | What prediction markets price for the next Federal Reserve meeting, or "unavailable" | Rates move everything; this is what is expected, not a guess of ours |

**What was to be built:** the screen and the weather, worked out in code from the prices and the prediction-market
figures the desk already reads; two panels on the dashboard, the morning switch, and the morning routine reading the same
list; tests on fixed price rows, README and guide. One pull request. (Refined in #49: the switch starts on the next
market morning, never queuing at once.)

## Phase F: care for what you hold

The desk keeps an eye on what you already own: it re-rates it on a rhythm, tells you when a price crosses the stop it
proposed, and proposes sells that you confirm, which is where beginners lose most.

**What you would see**
- Each holding in the Agentic account shows the desk's latest view and its age, such as "Overweight, 3 days ago"
  (example).
- Holdings with a view older than a week are re-rated in Monday's morning routine and show "re-rating" meanwhile.
- When a price falls below the stop the trader proposed, a notice on the dashboard, and the holding is marked "below its
  stop".
- A "the desk says sell" mark with a Sell button, opening a ticket with the usual checks, Robinhood's dry run and your
  Confirm. Nothing is ever sold by itself.

**Decisions**

| Decision | Approved answer | Why |
|---|---|---|
| Which holdings | The Agentic account for proposals; your other accounts show the desk's view as information only | The desk only ever trades in the Agentic account |
| How often | Weekly, in Monday's morning routine: holdings whose latest call is older than seven days, at shallow depth, at most three, within the routine's limit of five | Fresh enough, and the cost stays known |
| Stop levels | The trader's proposed stop, written as a labelled line in its plan; the dashboard watches the live price and tells you; no automatic stop order | Selling stays your decision, made in time |
| A Sell or Underweight on a stock you hold | Marked "the desk says sell", with a ticket sized by the rating (all, or half), within the shortest hold from phase C | The same rules as every other order |
| Notices outside the dashboard (phone, email) | Not in this phase | Keeps it simple and private for now |

**What was to be built:** a holding view that joins your Robinhood holdings with the desk's calls, and the weekly
re-rate list in the morning routine; the trader writing its stop as a labelled line, the stop watch and its notices;
sell proposals through the existing ticket; tests, README and guide. One pull request.

## Phase G: the first week

A friend who has never traded opens the dashboard and is walked through a safe first month, step by step, without you
beside them.

**What you would see**
- On a first visit, "Get started" in five steps, each ticked off by itself as it is done:
  1. Give the desk your email for the SEC, once, with one line on why.
  2. Pick three to five names you know, plus the whole market and one or two sectors you understand.
  3. Ask the desk to analyse them, shallow, and switch on running automatically.
  4. Read your first calls, with what Buy, Hold, Sell and "alpha" mean beside them.
  5. Follow them on paper for four weeks, then read the scorecard before deciding about money and Robinhood.
- A "What does this mean?" glossary, and a plain meaning on every trading word when you point at it.

**Decisions**

| Decision | Approved answer | Why |
|---|---|---|
| When the guide shows | On the first visit, while the desk has no calls; it can be put away and reopened from the side list | Present for a newcomer, out of the way for you |
| Saving the email | A field on the dashboard (kept in the desk's records, sent to the SEC alone), as well as in a chat | A newcomer should not need a chat for step one |
| What it suggests | The whole market and "one or two sectors you understand", never particular stocks | A research tool, not advice |
| Paper time before the money step | Four weeks, as in phase B | One number, said the same way everywhere |
| The glossary | About thirty words (the ratings, alpha, index, fund, sector, cap, limit order, stop, paper, depth), each in one plain line, written once and used across the page | Every word means the same thing everywhere |

**What was to be built:** the "Get started" view and its ticks, read from the desk's own records; the email field, the
glossary and the meanings on hover; tests, README, and a "your first month" panel in the guide. About half a pull
request's work.

---

## What none of the phases does, on purpose

- **No options, futures or currencies.** Recommended out until the desk has a long record; the owner has not decided
  this yet.
- **No order without your Confirm.** Not on a stop, not on a sell rating, not on a loss limit: the limit only switches
  trading off.
- **No personal advice.** The desk proposes research; the page never tells a person what they should buy.
- **No accounts for others.** Each friend runs their own copy on their own computer, with their own Robinhood and their
  own private folder.
