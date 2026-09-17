# Results on the run page

Online Method runs attach declared file outputs to their run record. The CLI reads only file outputs and assets named in a website manifest. It does not scan the workspace or upload input folders. Each uploaded file must match the recorded SHA-256 hash. Files under `sensitive/` are excluded.

A run can attach up to 20,000 files, with 100 MB of decoded content and 20 MB of transferred file data. A file that is missing, changed, outside the allowed output folders, or over the limit remains a reference. The page explains why it is unavailable. Binary files can be downloaded. Text files can be read and downloaded.

`method inspect RUN_DIRECTORY --include-files --out inspection.json` creates a portable record with file contents. `method sync RUN_DIRECTORY` uploads attachments to the existing run without executing its steps again. This also works for a completed run. Local runs without a dashboard link remain local.

## Websites

Declare a file output with `format: method-website`. The output file contains a JSON manifest:

```json
{
  "schema": "method-website/1",
  "title": "Project update",
  "entrypoint": "index.html",
  "files": [
    { "path": "index.html", "sha256": "<SHA-256 of the HTML bytes>", "media_type": "text/html" },
    { "path": "assets/style.css", "sha256": "<SHA-256 of the CSS bytes>", "media_type": "text/css" }
  ]
}
```

Paths are relative to the manifest's directory. List each HTML page, script, stylesheet, image, font, and data file the website uses. Paths must not be absolute or contain `..`. The start page must be listed as `text/html`. Return the manifest using the normal file value: `{ "path": "website/manifest.json", "sha256": "<manifest hash>" }`.

The run page offers **Open website** once all listed files are attached. It also offers **Download website**, which saves a ZIP with the same directory structure. Preview links expire after one hour; open the website again from the run to get a new link. Websites run in an isolated browser frame. They can load their listed assets and data, but cannot read the Method session, contact external services, submit forms, or navigate the main app. Remote API connections are not part of a saved website result.

Use `examples/website-result.method`, `examples/build-website-result.mjs`, and `examples/runtime.json` as a complete example. The example includes a stylesheet, a script, and JSON data loaded by the script.

Existing workflows do not gain a website file list automatically. Update the output-producing script to write this manifest, and declare its format in a new Method version. Old runs with ordinary file outputs can still attach and download those files; Method does not guess the contents of an old, task-specific file list.

Complete websites are transferred and stored as one ZIP. The server checks every member against the declared path and hash before it accepts the upload. The browser can open the website normally or download the same ZIP. Older runs with separately attached assets remain readable.
