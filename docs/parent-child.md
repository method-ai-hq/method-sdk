# Parent and child Methods

When one Method runs for many clients that differ only in their rules, constants, data files and cases, write it once as a **parent** and give each client a short **child** file. Each child is its own Method (its own `id:`, versions, cases, runs and publish). A fix in the parent reaches every child; `method test PARENT --children` runs every child's cases against the changed parent first.

The CLI resolves a child into one ordinary Method before any command reads it. `validate`, `run`, `test`, `case`, `diff` and `publish` all act on that resolved Method, and a saved version holds it whole: the parent's steps and files are in it. The Method server and the production worker never see `extends`, so a published child runs anywhere a Method runs.

## The example

[`examples/invoice-coding`](../examples/invoice-coding) holds a parent and two clients:

```text
invoice-coding.method              the parent (abstract: true): 3 steps, the shared prompt, params
scripts/read-lines.mjs             the parent's scripts
scripts/check-totals.mjs
clients/acme/
  acme-invoice-coding.method       a child: params only
  rules.md, accounts.json
clients/brightside/
  brightside-invoice-coding.method a child: params, a changed prompt, a new step, a data file
  rules.md, accounts.json, properties.json, find-property.mjs
```

The parent ([`invoice-coding.method`](../examples/invoice-coding/invoice-coding.method)) declares its params and uses them:

```yaml
format: method/3.4
# A template: each client is a child file that extends it. method children invoice-coding.method lists them.
abstract: true
name: Invoice coding
goal: Code each line of a vendor invoice to one of the client's GL accounts.
params:
  client_name:
    type: text
    description: The client's name, as the prompts say it.
  coding_rules:
    type: text
    description: The client's coding rules, word for word.
  chart_of_accounts:
    type: text
    description: The client's chart of accounts (a JSON file beside the child file).
  late_fee_gl:
    type: text
    description: The GL account for late fees and interest.
    default: "7190"
models:
  coder: anthropic/claude-haiku-4.5
inputs:
  invoice:
    type: text
    description: The text of one vendor invoice.
files:
  - "{{params.chart_of_accounts}}"
steps:
  read_lines:
    name: Read the invoice lines
  ...
```

A child that only fills params ([`acme-invoice-coding.method`](../examples/invoice-coding/clients/acme/acme-invoice-coding.method)):

```yaml
extends: ../../invoice-coding.method
name: Invoice coding for Acme
goal: Code each line of an Acme vendor invoice to one of Acme's GL accounts.
params:
  client_name: Acme
  coding_rules: {file: rules.md}
  chart_of_accounts: accounts.json
```

A child that also changes a step, adds a step and adds a file ([`brightside-invoice-coding.method`](../examples/invoice-coding/clients/brightside/brightside-invoice-coding.method)):

```yaml
extends: ../../invoice-coding.method
name: Invoice coding for Brightside
goal: Code each line of a Brightside property invoice to a GL account and the property it belongs to.
params:
  client_name: Brightside
  coding_rules: {file: rules.md}
  chart_of_accounts: accounts.json
  late_fee_gl: "8040"
files: {append: [properties.json]}
steps:
  # A patch: only the prompt of the parent's step changes; its model, inputs and outputs stay.
  code_lines:
    prompt: |
      You code property invoices for {{params.client_name}}. Give each invoice line one GL account from the accounts list.
      Late fees and interest always go to {{params.late_fee_gl}}. Utilities follow the rules below before anything else.

      {{params.client_name}}'s coding rules:
      {{params.coding_rules}}
  # A new step, placed after the parent's code_lines step.
  find_property:
    insert_after: code_lines
    name: Find the property
    purpose: Finds the property of the invoice by its service address in properties.json. Changes nothing.
    in: {invoice: inputs.invoice}
    do: {kind: run, runtime: node, entrypoint: find-property.mjs}
    out:
      property: {type: text, description: "The property ID, or none when no address matches."}
result:
  entry: entry
  property: property
```

## The rule

- **Params.** A parent declares `params:` (`type`: text, number, boolean, list or record; `description`; optional `default`) and uses them as `{{params.NAME}}`, inside text or as a whole value (`files: ["{{params.data_file}}"]` keeps a list a list). A child fills them under `params:`; a text param can be `{file: PATH}`, the text of a file beside the file that gives it. A param left without a value is an error. A parent with such a param is a template: mark it `abstract: true`; it cannot run, be tested or be published by itself.
- **Merging.** Maps merge key by key and the child wins (steps, step fields, `do`, `in`, `out`, `inputs`, `models`, `secrets`, `limits`). A list replaces the parent's list unless the child writes `{append: [...]}`. `null` removes a key. `id:` is never inherited.
- **Steps.** A child step entry names a parent step and changes only the fields it gives; `prompt:` replaces the prompt of the step's `do`; `replace: true` replaces the step whole. A new step needs `insert_after: STEP` or `insert_before: STEP`. `remove_steps: [STEP]` removes parent steps. Naming a step or param that the parent does not have is an error, so a typo never passes silently.
- **Files.** A parent's files and scripts are found beside the parent file, a child's beside the child file. When both have a file of the same name, the child's wins. The child's `cases/`, `learned.json` and files-connection folders are its own.
- **Chains.** A child can be a parent too (parent, child, grandchild); a nearer value wins. A cycle, or an `extends:` path that does not exist, is an error that names both files.

## Commands

```sh
method resolve clients/acme/acme-invoice-coding.method          # the resolved Method as YAML: exactly what runs
method show clients/acme/acme-invoice-coding.method --resolved  # the same as JSON (--path POINTER for one field)
method validate clients/acme/acme-invoice-coding.method
method run clients/acme/acme-invoice-coding.method --inputs invoice.json
method diff clients/acme/acme-invoice-coding.method clients/brightside/brightside-invoice-coding.method
method children invoice-coding.method --dir .                     # the files that extend the parent
method test invoice-coding.method --children --dir .              # every child's cases against the parent as it is now
method publish clients/acme/acme-invoice-coding.method            # one child's version
```

A change to the parent: edit it, run `method test PARENT --children`, and when every child passes, publish each child. A child that fails keeps its last published version until you fix it (or the parent).

The resolved Method of a child lives in Method's cache (`~/.cache/method/resolved/`), made again by each command; do not edit it. The first signed-in run or the first publish of a child writes its `id:` line into the child file. A saved version's reason ends with the files it was resolved from, for example `Resolved from acme-invoice-coding.method extends invoice-coding.method (sha256 1a2b3c4d5e6f).`

Method does not change a child or a parent by itself: a correction of a child's run is recorded, and you change the child (one client) or the parent (every client), then run the tests.
