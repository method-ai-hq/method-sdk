# Manage daily outbound

Each run reads email, finds prospects in Happenstance, checks their company and
LinkedIn pages, updates the CRM, and writes today's tasks with outreach drafts.
Messages stay unsent until you review and act on the tasks.

## Sources

- **Email:** opens your mailbox in the browser and reads received and sent
  messages for the campaign. Saves message IDs and thread links with the CRM.
- **Happenstance:** searches your connected network for people who fit your
  target customer, including introduction paths. See its
  [people search guide](https://happenstance.ai/guides/ai-people-search).
- **Company websites and LinkedIn:** checks roles, company activity, and the
  reason your offer fits. Saves page links and the facts read there. This uses
  the existing browser and does not require a separate enrichment subscription.

The source check stops the run if the agent reports blocked access. A completed
search may return no matches. Checks require source records; they do not prove
that the agent found every email or that every source is accurate.

## Set up and run

Run from this folder. Copy the empty starter CRM once to set up the account.
Set `target.customer`, `target.offer`, `target.new_prospects_per_day`, and
`target.mailbox_url` for your business. The starter uses Gmail; replace its URL
with your webmail URL if needed. Use the intended signed-in account.

```sh
mkdir -p work/crm
cp starter/crm.json work/crm/crm.json
method validate outbound.method
method save outbound.method
python3 - <<'PY' > work/state.json
import json
from pathlib import Path
print(json.dumps({'crm': Path('work/crm/crm.json').read_text()}))
PY
chmod 600 work/state.json
method state WORKFLOW_ID --enable --file work/state.json
method run WORKFLOW_ID --version VERSION_ID --inputs inputs.json
```

Use the IDs returned by `save`. Set `day` and `from_date` in `inputs.json` before
each run. Use an overlap with the last run so late replies are included.
Method connects the browser and uses the calling agent. Follow its setup request
if email, Happenstance, or LinkedIn needs sign-in.

Open the returned `tasks.md` and `receipt.json`. Updates are saved in shared
Method account state. The setup file is a snapshot, not the current CRM. Run the saved Method daily
or use your scheduler; this Method does not create a schedule itself.

## Saved state

The CRM keeps contacts, owner notes, message history, introduction paths, and
daily plans. Already resolved email IDs are skipped. Unclear senders remain for
review. Customers and opt-outs stay out of outreach tasks.

A checked plan returns a replacement for `state.crm`. Method accepts that state
only after the save check passes. Shared account state uses a run lock and revision
checks so local and deployed runs use one current CRM. If the CRM changed during
research, the save stops. Repeating the same save does not repeat its updates.
The receipt records the saved state hash. Keep shared state enabled for normal use.

The plan uses lists for `contacts`, `messages`, and `tasks`. Its `research_notes`
field is one text string, with paragraph breaks between notes or an empty string
when there are none. The plan check rejects lists and objects in that field before
the CRM is changed.

## Deploy

After a saved-version run completes, use `method deploy --from-run RUN_DIRECTORY`.
Review its runner, browser sites, coding-agent access, and shared state, then use
the returned approval command. The deployed Method uses the same account CRM;
it does not need a writable local folder. Complete any runner sign-in checks.
Deployment prepares the runner; it does not schedule or send outreach.

## Files and checks

- `outbound.method`: read CRM, gather sources, plan and check, save.
- `crm.py` and entry scripts: state reads, source and plan checks, state replacements.
- `runtime.json`: Python setup; no third-party Python libraries.
- `starter/crm.json`: empty CRM with editable target settings.
- `inputs.json`: email date range and date to plan.

Fictional records are only in `fixtures/` for local state
tests. They are not inputs to this Method. The tests cover two-day history,
repeated saves, stale writes, owner notes, opt-outs, unclear senders, and blocked
sources. A live run is still needed to check signed-in access and research quality.

Run the state tests offline with `python3 -m unittest crm_test.py`.
`fixtures/tasks.md`, `fixtures/receipt.json`, and `fixtures/state.json` are recorded
outputs from the fictional first-day fixture, not a live account run.
