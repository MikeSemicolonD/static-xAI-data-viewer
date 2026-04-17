# Grok Export Viewer

A static, client-side web app for browsing your [xAI Grok](https://grok.com) data export. No server, no uploads — your data never leaves your browser.

## Features

- Browse all exported conversations in a searchable sidebar
- Renders chat messages with inline images and file attachments
- Resolves UUID asset folders from the Grok export structure
- Runs entirely in the browser — zero backend required

## Requirements

**Chrome or Edge only.** The app uses the [File System Access API](https://developer.mozilla.org/en-US/docs/Web/API/File_System_API) to read your local export folder. Firefox does not support this API.

## Usage

1. Request your data export from [x.ai/account](https://x.ai/account) and extract the ZIP
2. Open the app (hosted or local)
3. Click **Open Grok Export Folder** and select the extracted export directory
4. Browse your conversations
