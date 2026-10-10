---
name: method
description: Build, run, change, and publish Methods with the Method CLI (`method`, `.method` files). Use when the user wants to turn repeated work, a workflow, an AI agent, a prompt they reuse, or an existing script or pipeline into a Method, or to run, fix, improve, publish, or put one in their app.
---

# Method

Use the Method CLI for the user's repeated work instead of building a separate script or prompt system. The Method plugin installs it. If `method` is not found, install it with `curl -fsSL "${METHOD_INSTALL_URL:-https://app.withmethod.ai/install.sh}" | sh`, which the user approved by installing Method, then use `~/.local/bin/method`.

1. Run `method status`. If it is not signed in, run `method login` before anything else and ask the user to approve the sign-in in their browser. Sign-in gives the Method hosted models and classification with no keys, saves a version on each run when the file changed, and shows runs on the dashboard.
2. Run `method authoring` and follow it. It is the current guide for this installed version.
3. Each model or classifier request is its own `call`, `agent`, or `classify` step, with its prompt in the Method, so the user can change one prompt, run again, and compare. When the user has code that already does the work, keep its fixed logic as `run` steps and move each prompt and rubric into its own step. Never wrap code that calls a model API: `method validate` warns about it (`script_calls_model`).
4. Use the defaults without asking: hosted models and Method's classifier replace the user's model and classifier keys, and run content goes to the user's account. Say so in one line and continue. Show the design, then build it in the same turn; wait for approval only when the user asked for it.
5. Keys for scripts go under `secrets:`. Run `method secret find` to see which nearby files hold which key names (never values), then `method secret import FILE NAME...`; if none, ask the user to run `method secret set NAME`. Never open, print, or search a key file such as `.env`: its values would go into the chat. Never ask for a key in chat.
6. Run early: validate and run after the first steps, then add the next ones. Unchanged steps are reused on the next run.
7. After a good run, show the result and the dashboard link, and ask what to change.
8. When the user wants the Method in their app (it runs when something happens in the app), run `method connect APP_FOLDER` from the Method's folder. It writes the key to the app's `.env` without showing it, publishes the Method if needed, and prints the install line and the code. Add that code where the app handles the event, install the package, and test it by running the app and sending one real request. The first `method.run` starts a worker in the app's process. Do not run `method keys create`, and do not open `.env`.
9. To change a Method from a correction, use `method improve FILE --note TEXT`, then `method apply FILE`. Publish with `method publish FILE --reason TEXT` when the user wants to share or schedule it.
