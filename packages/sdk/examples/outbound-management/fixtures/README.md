# Outbound state test records

These people, companies, messages, and links are fictional. The Python tests use
these records to check state writes without browser access.

- `crm.json`: the CRM before the first day.
- `day-1/messages.json`, `day-2/messages.json`: `read_email` output. Day two
  repeats the first day's messages and adds a request for a meeting.
- `observations.json`: the other source step outputs for day one
  (`email_search`, `prospects`, `prospect_search`, `enrichment`).
- `plan.json`: `update_contacts` and `draft_tasks` output for day one.
- `state.json`, `tasks.md`, `receipt.json`: what `save_day` makes from them.

The real outbound Method uses an empty starter CRM and gathers from email,
Happenstance, company websites, and LinkedIn. It does not read these fixtures.
