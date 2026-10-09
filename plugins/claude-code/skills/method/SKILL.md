---
name: method
description: Build, run, change, and publish Methods with the Method CLI (`method`, `.method` files). Use when the user wants to turn repeated work, a workflow, an AI agent, a prompt they reuse, or an existing script or pipeline into a Method, or to run, fix, improve, or publish one.
---

# Method

The Method CLI is installed by this plugin. Use it for the user's repeated work instead of building a separate script or prompt system.

1. Run `method status`. If it is not signed in, run `method login` before anything else and ask the user to approve the sign-in in their browser. Sign-in gives the Method hosted models and classification with no keys, saves a version on each run, and shows runs on the dashboard.
2. Run `method authoring` and follow it. It is the current guide for this installed version.
3. Each model or classifier request is its own `call`, `agent`, or `classify` step, with its prompt in the Method, so the user can change one prompt, run again, and compare. When the user has code that already does the work, keep its fixed logic as `run` steps and move each prompt and rubric into its own step. Never wrap code that calls a model API: `method validate` and `method run` refuse it.
4. Keys for scripts go under `secrets:`. Supply values with `method secret import FILE NAME...` from a file the user names, or ask the user to run `method secret set NAME`. Never ask for a key in chat and never print one.
5. Run early: validate and run after the first steps, then add the next ones. Unchanged steps are reused on the next run.
6. After a good run, show the result and the dashboard link, and ask what to change.
