# [xAI (Grok) Export Viewer](https://mikesemicolond.github.io/static-xAI-data-viewer/)

A static, client-side web app for browsing your [xAI Grok](https://grok.com) data export. No server, no uploads — your **data stays local** and never leaves your browser.

## Features

- Browse all exported conversations in a searchable sidebar
- Renders chat messages with inline images and file attachments
- Resolves UUID asset folders from the Grok export structure
- Runs entirely in the browser — zero backend required

## Requirements

Chrome and Edge use the [File System Access API](https://developer.mozilla.org/en-US/docs/Web/API/File_System_API); Firefox and Safari fall back to a standard directory-picker input. **Either way, your data stays local.**

## Usage

1. Request your data export from [accounts.x.ai/data](https://accounts.x.ai/data) and extract the ZIP
    - *Data* &#8594; *Download account data* &#8594; *Download*
2. Open [the app](<https://mikesemicolond.github.io/static-xAI-data-viewer/>)
3. Click **Open Grok Export Folder** and select the extracted folder (the viewer will auto-detect your export; if multiple are present, you'll be prompted to pick one)
4. Browse your conversations
