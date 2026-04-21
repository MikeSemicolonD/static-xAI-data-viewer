// ─────────────────────────────────────────────────────────────────────────────
// Grok Export Viewer — app.js
// Plain JS + jQuery. Requires Chrome/Edge (File System Access API).
// ─────────────────────────────────────────────────────────────────────────────

// ── State ────────────────────────────────────────────────────────────────────

const AppState = {
  rootHandle:       null,   // FileSystemDirectoryHandle
  conversations:    [],     // normalized conversation objects
  uuidFolders:      [],     // { name, handle } for browseable dirs
  assetHandles:     new Map(), // uuid → FileSystemDirectoryHandle (prod-mc-asset-server entries)
  activeConvId:     null,
  filteredConvs:    [],
  activeObjectURLs: [],     // object URLs pending revocation
};

// ── Regex ────────────────────────────────────────────────────────────────────

const UUID_STRICT_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UUID_LOOSE_RE  = /^[0-9a-f\-]{32,}$/i;
const IMAGINE_LINK_RE = /https:\/\/grok\.com\/imagine\/post\/[0-9a-f\-]+/gi;
const GROK_RENDER_RE = /<grok:render\b[^>]*>[\s\S]*?<\/grok:render>/g;

// Best-guess base for Grok-hosted generated image assets. Export files don't
// include the actual image bytes; this lets the user click through (or view
// inline) when logged into grok.com in the same browser. Swap if wrong.
const GROK_ASSET_BASE = 'https://assets.grok.com/';

// ── Date formatting ───────────────────────────────────────────────────────────

function formatDate(d, opts) {
  if (!(d instanceof Date) || isNaN(d.getTime())) return '';
  const o = opts || {};
  if (o.timeOnly) {
    return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  }
  if (o.short) {
    return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  }
  return d.toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit',
  });
}

// ── ErrorUI ───────────────────────────────────────────────────────────────────

const ErrorUI = (() => {
  let dismissTimer = null;

  function showGlobal(msg) {
    clearGlobal();
    const $banner = $('<div id="error-banner"></div>');
    $banner.append($('<span>').text('⚠ ' + msg));
    const $btn = $('<button class="error-dismiss" aria-label="Dismiss">✕</button>');
    $btn.on('click', clearGlobal);
    $banner.append($btn);
    $('body').append($banner);

    if (dismissTimer) clearTimeout(dismissTimer);
    dismissTimer = setTimeout(clearGlobal, 8000);
  }

  function clearGlobal() {
    if (dismissTimer) { clearTimeout(dismissTimer); dismissTimer = null; }
    $('#error-banner').remove();
  }

  function showInline($container, msg) {
    $container.append($('<div class="error-inline">').text('⚠ ' + msg));
  }

  return { showGlobal, clearGlobal, showInline };
})();

// ── JsonParser ────────────────────────────────────────────────────────────────

const JsonParser = (() => {
  function parse(jsonText) {
    let obj;
    try {
      obj = JSON.parse(jsonText);
    } catch (e) {
      ErrorUI.showGlobal('prod-grok-backend.json is not valid JSON: ' + e.message);
      return [];
    }
    return normalizeRoot(obj);
  }

  function normalizeRoot(obj) {
    // Handle top-level array
    if (Array.isArray(obj)) return obj.map(normalizeConversation);

    // Look for a conversations array under common key names
    for (const key of ['conversations', 'chats', 'messages', 'data']) {
      if (Array.isArray(obj[key])) return obj[key].map(normalizeConversation);
    }

    // Single conversation object
    if (obj && typeof obj === 'object' && ('title' in obj || 'responses' in obj || 'messages' in obj)) {
      return [normalizeConversation(obj)];
    }

    console.warn('[GrokViewer] Unrecognized JSON structure — keys:', Object.keys(obj || {}));
    ErrorUI.showGlobal('Could not find conversations in prod-grok-backend.json. Check the console for details.');
    return [];
  }

  function normalizeConversation(raw) {
    // Actual Grok export wraps fields under a nested "conversation" object
    const c = raw.conversation ?? raw;
    return {
      id:         c.id         ?? c.conversation_id ?? c.uuid ?? crypto.randomUUID(),
      title:      c.title      ?? c.name            ?? c.subject ?? '(Untitled)',
      createTime: parseTimestamp(c.create_time ?? c.created_at ?? c.timestamp),
      messages:   normalizeMessages(raw),
    };
  }

  function normalizeMessages(raw) {
    const arr = raw.responses ?? raw.messages ?? raw.turns ?? raw.history ?? [];
    if (!Array.isArray(arr)) return [];
    return arr.map(normalizeMessage);
  }

  function normalizeMessage(msg) {
    // Actual Grok export wraps each message under a nested "response" object
    const m = msg.response ?? msg;
    return {
      sender:      normalizeSender(m.sender ?? m.role ?? m.author ?? 'unknown'),
      content:     m.message ?? m.content ?? m.text ?? m.body ?? '',
      attachments: Array.isArray(m.file_attachments) ? m.file_attachments : [],
      cards:       parseCardAttachments(m.card_attachments_json),
      legacyImages: parseLegacyImages(m.generated_image_urls, m.query, m.error),
      createTime:  parseTimestamp(m.create_time ?? m.created_at ?? m.timestamp),
      metadata:    m.metadata ?? {},
    };
  }

  // Accepts ISO strings, numeric epoch ms, and Mongo extended JSON
  // ({ $date: { $numberLong: "..." } } or { $date: "..." }).
  function parseTimestamp(raw) {
    if (raw == null) return null;
    if (typeof raw === 'number') return new Date(raw);
    if (typeof raw === 'string') {
      const d = new Date(raw);
      return isNaN(d.getTime()) ? null : d;
    }
    if (typeof raw === 'object') {
      const inner = raw.$date ?? raw;
      if (typeof inner === 'string') return parseTimestamp(inner);
      if (inner && inner.$numberLong) return new Date(Number(inner.$numberLong));
    }
    return null;
  }

  function parseLegacyImages(urls, query, error) {
    if (!Array.isArray(urls) || urls.length === 0) return [];
    const prompt = typeof query === 'string' ? query : '';
    const err    = typeof error === 'string' ? error : '';
    const successful = urls.filter(u => typeof u === 'string' && u.length > 0);
    if (successful.length > 0) {
      return successful.map(u => ({ url: u, prompt, error: '' }));
    }
    // All slots empty — generation failed/moderated. Render one placeholder
    // card so the user can see the prompt and the error reason.
    if (prompt || err) return [{ url: '', prompt, error: err }];
    return [];
  }

  function parseCardAttachments(raw) {
    if (!Array.isArray(raw)) return [];
    const byId = new Map();
    for (const entry of raw) {
      if (typeof entry !== 'string') continue;
      let parsed;
      try { parsed = JSON.parse(entry); } catch (e) { continue; }
      if (!parsed || parsed.cardType !== 'generated_image_card' || !parsed.id) continue;
      if (!byId.has(parsed.id)) byId.set(parsed.id, parsed);
    }
    return Array.from(byId.values());
  }

  function normalizeSender(raw) {
    const s = String(raw).toLowerCase();
    if (['user', 'human', 'you'].includes(s)) return 'user';
    if (['grok', 'assistant', 'ai', 'bot', 'model'].includes(s)) return 'grok';
    return 'unknown';
  }

  return { parse };
})();

// ── ContentDecoder ────────────────────────────────────────────────────────────

const ContentDecoder = (() => {
  const SIZE_LIMIT = 25 * 1024 * 1024; // 25 MB

  async function decodeContentFile(fileHandle) {
    const file = await fileHandle.getFile();
    const buffer = await file.arrayBuffer();

    let bytes = new Uint8Array(buffer);

    if (buffer.byteLength <= SIZE_LIMIT) {
      const decoded = tryHexDecode(buffer);
      if (decoded) bytes = decoded;
    }

    const typeInfo = detectType(bytes);
    return { ...typeInfo, bytes };
  }

  function tryHexDecode(buffer) {
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(buffer); }
    catch (e) { return null; }

    const stripped = text.replace(/\s+/g, '');
    if (stripped.length === 0 || stripped.length % 2 !== 0) return null;
    if (!/^[0-9a-fA-F]+$/.test(stripped)) return null;

    const out = new Uint8Array(stripped.length / 2);
    for (let i = 0; i < out.length; i++) {
      out[i] = parseInt(stripped.slice(i * 2, i * 2 + 2), 16);
    }
    return out;
  }

  function detectType(bytes) {
    // PNG
    if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47)
      return { type: 'image', mimeType: 'image/png', ext: 'png' };

    // JPEG
    if (bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF)
      return { type: 'image', mimeType: 'image/jpeg', ext: 'jpg' };

    // GIF
    if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38)
      return { type: 'image', mimeType: 'image/gif', ext: 'gif' };

    // RIFF/WEBP
    if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
        bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50)
      return { type: 'image', mimeType: 'image/webp', ext: 'webp' };

    // PDF
    if (bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46)
      return { type: 'pdf', mimeType: 'application/pdf', ext: 'pdf' };

    // Try text-based types
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch (e) { return { type: 'binary', mimeType: 'application/octet-stream', ext: 'bin' }; }

    // JSON
    try {
      JSON.parse(text);
      return { type: 'json', mimeType: 'application/json', ext: 'json' };
    } catch (e) { /* not JSON */ }

    // CSV heuristic: ≥2 newlines, consistent comma count across first 5 rows, >1 column
    if (isLikelyCsv(text))
      return { type: 'csv', mimeType: 'text/csv', ext: 'csv' };

    return { type: 'text', mimeType: 'text/plain', ext: 'txt' };
  }

  function isLikelyCsv(text) {
    const lines = text.split('\n').filter(l => l.trim() !== '');
    if (lines.length < 2) return false;
    const sample = lines.slice(0, 5);
    const counts = sample.map(l => (l.match(/,/g) || []).length);
    if (counts[0] < 1) return false;
    return counts.every(c => c === counts[0]);
  }

  function bytesToObjectURL(bytes, mimeType) {
    const blob = new Blob([bytes], { type: mimeType });
    const url = URL.createObjectURL(blob);
    AppState.activeObjectURLs.push(url);
    return url;
  }

  async function renderContentFile($container, fileHandle) {
    $container.html('<span class="file-loading">Decoding…</span>');
    let result;
    try {
      result = await decodeContentFile(fileHandle);
    } catch (e) {
      ErrorUI.showInline($container, 'Could not decode file: ' + e.message);
      return;
    }

    const { type, mimeType, bytes } = result;
    $container.empty();

    if (type === 'image') {
      const url = bytesToObjectURL(bytes, mimeType);
      const $img = $('<img loading="lazy" alt="Decoded image">').attr('src', url);
      $container.append($img);

    } else if (type === 'json') {
      const text = new TextDecoder().decode(bytes);
      const pretty = JSON.stringify(JSON.parse(text), null, 2);
      $container.append($('<pre>').text(pretty));

    } else if (type === 'csv') {
      const text = new TextDecoder().decode(bytes);
      $container.append(buildCsvTable(text));

    } else if (type === 'pdf') {
      const url = bytesToObjectURL(bytes, mimeType);
      const $a = $('<a target="_blank" rel="noopener noreferrer">⬇ Download / View PDF</a>')
        .attr('href', url).css({ color: 'var(--accent-blue)', fontSize: '0.875rem' });
      $container.append($a);

    } else if (type === 'binary') {
      $container.append($('<span class="file-too-large">').text('Binary file — no preview available.'));

    } else {
      const text = new TextDecoder().decode(bytes);
      $container.append($('<pre>').text(text));
    }
  }

  function buildCsvTable(text) {
    const rows = text.trim().split('\n').map(r => r.split(','));
    const $table = $('<table class="content-table">');
    const $thead = $('<thead>');
    const $tbody = $('<tbody>');

    if (rows.length === 0) return $table;

    const $headerRow = $('<tr>');
    rows[0].forEach(cell => $headerRow.append($('<th>').text(cell.trim())));
    $thead.append($headerRow);

    for (let i = 1; i < rows.length; i++) {
      const $tr = $('<tr>');
      rows[i].forEach(cell => $tr.append($('<td>').text(cell.trim())));
      $tbody.append($tr);
    }

    return $table.append($thead).append($tbody);
  }

  return { renderContentFile };
})();

// ── MessageRenderer ───────────────────────────────────────────────────────────

const MessageRenderer = (() => {
  function revokeObjectURLs() {
    AppState.activeObjectURLs.forEach(u => URL.revokeObjectURL(u));
    AppState.activeObjectURLs = [];
  }

  function renderConversation(conv) {
    revokeObjectURLs();

    const $header = $('#chat-header').empty().removeAttr('hidden');
    $header.append($('<span class="chat-header-title">').text(conv.title));
    if (conv.createTime) {
      $header.append($('<span class="chat-header-date">').text(formatDate(conv.createTime, { short: true })));
    }
    const $messages = $('#chat-messages').empty().removeAttr('hidden');

    conv.messages.forEach(msg => $messages.append(buildMessageEl(msg)));
  }

  function buildMessageEl(msg) {
    const senderLabel = msg.sender === 'user' ? 'You' : msg.sender === 'grok' ? 'Grok' : 'Unknown';
    const $el = $('<div>').addClass('message message--' + msg.sender);
    const $senderRow = $('<div class="message-sender">').text(senderLabel);
    if (msg.createTime) {
      $senderRow.append($('<span class="message-time">').text(formatDate(msg.createTime)));
    }
    $el.append($senderRow);

    const $body = $('<div class="message-body">');
    $body.html(processMessageContent(String(msg.content || ''), msg.cards || []));
    $el.append($body);

    if (msg.legacyImages && msg.legacyImages.length > 0) {
      msg.legacyImages.forEach(img => {
        $body.append(buildLegacyImageCardHtml(img));
      });
    }

    // Render file attachments (images from prod-mc-asset-server)
    if (msg.attachments && msg.attachments.length > 0) {
      const $attachments = $('<div class="message-attachments">');
      msg.attachments.forEach(uuid => {
        const dirHandle = AppState.assetHandles.get(uuid);
        if (!dirHandle) return;
        const $wrap = $('<div class="attachment-wrap">');
        $attachments.append($wrap);
        renderAttachment($wrap, dirHandle);
      });
      if ($attachments.children().length > 0) $el.append($attachments);
    }

    return $el;
  }

  async function renderAttachment($wrap, dirHandle) {
    try {
      let contentHandle = null;
      for await (const [name, handle] of dirHandle.entries()) {
        if (handle.kind === 'file') { contentHandle = handle; break; }
      }
      if (!contentHandle) return;
      await ContentDecoder.renderContentFile($wrap, contentHandle);
    } catch (e) {
      ErrorUI.showInline($wrap, 'Could not load attachment');
    }
  }

  function escapeHtml(str) {
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function renderImagineLink(url) {
    // Only render URLs that truly start with the known prefix
    if (!url.startsWith('https://grok.com/imagine/post/')) return escapeHtml(url);
    const safe = escapeHtml(url);
    return `<a class="imagine-badge" href="${safe}" target="_blank" rel="noopener noreferrer">🎬 View on Grok Imagine →</a>`;
  }

  function renderMarkdown(text) {
    const blocks = [];

    // 1. Extract fenced code blocks to protect them
    text = text.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) => {
      const idx = blocks.length;
      const langClass = lang ? ` class="lang-${escapeHtml(lang)}"` : '';
      blocks.push(`<pre><code${langClass}>${escapeHtml(code)}</code></pre>`);
      return `\x00BLOCK_${idx}\x00`;
    });

    // 2. Escape remaining HTML
    text = escapeHtml(text);

    // 3. Inline formatting
    text = text.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    text = text.replace(/__(.+?)__/g, '<strong>$1</strong>');
    text = text.replace(/\*(.+?)\*/g, '<em>$1</em>');
    text = text.replace(/_(.+?)_/g, '<em>$1</em>');
    text = text.replace(/`([^`]+)`/g, '<code>$1</code>');

    // 4. Newlines to <br>
    text = text.replace(/\n/g, '<br>');

    // 5. Restore code blocks
    text = text.replace(/\x00BLOCK_(\d+)\x00/g, (_, i) => blocks[parseInt(i, 10)]);

    return text;
  }

  function processMessageContent(text, cards) {
    // Extract <grok:render> card blocks first, replace with sentinels that
    // survive escapeHtml/markdown, then swap for card HTML at the end.
    const cardRefs = [];
    text = text.replace(GROK_RENDER_RE, (match) => {
      const cardIdMatch   = match.match(/card_id="([^"]+)"/);
      const cardTypeMatch = match.match(/card_type="([^"]+)"/);
      const args = {};
      const innerMatch = match.match(/^<grok:render\b[^>]*>([\s\S]*?)<\/grok:render>$/);
      const inner = innerMatch ? innerMatch[1] : '';
      inner.replace(/<argument\s+name="([^"]+)">([\s\S]*?)<\/argument>/g, (_, name, val) => {
        args[name] = val;
        return '';
      });
      const idx = cardRefs.length;
      cardRefs.push({
        cardId:   cardIdMatch   ? cardIdMatch[1]   : null,
        cardType: cardTypeMatch ? cardTypeMatch[1] : null,
        args,
      });
      return '\x01CARD_' + idx + '\x01';
    });

    // Split on Grok Imagine URLs, render each segment
    const parts = text.split(IMAGINE_LINK_RE);
    const urls  = text.match(IMAGINE_LINK_RE) || [];

    let html = '';
    parts.forEach((part, i) => {
      html += renderMarkdown(part);
      if (urls[i]) html += renderImagineLink(urls[i]);
    });

    html = html.replace(/\x01CARD_(\d+)\x01/g, (_, i) => {
      const ref = cardRefs[parseInt(i, 10)];
      const data = (cards || []).find(c => c.id === ref.cardId);
      return buildCardHtml(ref, data);
    });

    return html;
  }

  function buildLegacyImageCardHtml(img) {
    const title = img.error ? 'Image generation failed' : 'Generated Image';
    return buildCardHtml(
      { cardId: 'legacy', args: { prompt: img.prompt || '' }, error: img.error || '' },
      { image_chunk: { imageUrl: img.url || '', imageTitle: title } }
    );
  }

  function buildCardHtml(ref, cardData) {
    const userPrompt = ref.args && ref.args.prompt ? ref.args.prompt : '';
    const chunk = cardData && cardData.image_chunk;
    const imageUrl        = chunk && chunk.imageUrl;
    const imageTitle      = (chunk && chunk.imageTitle) || 'Generated Image';
    const imageModel      = chunk && chunk.imageModel;
    const upsampledPrompt = chunk && chunk.imagePrompt && chunk.imagePrompt.prompt;

    let html = '<div class="grok-card grok-card--generated">';
    html += '<div class="grok-card-header">';
    html += '<span class="grok-card-icon">🎨</span>';
    html += '<span class="grok-card-title">' + escapeHtml(imageTitle) + '</span>';
    if (imageModel) html += '<span class="grok-card-model">' + escapeHtml(imageModel) + '</span>';
    html += '</div>';

    if (imageUrl) {
      const fullUrl = GROK_ASSET_BASE + encodeURI(imageUrl);
      const safeUrl = escapeHtml(fullUrl);
      html += '<a class="grok-card-image-link" href="' + safeUrl + '" target="_blank" rel="noopener noreferrer">';
      html += '<img class="grok-card-image" src="' + safeUrl + '" alt="' + escapeHtml(imageTitle) +
              '" loading="lazy" onerror="this.style.display=\'none\';var n=this.nextElementSibling;if(n)n.style.display=\'block\';" />';
      html += '<div class="grok-card-image-fallback">View on grok.com →</div>';
      html += '</a>';
    } else if (ref.error) {
      html += '<div class="grok-card-placeholder grok-card-placeholder--error">⚠ ' +
              escapeHtml(ref.error) + '</div>';
    } else if (ref.cardId) {
      html += '<div class="grok-card-placeholder">Image not available</div>';
    }

    const sections = [];
    if (userPrompt) {
      sections.push(
        '<div class="grok-card-prompt">' +
        '<div class="grok-card-prompt-label">Your instructions</div>' +
        '<div class="grok-card-prompt-body">' + escapeHtml(userPrompt) + '</div>' +
        '</div>'
      );
    }
    if (upsampledPrompt && upsampledPrompt !== userPrompt) {
      sections.push(
        '<div class="grok-card-prompt">' +
        '<div class="grok-card-prompt-label">Generated image prompt</div>' +
        '<div class="grok-card-prompt-body">' + escapeHtml(upsampledPrompt) + '</div>' +
        '</div>'
      );
    }
    if (sections.length) {
      html += '<details class="grok-card-prompts"><summary>Prompts</summary>' +
              sections.join('') + '</details>';
    }
    html += '</div>';
    return html;
  }

  return { renderConversation };
})();

// ── FolderBrowser ─────────────────────────────────────────────────────────────

const FolderBrowser = (() => {
  async function renderFolder(dirHandle, folderName) {
    MessageRenderer._revokeObjectURLs && MessageRenderer._revokeObjectURLs();

    $('#chat-header').text('📁 ' + folderName).removeAttr('hidden');

    const $messages = $('#chat-messages');
    $messages.empty().removeAttr('hidden');
    $messages.css({ display: 'block', padding: '0' });

    const $browser = $('<div class="folder-browser">');
    $browser.append($('<div class="folder-browser-title">').text('Files in ' + folderName));
    $messages.append($browser);

    const entries = [];
    for await (const [name, handle] of dirHandle.entries()) {
      if (handle.kind === 'file') entries.push({ name, handle });
    }

    entries.sort((a, b) => a.name.localeCompare(b.name));

    if (entries.length === 0) {
      $browser.append($('<p>').css({ color: 'var(--text-muted)', fontSize: '0.85rem' }).text('No files found.'));
      return;
    }

    entries.forEach(({ name, handle }) => {
      const $details = $('<details class="file-entry">');
      $details.append($('<summary>').text(name));
      const $preview = $('<div class="file-preview">');
      $details.append($preview);

      let loaded = false;
      $details.on('toggle', function () {
        if (this.open && !loaded) {
          loaded = true;
          ContentDecoder.renderContentFile($preview, handle);
        }
      });

      $browser.append($details);
    });
  }

  return { renderFolder };
})();

// ── SidebarController ─────────────────────────────────────────────────────────

const SidebarController = (() => {
  let allConvs = [];
  let renderOffset = 0;
  const PAGE_SIZE = 50;
  let observer = null;

  function renderConversations(convs) {
    allConvs = convs;
    renderOffset = 0;

    const $list = $('#conv-list').empty();
    $('#conv-count').text('(' + convs.length + ')');

    if (observer) { observer.disconnect(); observer = null; }

    appendPage($list);

    if (renderOffset < allConvs.length) {
      const $sentinel = $('<li class="load-sentinel" aria-hidden="true" style="height:1px">');
      $list.append($sentinel);

      observer = new IntersectionObserver(entries => {
        if (entries[0].isIntersecting) appendPage($list);
      }, { root: $list[0], rootMargin: '100px' });

      observer.observe($sentinel[0]);
    }
  }

  function appendPage($list) {
    const $sentinel = $list.find('.load-sentinel').detach();
    const slice = allConvs.slice(renderOffset, renderOffset + PAGE_SIZE);
    renderOffset += slice.length;

    slice.forEach(conv => {
      const $li = $('<li role="option" tabindex="0">')
        .addClass('conv-item')
        .attr('data-id', conv.id);
      $li.append($('<div class="conv-item-title">').text(conv.title));
      if (conv.createTime) {
        $li.append($('<div class="conv-item-date">').text(formatDate(conv.createTime, { short: true })));
      }

      if (conv.id === AppState.activeConvId) $li.addClass('conv-item--active');
      $list.append($li);
    });

    if (renderOffset < allConvs.length) {
      $list.append($sentinel);
    } else {
      if (observer) { observer.disconnect(); observer = null; }
    }
  }

  function renderFolders(folders) {
    const $list = $('#folder-list').empty();
    folders.forEach(({ name, handle }) => {
      const $li = $('<li role="option" tabindex="0">')
        .addClass('folder-item')
        .attr('data-name', name)
        .text('📁 ' + name);
      $list.append($li);
    });
  }

  function setActiveConversation(id) {
    if (id === AppState.activeConvId) return;
    AppState.activeConvId = id;
    $('.conv-item').removeClass('conv-item--active');
    $(`.conv-item[data-id="${CSS.escape(id)}"]`).addClass('conv-item--active');
    const conv = AppState.conversations.find(c => c.id === id);
    if (conv) MessageRenderer.renderConversation(conv);
  }

  function setActiveFolder(name) {
    const folder = AppState.uuidFolders.find(f => f.name === name);
    if (folder) FolderBrowser.renderFolder(folder.handle, folder.name);
  }

  return { renderConversations, renderFolders, setActiveConversation, setActiveFolder };
})();

// ── SearchController ──────────────────────────────────────────────────────────

const SearchController = (() => {
  let debounceTimer = null;

  function initSearch() {
    $('#search-input').on('input', function () {
      const q = $(this).val();
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => filterConversations(q), 250);
    });
  }

  function filterConversations(query) {
    if (!query || query.trim() === '') {
      AppState.filteredConvs = AppState.conversations;
    } else {
      const q = query.toLowerCase();
      AppState.filteredConvs = AppState.conversations.filter(conv => {
        if (conv.title.toLowerCase().includes(q)) return true;
        return conv.messages.some(m => String(m.content).toLowerCase().includes(q));
      });
    }
    SidebarController.renderConversations(AppState.filteredConvs);
  }

  return { initSearch };
})();

// ── FallbackFS ────────────────────────────────────────────────────────────────
// Adapter that turns a FileList from <input webkitdirectory> into objects
// shaped like FileSystemDirectoryHandle / FileSystemFileHandle so the rest of
// the app can treat both sources identically.

const FallbackFS = (() => {
  function makeDirNode(name) {
    const node = {
      kind: 'directory',
      name,
      _children: new Map(),
      async *entries() {
        for (const [childName, child] of this._children) yield [childName, child];
      },
    };
    return node;
  }

  function makeFileNode(name, file) {
    return {
      kind: 'file',
      name,
      _file: file,
      async getFile() { return this._file; },
    };
  }

  function buildRoot(fileList) {
    const files = Array.from(fileList);
    if (files.length === 0) return null;

    const rootName = files[0].webkitRelativePath.split('/')[0] || 'root';
    const root = makeDirNode(rootName);

    for (const file of files) {
      const parts = file.webkitRelativePath.split('/');
      // parts[0] is the root folder; descend through intermediate dirs, then attach file.
      let cursor = root;
      for (let i = 1; i < parts.length - 1; i++) {
        const segment = parts[i];
        let next = cursor._children.get(segment);
        if (!next) {
          next = makeDirNode(segment);
          cursor._children.set(segment, next);
        }
        cursor = next;
      }
      const leafName = parts[parts.length - 1];
      cursor._children.set(leafName, makeFileNode(leafName, file));
    }

    return root;
  }

  function pickDirectory() {
    return new Promise(resolve => {
      const input = document.getElementById('folder-input');
      if (!input) { resolve(null); return; }

      const onChange = () => {
        input.removeEventListener('change', onChange);
        const files = input.files;
        input.value = '';
        if (!files || files.length === 0) { resolve(null); return; }
        resolve(buildRoot(files));
      };
      input.addEventListener('change', onChange);
      input.click();
    });
  }

  return { pickDirectory, buildRoot };
})();

// ── FolderLoader ──────────────────────────────────────────────────────────────

const FolderLoader = (() => {
  const MAX_SEARCH_DEPTH = 3;

  let candidates = [];
  let currentHandle = null;
  const datasetCache = new Map();

  async function openFolder() {
    let handle;
    if ('showDirectoryPicker' in window) {
      try {
        handle = await window.showDirectoryPicker({ mode: 'read' });
      } catch (e) {
        if (e.name !== 'AbortError') ErrorUI.showGlobal('Could not open folder: ' + e.message);
        return;
      }
    } else {
      handle = await FallbackFS.pickDirectory();
      if (!handle) return;
    }
    AppState.rootHandle = handle;

    const found = await findExportRoots(handle, MAX_SEARCH_DEPTH);
    if (found.length === 0) {
      candidates = [];
      currentHandle = null;
      datasetCache.clear();
      renderSwitcher();
      await scanRoot(handle); // will surface the standard "not found" error
      return;
    }

    candidates = found;
    currentHandle = null;
    datasetCache.clear();
    renderSwitcher();

    if (found.length === 1) {
      await switchTo(found[0].handle);
    } else {
      showExportChooser(found);
    }
  }

  function snapshotCurrent() {
    return {
      conversations: AppState.conversations,
      filteredConvs: AppState.filteredConvs,
      uuidFolders:   AppState.uuidFolders,
      assetHandles:  new Map(AppState.assetHandles),
      activeConvId:  AppState.activeConvId,
      searchQuery:   $('#search-input').val() || '',
    };
  }

  function restoreSnapshot(s) {
    AppState.activeObjectURLs.forEach(u => URL.revokeObjectURL(u));
    AppState.activeObjectURLs = [];

    AppState.conversations = s.conversations;
    AppState.filteredConvs = s.filteredConvs;
    AppState.uuidFolders   = s.uuidFolders;
    AppState.assetHandles  = s.assetHandles;
    AppState.activeConvId  = s.activeConvId;

    $('#search-input').val(s.searchQuery);
    SidebarController.renderFolders(s.uuidFolders);
    SidebarController.renderConversations(s.filteredConvs);

    $('#welcome-screen').hide();
    $('#export-chooser').attr('hidden', true).empty();

    if (s.activeConvId) {
      SidebarController.setActiveConversation(s.activeConvId);
    } else {
      $('#chat-header, #chat-messages').attr('hidden', true).empty();
    }
    ErrorUI.clearGlobal();
  }

  async function switchTo(handle) {
    if (currentHandle && currentHandle !== handle) {
      datasetCache.set(currentHandle, snapshotCurrent());
    }
    currentHandle = handle;

    if (datasetCache.has(handle)) {
      restoreSnapshot(datasetCache.get(handle));
    } else {
      AppState.activeObjectURLs.forEach(u => URL.revokeObjectURL(u));
      AppState.activeObjectURLs = [];
      AppState.activeConvId = null;
      $('#search-input').val('');
      $('#chat-header, #chat-messages').attr('hidden', true).empty();
      $('#export-chooser').attr('hidden', true).empty();
      await scanRoot(handle);
    }
    renderSwitcher();
  }

  function renderSwitcher() {
    const $sel = $('#dataset-select');
    if (candidates.length <= 1) {
      $sel.attr('hidden', true).empty();
      return;
    }
    $sel.removeAttr('hidden').empty();
    candidates.forEach(({ handle, path }, i) => {
      const $opt = $('<option>').val(i).text(handle.name).attr('title', path || handle.name);
      if (handle === currentHandle) $opt.prop('selected', true);
      $sel.append($opt);
    });
  }

  function onSwitcherChange() {
    const idx = parseInt($('#dataset-select').val(), 10);
    const entry = candidates[idx];
    if (entry) switchTo(entry.handle);
  }

  async function findExportRoots(dirHandle, depth) {
    const found = [];
    async function walk(handle, path, remaining) {
      let hasJson = false;
      const subdirs = [];
      try {
        for await (const [name, entry] of handle.entries()) {
          if (entry.kind === 'file' && name === 'prod-grok-backend.json') hasJson = true;
          else if (entry.kind === 'directory') subdirs.push([name, entry]);
        }
      } catch (e) { return; }

      if (hasJson) { found.push({ handle, path }); return; }
      if (remaining <= 0) return;
      for (const [name, sub] of subdirs) {
        await walk(sub, path ? `${path}/${name}` : name, remaining - 1);
      }
    }
    await walk(dirHandle, dirHandle.name || '', depth);
    return found;
  }

  function showExportChooser(candidates) {
    $('#welcome-screen').hide();
    $('#chat-header, #chat-messages').attr('hidden', true);

    const $chooser = $('#export-chooser').empty().removeAttr('hidden');
    $chooser.append($('<h2>').text('Multiple exports found'));
    $chooser.append($('<p>').text('Select which export to open:'));

    const $list = $('<ul class="export-chooser-list">');
    candidates.forEach(({ handle, path }) => {
      const $btn = $('<button class="export-chooser-item">').text(path || handle.name);
      $btn.on('click', async () => {
        $chooser.attr('hidden', true).empty();
        await switchTo(handle);
      });
      $list.append($('<li>').append($btn));
    });
    $chooser.append($list);
  }

  async function scanRoot(dirHandle) {
    let jsonHandle = null;
    const folders = [];

    for await (const [name, handle] of dirHandle.entries()) {
      if (handle.kind === 'file' && name === 'prod-grok-backend.json') {
        jsonHandle = handle;
      } else if (handle.kind === 'directory') {
        folders.push({ name, handle });
        if (name === 'prod-mc-asset-server') {
          await indexAssetServer(handle);
        }
      }
    }

    AppState.uuidFolders = folders;
    SidebarController.renderFolders(folders);

    if (!jsonHandle) {
      if (folders.length === 0) {
        ErrorUI.showGlobal('prod-grok-backend.json not found. Make sure you open the root of your Grok export folder.');
      } else {
        ErrorUI.showGlobal('prod-grok-backend.json not found — showing folders only.');
      }
      return;
    }

    const text = await readFileText(jsonHandle);
    const convs = JsonParser.parse(text);
    AppState.conversations = convs;
    AppState.filteredConvs = convs;
    SidebarController.renderConversations(convs);
    ErrorUI.clearGlobal();

    $('#welcome-screen').hide();
  }

  async function indexAssetServer(assetDirHandle) {
    AppState.assetHandles.clear();
    for await (const [name, handle] of assetDirHandle.entries()) {
      if (handle.kind === 'directory' && UUID_STRICT_RE.test(name)) {
        AppState.assetHandles.set(name, handle);
      }
    }
  }

  async function readFileText(fileHandle) {
    const file = await fileHandle.getFile();
    return file.text();
  }

  return { openFolder, onSwitcherChange };
})();

// ── Entry Point ───────────────────────────────────────────────────────────────

$(function () {
  // Require either File System Access API or <input webkitdirectory>
  const hasFSAA = 'showDirectoryPicker' in window;
  const hasWebkitDir = 'webkitdirectory' in HTMLInputElement.prototype;
  if (!hasFSAA && !hasWebkitDir) {
    ErrorUI.showGlobal('Your browser does not support directory selection. Please use a recent version of Chrome, Edge, Firefox, or Safari.');
    $('#open-folder-btn, #welcome-open-btn').prop('disabled', true);
  }

  // Wire buttons
  $('#open-folder-btn').on('click', FolderLoader.openFolder);
  $('#welcome-open-btn').on('click', FolderLoader.openFolder);
  $('#dataset-select').on('change', FolderLoader.onSwitcherChange);

  // Conversation list click (event delegation)
  $('#conv-list').on('click keydown', '.conv-item', function (e) {
    if (e.type === 'keydown' && e.key !== 'Enter' && e.key !== ' ') return;
    SidebarController.setActiveConversation($(this).data('id'));
  });

  // Folder list click (event delegation)
  $('#folder-list').on('click keydown', '.folder-item', function (e) {
    if (e.type === 'keydown' && e.key !== 'Enter' && e.key !== ' ') return;
    SidebarController.setActiveFolder($(this).data('name'));
  });

  // Init search
  SearchController.initSearch();

  // Mobile sidebar toggle
  const $body = $('body');
  function closeSidebar() {
    $body.removeClass('sidebar-open');
    $('#sidebar-toggle').attr('aria-expanded', 'false');
    $('#sidebar-backdrop').attr('hidden', true);
  }
  function toggleSidebar() {
    const nowOpen = !$body.hasClass('sidebar-open');
    $body.toggleClass('sidebar-open', nowOpen);
    $('#sidebar-toggle').attr('aria-expanded', String(nowOpen));
    $('#sidebar-backdrop').attr('hidden', !nowOpen);
  }
  $('#sidebar-toggle').on('click', toggleSidebar);
  $('#sidebar-backdrop').on('click', closeSidebar);
  $('#conv-list, #folder-list').on('click', '.conv-item, .folder-item', () => {
    if (window.matchMedia('(max-width: 640px)').matches) closeSidebar();
  });
});
