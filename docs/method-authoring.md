<!-- Generated from packages/sdk/src/method-help.ts. Run npm run docs:method. -->

# Author with Method

1. Ask what work to repeat and what a good result looks like. Wait for the answers. For a report, ask for a complete approved example if one exists. For a state change, ask what the saved result should be. Use a small sample for the first run.
2. Read the complete Method below and its supporting files. Use it as an example, not a required structure. Keep the user's sources and output requirements. Choose the fewest steps that make the work clear.
3. Write a complete .method file and its helper files in one folder. Add runtime.json only for custom tools, scripts, connections, or limit overrides. Write the files directly; init, set, and step add are optional editing tools. Keep prompts short and direct. Give the runtime access to the actual approved example.
4. Run method validate task.method. Fix missing files, settings, and tool bindings. Validation does not run the work or judge the output.
5. Run method save task.method. It confirms that the stored version matches the draft and returns its IDs and dashboard link.
6. Run method run WORKFLOW_ID --version VERSION_ID --inputs inputs.json on the agreed sample, using the IDs returned by save. Inspect the actual result and its source links. For external changes, use a test destination or ask before making a live change. Fix problems, save a new version, and test it. Return the Method and run links with the test result and any remaining limits. If execution is blocked, state what has not been tested.

New Methods use format: method/3.1. Read method authoring execution for configuration, method schema for exact fields, or method COMMAND --help for command arguments. You do not need to read the full manual before writing a draft.

# Approved example: Write a daily briefing

# Task

Turn one prepared day folder into a complete, cited daily briefing. Follow the approved example for writing and layout, and save the briefing with its website.

This is the task recorded in the approved Method's goal, copied without changes. The first conversation that led to the report is not included. The included Method is adapted from that version: rendering and saving are combined, calculations are optional explicit files, and obsolete writing restrictions and duplicate file tools are removed. The complete approved output stays unchanged.

Complete Method (JSON is valid .method syntax):

```json
{
  "format": "method/3.1",
  "name": "Write a daily briefing",
  "goal": "Turn one prepared day folder into a complete, cited daily briefing. Follow the approved example for writing and layout, and save the briefing with its website.",
  "inputs": {
    "day": {
      "type": "text",
      "description": "Date of the prepared records, in YYYY-MM-DD form."
    },
    "timezone": {
      "type": "text",
      "description": "Timezone for those records, such as America/Chicago."
    }
  },
  "environment": {
    "prepared_day": {
      "type": "files",
      "description": "Folder of prepared records for that day. Read-only."
    },
    "approved_example": {
      "type": "files",
      "description": "Folder containing the complete approved example. Read-only."
    }
  },
  "steps": {
    "open_inputs": {
      "name": "Check the input folders",
      "in": {
        "day": "inputs.day",
        "timezone": "inputs.timezone",
        "prepared_day": "environment.prepared_day",
        "example_folder": "environment.approved_example"
      },
      "do": {
        "kind": "run",
        "runtime": "python",
        "entrypoint": "briefing_check_inputs.py"
      },
      "out": {
        "selected_day": {
          "type": "record",
          "description": "The prepared folder, its README, date, timezone, and source hashes.",
          "fields": {
            "folder": {
              "type": "text",
              "description": "Absolute path to the selected prepared folder. Use the selected_day root with the file tools."
            },
            "day": {
              "type": "text",
              "description": "Selected date in YYYY-MM-DD form."
            },
            "timezone": {
              "type": "text",
              "description": "Named timezone used to interpret this day."
            },
            "start": {
              "type": "text",
              "description": "README.md relative to the selected_day file-tool root."
            },
            "source_digest": {
              "type": "text",
              "description": "Hash of the prepared files at the start of this run."
            }
          }
        },
        "example": {
          "type": "record",
          "description": "The approved example and its complete text.",
          "fields": {
            "folder": {
              "type": "text",
              "description": "Absolute path to the read-only approved example."
            },
            "website": {
              "type": "text",
              "description": "index.html relative to the example browser tool\u2019s website root. File tools use website/index.html under example."
            },
            "draft": {
              "type": "text",
              "description": "briefing.md relative to the example file-tool root."
            },
            "report": {
              "type": "text",
              "description": "Complete approved text, with old hidden display markers removed."
            }
          }
        },
        "session_links": {
          "type": "text",
          "description": "Links to saved social sessions for this day. A link on its own line displays that session in the story."
        }
      },
      "purpose": "Check that the required files exist and that the prepared records match the selected date and timezone.",
      "reading": {
        "inputs": "The date and timezone to use, the folder of prepared records, and the folder containing the approved example.",
        "outputs": "Paths to the prepared records and their README, the date and timezone, and links to the approved example.",
        "output_name": "Input records and approved example"
      },
      "limits": {
        "timeout_ms": 30000
      }
    },
    "write_briefing": {
      "name": "Write the briefing",
      "in": {
        "selected_day": "selected_day",
        "date": "selected_day.day",
        "folder": "selected_day.folder",
        "example": "example.folder",
        "approved_report": "example.report",
        "session_links": "session_links"
      },
      "do": {
        "kind": "agent",
        "model": "writer",
        "prompt": "Write the complete story of {{date}} from the prepared records in {{folder}}. Use the approved example briefing at {{example}} as the standard for writing, detail, and presentation. Open its expanded sessions, passages, and citations. Use the selected day\u2019s records as evidence. Return the briefing as Markdown. Link sources with [label](source:record-id) or [label](source:record-id#L10-L20).\n\nUse calculate_activity_times for supported time estimates.",
        "tools": [
          "inspect_briefing_example",
          "calculate_activity_times"
        ]
      },
      "out": {
        "draft": {
          "type": "text",
          "description": "The complete Markdown briefing."
        },
        "supporting_files": {
          "type": "list",
          "items": {
            "type": "file"
          },
          "description": "File references returned by the calculator, or an empty list when none were made."
        }
      },
      "purpose": "Read the records and approved example, write the briefing, and calculate supported activity times when needed.",
      "reading": {
        "inputs": "The prepared records, their date and timezone, and the approved example.",
        "outputs": "The complete Markdown briefing, with source links and any selected passages.",
        "output_name": "Briefing draft"
      },
      "limits": {
        "timeout_ms": 3600000,
        "max_agent_turns": 64,
        "max_model_requests": 64
      }
    },
    "render_and_save": {
      "name": "Render and save the briefing",
      "in": {
        "selected_day": "selected_day",
        "draft": "draft",
        "supporting_files": "supporting_files"
      },
      "do": {
        "kind": "run",
        "runtime": "python",
        "entrypoint": "briefing_render.py"
      },
      "out": {
        "saved_briefing": {
          "type": "file",
          "description": "Links to the saved briefing, website, and calculation files, if produced, with the date and timezone."
        },
        "published_website": {
          "type": "file",
          "description": "The saved website, its draft, and calculation files, if produced.",
          "format": "method-website"
        }
      },
      "purpose": "Render and save the briefing with source links and supporting files. If a social-session link is unknown, show a notice and link to all saved sessions.",
      "reading": {
        "inputs": "The draft, prepared records, and supporting files, if any.",
        "outputs": "The saved briefing and website."
      },
      "limits": {
        "timeout_ms": 600000
      }
    }
  },
  "result": {
    "briefing": "saved_briefing",
    "website": "published_website"
  },
  "run_prompt": "Run Write a daily briefing for the requested day. Ask which day if it is missing. Use the prepared records and runtime.json in the Method folder. Read the date and timezone from the prepared records. When finished, open the briefing website and give me the run link.",
  "files": [
    "briefing_files.py",
    "briefing_browser.cjs",
    "briefing_times.py",
    "briefing_sessions.py",
    "briefing_check_inputs.py",
    "briefing_artifacts.py",
    "briefing_manifest.py",
    "briefing_progress.py",
    "briefing_validation.py",
    "briefing_render.py",
    "briefing_website.py",
    "briefing_markdown.py",
    "reader/reader.css",
    "reader/reader.js"
  ]
}
```

Read README.md in the installed example folder for setup, helpers, the small redacted input sample, the complete approved output, and recorded checks. Copy that folder before editing it. Run setup.py there to prepare the example; it does not run the Method. The example uses the current Codex sign-in and model.

The writer reads a complete approved report. It does not reconstruct a style from a summary. The scripts check inputs, calculate times, build the website, and save it. Copy useful choices; change the steps and tools to fit the work.


# Method concepts

A method has format, name, goal, steps, result, and optional inputs, state, environment, and files.
Each step has either do or ask. purpose, reading, and limits are optional. The do object selects kind: run, call, or agent.
run uses runtime and entrypoint; call uses model and prompt; agent also declares tools.
Optional run_prompt is plain text for the outside agent that starts a saved Method. Write which Method to run, where to find its inputs, and what to show when finished. Save it with the Method version and update it when inputs or outputs change. The copy button appends the exact version link and shared CLI setup; do not repeat them in run_prompt. This field is not a step prompt and does not expand variables. Set it with method set task.method /run_prompt --text-file run-prompt.txt.

In method/3.1, prompts use {{date}} for the step input declared as in.date. Nested fields such as {{customer.name}} are allowed. Only text, numbers, and booleans can be inserted; pass lists and records as structured inputs. Whitespace inside braces is allowed. Escape a literal placeholder with a backslash before its opening braces (use a YAML block scalar). Values are inserted once, never evaluated or expanded again. Unknown variables, invalid paths, and non-scalar values fail validation. Missing runtime values fail before model execution. Defaults belong in input declarations. Human ask text uses the same scope; agent check prompts use {{inputs.date}} and {{outputs.answer}}. Script commands, labels, and tool descriptions are not templates. method/3 keeps literal prompts. To upgrade, set format to method/3.1, escape any literal double braces, and validate. Single braces are ordinary text in both formats.
Runs record prompt.rendered with the template and expanded instructions for each invocation and phase; the run page shows the recorded expansion, with templates in technical details. Model and agent work uses finite default limits; steps can override them.
An optional step reading object explains inputs, outputs, condition, and check in plain text for the reading page. These descriptions do not alter execution. Describe the declared data and actual checks; keep them in sync when editing the step. The page always shows the exact do and check instructions as well. Give a separate executable check a short reading.check_name, such as “Compare saved text”, and use reading.check to explain what it checks. These fields change presentation only. Older checks without a name display “Check”. Do not imply that a file or reference check verifies facts, or add a check just to fill the display.
Inputs and outputs have a type and an optional description. Types: text, number, boolean, record, list, file. Records need fields; lists need items or fields. Files have path and sha256.
Online runs attach declared file outputs, up to 20,000 files, with 100 MB decoded and 20 MB transferred, after checking their hashes. For a website, declare format: method-website and write a JSON file {schema: "method-website/1", title, entrypoint, files: [{path, sha256, media_type}]}. Paths in the file list are relative to that file; list every asset and identify an HTML start page. The run page opens the website only when all listed assets are attached. It can also download the complete website as a ZIP. No workspace scan occurs. See docs/result-files.md and examples/website-result.method for the full contract and working example. method sync RUN_DIRECTORY uploads files without executing steps again.
Bind step inputs with in aliases and use named outputs as downstream references. Every output has one producer.
Checks use equals, count, present, file, a script, or a bounded agent. Checker output is {status: pass|fail|unknown, reason, evidence}. Unknown never passes.
Use changes for state.NAME or environment.NAME. External changes require a check. State changes commit only after acceptance. State is saved in state.json.
Use each for a collection, repeat for bounded iteration, when for a boolean condition, and after for dependencies. Each and repeat cannot be combined.
Run a single step with repeat: {max_iterations: N, until: BOOLEAN_OUTPUT}. The final accepted output is returned; all iterations are recorded.



For live progress, native Codex forwards public updates as they arrive. Scripts use METHOD_PROGRESS_FD; run method progress --help for the message and child-agent relay protocol. Keep stdout for the final JSON result. Report real milestones without source passages or secrets. Quiet work still sends a five-second heartbeat; the page polls every three seconds. A heartbeat shows the executor is connected, not that new work has completed. See source/docs/progress.md for complete examples.

Use reading.output_name to give a returned result a short, honest name. Use reading.outputs to explain its contents.
# Execution setup

Use method run FILE_OR_ID [--config runtime.json] [--workspace HELPERS_FOLDER] [--inputs inputs.json] [--state state.json] [--run-dir DIR].
Agent and call steps start Codex CLI by default, using its existing sign-in, user configuration, and default model. No model profile or API key is needed for that path. Install Codex and sign in before running.
A simple local-agent Method needs no runtime.json. When needed, put runtime.json beside the Method. For a saved Method ID, use runtime.json and helpers in the current folder, or pass --workspace DIR. --config overrides that file. Relative files-environment paths and executable paths in configuration resolve from the config folder. A bare executable name is found on PATH.
Operator config supplies runtimes, tools, environment, and run limits. Optional models.PROFILE: {backend: codex, model: MODEL} selects a model; omit model to use the Codex default. command can select the Codex executable and reasoning_effort can override its setting.
An explicit models.PROFILE with backend: openai-responses keeps the direct API path. It requires model, api_key_env, and max_output_tokens. Keep key values out of the config; api_key_env names an existing environment variable.
runtimes.PROFILE uses command, version, optional args and env variable names. Scripts and Codex require allow_local_processes: true. They are trusted local processes.
Tools declare description, in, out, run, and effects. Agent tools must be listed in both the step and config. Check tools cannot declare external effects.
Defaults: one hour per run, ten minutes per step, 100 model requests, 100 step invocations, 200 tool calls, and 16 MiB for input and output. Step defaults allow 32 agent turns/model requests. Override run limits with timeout_ms, max_model_requests, max_invocations, max_tool_calls, max_output_bytes, max_request_bytes. Method enforces the Codex process timeout, prompt/output size, and declared Method tool-call limit. max_model_requests and max_agent_turns govern the direct API loop only; Codex manages its own internal requests and built-in tools. Codex usage and process logs are saved separately.
Declared tools are exposed to each Codex step through a temporary local MCP connection. It uses the same script execution and checks as the API path. Codex also retains the user's installed tools. Method does not sandbox these processes. No persistent Codex configuration is edited.
Scripts receive one JSON object on stdin and return one JSON object on stdout. Write artifacts under METHOD_OUTPUT_DIR. State updates are returned under state.
The CLI snapshots files and script entrypoints from the method folder, or --workspace when supplied. A saved dashboard method keeps helper paths; provide the local helpers folder when running it.
Use method inspect RUN_DIRECTORY --out inspection.json for a saved run; online runs sync to the same Method dashboard.


# Recipes

Use a script for exact file transforms and exports. Use a call for a structured model response. A direct API call is one request without tools; the Codex backend controls its own internal requests and tools. Use an agent only when bounded tool use is needed.
For incremental exports, keep a declared state ledger of source IDs and evidence hashes. Compare new evidence to that ledger and rebuild only changed days. Supply the prior run's state.json with --state for a new run.
Resume continues the same input set and saved version. A new run can collect new files. A separate database is optional application state, not a workaround required to resume Method.
To edit a failed method, read its exact saved version and logs, compare the current version, then save the complete repair with a reason.


# Recovery

For a stopped run, read summary.json, events.jsonl, and checkpoint.json. Resume with the original method, config, --run-dir DIR, and --resume. Accepted steps and iterations are reused.
An unfinished action needs --retry STEP:ITERATION after inspection of its external effects. A retry consumes the remaining run budget. Budgets do not reset on resume. Changed methods or config require a new run.
For ask, supply --human FILE containing {steps: {"STEP:ITERATION": {outputs: {NAME: VALUE}}}}. Use the user's actual answer. Checks still run.
For a stale .lock, first confirm the process has stopped. Never remove an active process lock.
State commits after checks. A local checkpoint cannot roll back an external write. Inspect external state before an explicit retry.
For a save conflict, get the latest version and apply the change there. For an uncertain upload, retry the same file and command with its sidecar unchanged.
Use method sync RUN_DIRECTORY to repair a dashboard upload without executing the method again.
Older saved methods retain their original --resources, --state-dir, --recoveries and Codex options. The new config must not silently change their execution.


# Command reference

Local authoring commands edit draft files. create, save and update publish method versions. run executes a saved version.

Server: https://app.withmethod.ai by default. --server selects another server and its login.
Success exits 0. Errors exit 1 with text on stderr, unless the command specifies another result.

Common errors:
File commands require readable YAML or JSON. Editing commands report draft locks and leave the original file unchanged after a failed edit. Online commands require sign-in and network access. Use method authoring recovery for conflicts and interrupted saves.

## progress

Report public progress from a running script or relay a child Codex JSON stream.

Usage:

```sh
method progress --message TEXT [--completed N --total N --unit NAME] [--child NAME]
method progress --codex --child NAME
```

Arguments and defaults:
METHOD_PROGRESS_FD is supplied by the executor. --codex reads JSON lines from stdin; --message sends one message. Do not include secrets or source contents.

Result and changes:
Writes to the separate progress pipe. No stdout output. No-op outside a Method process.

Errors:
Invalid arguments. Malformed Codex events are ignored.

Example:

```sh
method progress --message 'Rendered 12 of 40 pages' --completed 12 --total 40 --unit pages
```

## authoring

Read the installed authoring guide. Available offline.

Usage:

```sh
method authoring [start|concepts|execution|example|recipes|recovery|commands|all]
```

Arguments and defaults:
Default topic: start, including the complete approved Method. Supporting files are installed beside the CLI; their path is printed. all prints the full manual.

Result and changes:
Markdown text on stdout. No changes.

Errors:
Unknown topic: lists the valid topics; exit 1.

Example:

```sh
method authoring all > method-guide.md
```

## init

Create a local YAML draft.

Usage:

```sh
method init FILE --name NAME --goal TEXT
```

Arguments and defaults:
File must be new. Name and goal are required. The draft starts with an empty steps map and result map.

Result and changes:
JSON {file, workflow}. The workflow field contains the method and is kept for compatibility. Writes the local draft.

Errors:
Missing name or goal; file or sidecar already exists.

Example:

```sh
method init task.method --name 'Find leads' --goal 'Find qualified leads from the specified sources.'
```

## show

Read a draft or one field.

Usage:

```sh
method show FILE [--path POINTER]
```

Arguments and defaults:
Default: the full document. Pointer example: /steps/search/do.

Result and changes:
Selected value as JSON. No changes.

Errors:
The selected field does not exist.

Example:

```sh
method show task.method --path /steps/search
```

## set

Add or replace one draft field.

Usage:

```sh
method set FILE POINTER (--json JSON|--value-file FILE|--text TEXT|--text-file FILE)
```

Arguments and defaults:
Use exactly one: --json JSON, --value-file FILE (YAML or JSON), --text TEXT, --text-file FILE (UTF-8 text). Prefer files for long text. Parents must exist. An empty pointer replaces the document. Escape / as ~1 and ~ as ~0. Nested values replace in full.

Result and changes:
JSON {file, workflow}. The workflow field contains the method and is kept for compatibility. Writes the local draft.

Errors:
Invalid pointer, missing parent field, or conflicting value flags.

Example:

```sh
method set task.method /steps/search/do/prompt --text-file search.txt
```

## remove

Remove one draft field.

Usage:

```sh
method remove FILE POINTER
```

Arguments and defaults:
The field must exist. Repair remaining references before saving.

Result and changes:
JSON {file, workflow}. The workflow field contains the method and is kept for compatibility. Writes the local draft.

Errors:
The selected field does not exist.

Example:

```sh
method remove task.method /steps/search/each
```

## step add

Add a complete operation.

Usage:

```sh
method step add FILE --id ID --value-file STEP.yaml
```

Arguments and defaults:
Supply do or ask and the bindings and outputs needed by the step in STEP.yaml. purpose, reading, checks, and limit overrides are optional. Alternatively use --kind run --runtime PROFILE --entrypoint FILE. Agents can use --kind agent --instructions-file FILE; the default model is the local Codex agent.

Result and changes:
JSON {file, workflow}. The workflow field contains the method and is kept for compatibility. Writes the local draft.

Errors:
File commands require readable YAML or JSON. Editing commands report draft locks and leave the original file unchanged after a failed edit. Online commands require sign-in and network access. Use method authoring recovery for conflicts and interrupted saves.

Example:

```sh
method step add task.method --id copy --value-file copy.yaml
```

## step update

Change fields of an existing step.

Usage:

```sh
method step update FILE STEP_ID (--json JSON|--value-file FILE)
```

Arguments and defaults:
Supply an object of fields. Top-level fields merge; nested values replace in full. Use remove to delete a field.

Result and changes:
JSON {file, workflow}. The workflow field contains the method and is kept for compatibility. Writes the local draft.

Errors:
Unknown step or invalid step fields.

Example:

```sh
method step update task.method search --value-file search.yaml
```

## step remove

Remove an operation.

Usage:

```sh
method step remove FILE STEP_ID
```

Arguments and defaults:
Repair references to its outputs and after constraints before saving.

Result and changes:
JSON {file, workflow}. The workflow field contains the method and is kept for compatibility. Writes the local draft.

Errors:
The selected step does not exist.

Example:

```sh
method step remove task.method old_search
```

## step move

Change display order.

Usage:

```sh
method step move FILE STEP_ID --before OTHER_ID
```

Arguments and defaults:
Both steps must exist. Data references and after still control execution order.

Result and changes:
JSON {file, workflow}. The workflow field contains the method and is kept for compatibility. Writes the local draft.

Errors:
The selected step or destination does not exist.

Example:

```sh
method step move task.method search_exa --before search_bookface
```

## check set

Set the operation's independent check.

Usage:

```sh
method check set FILE STEP_ID (--json JSON|--value-file FILE)
```

Arguments and defaults:
Current methods require an equals/count/present/file object, a run check, or an agent check. Put plain-English criteria in an agent check prompt. --text and --text-file apply only to older formats.

Result and changes:
JSON {file, workflow}. The workflow field contains the method and is kept for compatibility. Writes the local draft.

Errors:
Unknown step, invalid check, or conflicting value flags.

Example:

```sh
method check set task.method search --value-file check.yaml
```

## check remove

Remove the operation's check.

Usage:

```sh
method check remove FILE STEP_ID
```

Arguments and defaults:
The operation will be unchecked. External changes require a check.

Result and changes:
JSON {file, workflow}. The workflow field contains the method and is kept for compatibility. Writes the local draft.

Errors:
The selected step does not exist.

Example:

```sh
method check remove task.method copy
```

## check

Edit an operation's check.

Usage:

```sh
method check set|remove ...
```

Arguments and defaults:
Use method check set --help for arguments.

Result and changes:
JSON {file, workflow}. The workflow field contains the method and is kept for compatibility. Writes the local draft.

Errors:
Unknown action. Choose set or remove.

Example:

```sh
method check set --help
```

## validate

Check the definition and local setup without running the work.

Usage:

```sh
method validate FILE [--config FILE] [--workspace DIR]
```

Arguments and defaults:
Checks data, names, dependencies, templates, declared files, executables, environment variables, runtime profiles and tool bindings. Defaults to runtime.json beside the Method. --workspace selects the helper folder and default config folder. Relative paths in config resolve from the config folder.

Result and changes:
JSON reports definition, local_setup, executed:false, and valid. Missing setup or invalid definition exits 1 with an exact error. Legacy Methods get definition checks only.

Errors:
The error identifies the invalid field or reference.

Example:

```sh
method validate task.method
```

## diff

Compare two documents.

Usage:

```sh
method diff FILE OTHER_FILE
```

Arguments and defaults:
Both files required. Values are compared after parsing YAML or JSON.

Result and changes:
JSON array of {path,before?,after?}. Empty means equal; exit 0 either way.

Errors:
Both file paths are required.

Example:

```sh
method diff original.method task.method
```

## schema

Read the machine-readable grammar.

Usage:

```sh
method schema [method|config|step|data|environment|check]
```

Arguments and defaults:
Default: method. Use authoring concepts for meaning and authoring recipes for examples.

Result and changes:
JSON Schema for tooling. Data declarations in methods use the six simple types.

Errors:
Unknown schema name.

Example:

```sh
method schema step
```

## create

Save a complete local draft as a new online method.

Usage:

```sh
method create --file FILE [--request-id UUID] [--server URL]
```

Arguments and defaults:
--file required. Request ID defaults to a new UUID and is saved before upload. The draft must not already belong to an online method. Validation runs before upload.

Result and changes:
JSON with workflow_id, version_id, version_number, server and url. Writes FILE.method.json.

Errors:
Invalid method; linked draft; conflicting request ID; pending save with changed contents. See recovery for an uncertain upload.

Example:

```sh
method create --file message.method
```

## get

Read an online method; optionally make a local draft for editing.

Usage:

```sh
method get WORKFLOW_ID [--version VERSION_ID] [--out FILE] [--server URL]
```

Arguments and defaults:
Default: latest version. --out must name a new file with no existing .method.json. Use a version ID to read an exact saved version.

Result and changes:
Without --out: {workflow_id,version_id,version_number,workflow}. With --out: {workflow_id,version_id,version_number,file}; writes the workflow and FILE.method.json.

Errors:
Missing method or version; output file or sidecar already exists.

Example:

```sh
method get wf_example --out edit.method
```

## save

Save a draft as one online version.

Usage:

```sh
method save FILE [--reason TEXT] [--request-id UUID] [--server URL]
```

Arguments and defaults:
New draft: creates a method. Linked draft: --reason required, base version and destination read from FILE.method.json. --request-id is used for first creation; retained pending ID wins on retry. Default server comes from the sidecar, then the online default.

Result and changes:
JSON with workflow_id, version_id, server, url, confirmed:true and document_sha256 after reading back the exact saved version; confirmed saves also include version_number. Updates FILE.method.json. Unchanged draft: unchanged:true, no new version.

Errors:
Invalid method; missing reason; pending changed payload; wrong server; stale base (409). See recovery before retrying.

Example:

```sh
method save edit.method --reason 'Give each output a clear description.'
```

## update

Save a full method against an explicit base version.

Usage:

```sh
method update WORKFLOW_ID --file FILE --base-version VERSION_ID --reason TEXT [--server URL]
```

Arguments and defaults:
All listed non-server arguments required. Prefer get --out and save for normal editing. This lower-level command does not read or update the local sidecar. It validates the whole document.

Result and changes:
JSON {version_id,version_number}. Creates an online version. After success, use get --out NEW_FILE for further edits.

Errors:
Stale base (409); invalid method; missing reason. A repeated update returns the saved version only when parent, contents and reason still match the latest version.

Example:

```sh
method update wf_example --file edit.method --base-version version_example --reason 'Clarify the query.'
```

## status

Check installation and sign-in without listing Methods or starting login.

Usage:

```sh
method status [--server URL]
```

Arguments and defaults:
No required arguments. Checks the selected server with the current credential when one exists.

Result and changes:
JSON {installed:true,server,signed_in}. A missing or expired credential returns signed_in:false. Does not print account details.

Errors:
Network and server errors exit 1; they are not reported as signed out.

Example:

```sh
method status
```

## list

Find your online methods.

Usage:

```sh
method list [--server URL]
```

Arguments and defaults:
No required arguments.

Result and changes:
Server JSON containing methods. No changes.

Example:

```sh
method list
```

## steps

Read all complete step definitions in a saved method.

Usage:

```sh
method steps WORKFLOW_ID [--version VERSION_ID] [--server URL]
```

Arguments and defaults:
Default: latest version. Use step with two IDs to read one saved step.

Result and changes:
JSON {version_id,steps}. No changes.

Errors:
Missing method or version.

Example:

```sh
method steps wf_example
```

## step

Read one online step. For local edits use step add/update/remove/move.

Usage:

```sh
method step WORKFLOW_ID STEP_ID [--version VERSION_ID] [--server URL]
```

Arguments and defaults:
Both IDs required. Default: latest version. Subcommand words add, update, remove, move are reserved for local editing.

Result and changes:
JSON {version_id,step}. No changes.

Errors:
Missing method, version, or step. Use method steps to find step IDs.

Example:

```sh
method step wf_example search
```

## login

Connect this computer with browser approval.

Usage:

```sh
method login [--server URL]
```

Arguments and defaults:
No credentials in chat or command flags. Method opens the sign-in/approval page and waits. Connection is saved per server in ~/.config/method. Sign in again if access expires or is revoked.

Result and changes:
Sign-in instructions and status text. Stores a private local credential after approval. Remote commands also start login when no credential exists.

Errors:
Approval expired, denied, or network unavailable. Repeat login when ready.

Example:

```sh
method login
```

## logout

Disconnect this computer from the selected Method server.

Usage:

```sh
method logout [--server URL]
```

Arguments and defaults:
No required arguments. Select the same server used for login.

Result and changes:
Status text. Revokes remote access, then removes the local credential.

Errors:
If remote revocation fails, the local credential remains. Retry online, or use devices/revoke from another connected computer.

Example:

```sh
method logout
```

## devices

List authorized computers.

Usage:

```sh
method devices [--server URL]
```

Arguments and defaults:
No required arguments.

Result and changes:
Server JSON device list. No changes.

Example:

```sh
method devices
```

## revoke

Revoke a computer's Method access.

Usage:

```sh
method revoke DEVICE_ID [--server URL]
```

Arguments and defaults:
Use the exact ID from method devices. This changes account access.

Result and changes:
Server JSON confirmation. The selected device can no longer use that credential.

Errors:
Unknown device ID.

Example:

```sh
method revoke device_example
```

## runs

Read saved run summaries.

Usage:

```sh
method runs [--method WORKFLOW_ID] [--server URL]
```

Arguments and defaults:
Default: all methods. --method filters the list.

Result and changes:
Server JSON containing runs. No changes.

Example:

```sh
method runs --method wf_example
```

## logs

Read saved run evidence before a repair.

Usage:

```sh
method logs RUN_ID [--server URL]
```

Arguments and defaults:
Use a run ID from method runs. Saved logs may be incomplete if upload failed.

Result and changes:
Server JSON containing the run, inputs, outputs, checks and events. No execution or changes.

Errors:
Missing run.

Example:

```sh
method logs run_example > run.json
```

## sync

Retry upload of records from an existing local run.

Usage:

```sh
method sync RUN_DIRECTORY [--server URL]
```

Arguments and defaults:
Directory must contain method-sync.json. Default destination is the saved run's server. Do not use a new business run to repair an upload.

Result and changes:
Upload status text. Updates dashboard records and local sync metadata. Does not execute steps.

Errors:
Missing run/sync records; access or network error. Keep the original run directory and retry.

Example:

```sh
method sync .method-runs/wf_example/saved-run
```

## run

Execute a saved method locally and upload its run records.

Usage:

```sh
method run WORKFLOW_ID [--version VERSION_ID] [--server URL] [OPTIONS]
```

Arguments and defaults:
Current methods optionally use runtime.json beside a local file, or in the current folder for a saved ID. --workspace selects a different folder. --config FILE overrides the config. See method authoring execution. Optional --state FILE initializes state for a new run. Resume with --resume --run-dir DIR; authorize unfinished work with --retry STEP:ITERATION.

Older saved methods use these options:
Default version: latest; pin --version for repeatable runs. Read get first.
--workspace DIR: working folder; default current folder.
--inputs FILE: JSON object matching method.inputs; asks in a terminal if omitted. In noninteractive use, supply it when inputs are defined.
--resources FILE: JSON resource map, e.g. {"data":{"description":"CRM folder","path":"/absolute/data"}}. No secrets. Names match environment declarations. Each description gives the local connection instructions; Method supplies them alongside the method requirement. File connections default to workspace.
--run-dir DIR: new run folder; default .method-runs/<online method ID>/<timestamp>.
--resume: continue a saved Method run; requires --run-dir and its original --version. Uses saved inputs/resources unless supplied.
--retry INVOCATION: allow another attempt for an incomplete invocation on resume; repeat flag for multiple IDs. Inspect changes first.
--recoveries FILE: JSON object mapping invocation IDs to inspected step results; checks still run.
--human FILE: JSON {steps:{invocation:{outputs:{name:value}}}}; default empty. Human work waits for an actual answer.
--state-dir DIR: persistent data folder; default <workspace>/.method/data/<method ID>.
--concurrency N: maximum active operations; default 4, maximum 32.
--timeout-ms N: process time limit; default 300000.
--model MODEL: step model; default Codex user setting.
--verifier-model MODEL: check model; default --model, then Codex user setting.
--verbose: print each runtime event.
Use method doctor to check the installed Node and Codex tools.

Result and changes:
Progress and final status text; local result.json and run evidence; dashboard run link when synced. The runtime executes the method's declared scripts, calls, agents, and checks. Executes trusted local processes; changes declarations do not enforce permissions. Current runs exit 0 on completion, 1 on failure, and 2 when human input is needed. Older saved runs can use exit 2 for a failed run.

Errors:
Missing inputs/access, failed check, timeout, unsafe resume/version mismatch, upload failure. See recovery. Never retry a business write without inspecting its saved changes.

Example:

```sh
method run wf_example --version version_example --config runtime.json --workspace . --inputs inputs.json
```

## migrate

Create a current Method version from an older method.

Usage:

```sh
method migrate FILE --model PROFILE --timeout-ms N --max-agent-turns N --max-model-requests N [--output FILE]
```

Arguments and defaults:
Choose the model profile and finite limits explicitly. The source stays unchanged. Review migration warnings and prepare matching operator configuration before running.

Result and changes:
Converted method and warnings.

Errors:
Missing model or limits; output file already exists.

Example:

```sh
method migrate old.method --model worker --timeout-ms 60000 --max-agent-turns 8 --max-model-requests 12 --output current.method
```

## Copy a message: syntax reference

```yaml
format: method/3.1
name: Copy a message
goal: Preserve every character of a supplied message.
inputs:
  message:
    type: text
    description: The complete message to preserve.
steps:
  copy:
    purpose: Preserve the exact message.
    in:
      message: inputs.message
    do:
      kind: run
      runtime: node
      entrypoint: copy.cjs
    limits:
      timeout_ms: 10000
    out:
      copied_message:
        type: text
        description: The complete unchanged message.
    check:
      equals:
        actual: copied_message
        expected: message
result: copied_message
```

## Example: build with editing commands

This small syntax example shows the optional editing commands. Use an empty folder.

```sh
set -eu
cat > 'copy.cjs' <<'METHOD_EXAMPLE'
let text="";process.stdin.on("data",x=>text+=x);process.stdin.on("end",()=>console.log(JSON.stringify({copied_message:JSON.parse(text).message})));
METHOD_EXAMPLE

cat > 'inputs.yaml' <<'METHOD_EXAMPLE'
message:
  type: text
  description: The complete message to preserve.
METHOD_EXAMPLE

cat > 'copy.yaml' <<'METHOD_EXAMPLE'
purpose: Preserve the exact message.
in:
  message: inputs.message
do:
  kind: run
  runtime: node
  entrypoint: copy.cjs
limits:
  timeout_ms: 10000
out:
  copied_message:
    type: text
    description: The complete unchanged message.
METHOD_EXAMPLE

cat > 'check.yaml' <<'METHOD_EXAMPLE'
equals:
  actual: copied_message
  expected: message
METHOD_EXAMPLE

cat > 'inputs.json' <<'METHOD_EXAMPLE'
{"message":"Hello"}
METHOD_EXAMPLE

cat > 'runtime.json' <<'METHOD_EXAMPLE'
{
  "allow_local_processes": true,
  "runtimes": {
    "node": {
      "command": "node",
      "version": "22+"
    }
  },
  "limits": {
    "timeout_ms": 60000,
    "max_model_requests": 0,
    "max_invocations": 10,
    "max_tool_calls": 0,
    "max_output_bytes": 1000000,
    "max_request_bytes": 1000000
  }
}
METHOD_EXAMPLE

method 'init' 'message.method' '--name' 'Copy a message' '--goal' 'Preserve every character of a supplied message.'
method 'set' 'message.method' '/inputs' '--value-file' 'inputs.yaml'
method 'step' 'add' 'message.method' '--id' 'copy' '--value-file' 'copy.yaml'
method 'check' 'set' 'message.method' 'copy' '--value-file' 'check.yaml'
method 'set' 'message.method' '/result' '--text' 'copied_message'
method 'validate' 'message.method'
```
