/**
 * Foxhole for Claude - Tool Router
 * Routes tool calls to appropriate handlers: content script or browser APIs
 * Adapted from FoxHole Debug Bridge background.js and handlers.ts
 */

// ==========================================================================
// Network Request Capture (using webRequest API)
// ==========================================================================

// Network request buffer configuration
const NETWORK_CONFIG = {
  maxRequests: 200,
  maxRequestBodySize: 50000,
  maxResponseBodySize: 50000
};

// Captured network requests (per tab)
const networkRequestBuffers = new Map(); // tabId -> NetworkRequest[]

// Pending requests (being processed)
const pendingRequests = new Map(); // requestId -> NetworkRequest

// Response body chunks for filtering
const responseBodyChunks = new Map(); // requestId -> Uint8Array[]

// Console log buffer (per tab)
const consoleBuffers = new Map(); // tabId -> ConsoleEntry[]

// Error buffer (per tab)
const errorBuffers = new Map(); // tabId -> ErrorEntry[]

// WebSocket message buffer (per tab)
const websocketBuffers = new Map(); // tabId -> WebSocketMessage[]

// Custom request headers (per tab)
const customRequestHeaders = new Map(); // tabId -> { [headerName]: value }

// Blocked URL patterns (per tab)
const blockedUrlPatterns = new Map(); // tabId -> string[]

/**
 * Create a new network request buffer for a tab
 */
function getOrCreateNetworkBuffer(tabId) {
  if (!networkRequestBuffers.has(tabId)) {
    networkRequestBuffers.set(tabId, []);
  }
  return networkRequestBuffers.get(tabId);
}

/**
 * Add request to buffer with FIFO eviction
 */
function addToNetworkBuffer(tabId, request) {
  const buffer = getOrCreateNetworkBuffer(tabId);
  buffer.push(request);
  while (buffer.length > NETWORK_CONFIG.maxRequests) {
    buffer.shift();
  }
}

/**
 * Serialize request body (ArrayBuffer cannot be JSON stringified)
 */
function serializeRequestBody(requestBody) {
  if (!requestBody) return null;

  try {
    // Handle raw data (e.g., JSON POST bodies)
    if (requestBody.raw && Array.isArray(requestBody.raw)) {
      const decoder = new TextDecoder('utf-8');
      const parts = requestBody.raw.map(part => {
        if (part.bytes instanceof ArrayBuffer) {
          return decoder.decode(part.bytes);
        }
        return '';
      });
      const rawText = parts.join('');

      // Truncate if too large
      if (rawText.length > NETWORK_CONFIG.maxRequestBodySize) {
        return rawText.slice(0, NETWORK_CONFIG.maxRequestBodySize) + '...[truncated]';
      }

      // Try to parse as JSON if it looks like JSON
      if (rawText.startsWith('{') || rawText.startsWith('[')) {
        try {
          return JSON.parse(rawText);
        } catch (e) {
          return rawText;
        }
      }
      return rawText;
    }

    // Handle form data
    if (requestBody.formData) {
      return { formData: requestBody.formData };
    }

    return null;
  } catch (e) {
    console.error('[Claude Assistant] Error serializing request body:', e);
    return null;
  }
}

/**
 * Check if we should capture response body (only XHR/fetch requests)
 */
function shouldCaptureResponseBody(details) {
  return details.type === 'xmlhttprequest';
}

// ==========================================================================
// webRequest Listeners for Network Capture
// ==========================================================================

// filterResponseData is Firefox-only; Chrome MV3 also forbids 'blocking' without enterprise policy
const _hasFilterResponseData = typeof browser.webRequest.filterResponseData === 'function';
const _onBeforeRequestOptions = _hasFilterResponseData ? ['blocking', 'requestBody'] : ['requestBody'];

// Capture request initiation
browser.webRequest.onBeforeRequest.addListener(
  (details) => {
    const { requestId, url, method, tabId, type, timeStamp } = details;

    // Skip requests without a tab (e.g., extension requests)
    if (tabId < 0) return;

    const request = {
      requestId,
      url,
      method,
      tabId,
      type,
      startTime: timeStamp,
      requestBody: serializeRequestBody(details.requestBody)
    };

    pendingRequests.set(requestId, request);

    // Set up response body capture for XHR requests (Firefox only — requires filterResponseData)
    if (_hasFilterResponseData && shouldCaptureResponseBody(details)) {
      try {
        const filter = browser.webRequest.filterResponseData(requestId);
        const chunks = [];

        filter.ondata = (event) => {
          chunks.push(new Uint8Array(event.data));
          filter.write(event.data);
        };

        filter.onstop = () => {
          // Combine chunks
          const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
          const combined = new Uint8Array(totalLength);
          let offset = 0;
          for (const chunk of chunks) {
            combined.set(chunk, offset);
            offset += chunk.length;
          }

          // Decode as text
          const decoder = new TextDecoder('utf-8');
          let text = decoder.decode(combined);

          // Truncate if too large
          if (text.length > NETWORK_CONFIG.maxResponseBodySize) {
            text = text.slice(0, NETWORK_CONFIG.maxResponseBodySize) + '...[truncated]';
          }

          // Try to parse as JSON
          let responseBody = text;
          if (text.startsWith('{') || text.startsWith('[')) {
            try {
              responseBody = JSON.parse(text);
            } catch (e) {
              // Keep as string
            }
          }

          responseBodyChunks.set(requestId, responseBody);
          filter.disconnect();
        };

        filter.onerror = () => {
          try {
            filter.disconnect();
          } catch (e) {
            // Ignore NS_ERROR_FAILURE - filter may already be disconnected
          }
        };
      } catch (e) {
        // filterResponseData may fail for some request types
      }
    }
  },
  { urls: ['<all_urls>'] },
  _onBeforeRequestOptions
);

// Capture request headers
browser.webRequest.onBeforeSendHeaders.addListener(
  (details) => {
    const request = pendingRequests.get(details.requestId);
    if (request) {
      request.requestHeaders = details.requestHeaders;
    }
  },
  { urls: ['<all_urls>'] },
  ['requestHeaders']
);

// Capture completed requests
browser.webRequest.onCompleted.addListener(
  (details) => {
    const request = pendingRequests.get(details.requestId);
    if (request) {
      request.statusCode = details.statusCode;
      request.responseHeaders = details.responseHeaders;
      request.endTime = details.timeStamp;
      request.duration = details.timeStamp - request.startTime;

      // Attach captured response body if available
      if (responseBodyChunks.has(details.requestId)) {
        request.responseBody = responseBodyChunks.get(details.requestId);
        responseBodyChunks.delete(details.requestId);
      }

      // Store in buffer
      if (request.tabId >= 0) {
        addToNetworkBuffer(request.tabId, request);
      }

      // Feed to passive API observer — only for sidebar tabs when observer is enabled
      if (window.ApiObserver && window.passiveObserverEnabled === true && request.tabId >= 0 && window.sidebarTabs?.has(request.tabId)) {
        try {
          window.ApiObserver.processCompletedRequest(request);
        } catch (e) {
          console.warn('[ApiObserver] Error:', e);
        }
      }

      pendingRequests.delete(details.requestId);
    }
  },
  { urls: ['<all_urls>'] },
  ['responseHeaders']
);

// Capture failed requests
browser.webRequest.onErrorOccurred.addListener(
  (details) => {
    const request = pendingRequests.get(details.requestId);
    if (request) {
      request.error = details.error;
      request.endTime = details.timeStamp;
      request.duration = details.timeStamp - request.startTime;

      // Store in buffer even if failed
      if (request.tabId >= 0) {
        addToNetworkBuffer(request.tabId, request);
      }

      pendingRequests.delete(details.requestId);
    }
  },
  { urls: ['<all_urls>'] }
);

// Clean up network buffers when tabs are closed
browser.tabs.onRemoved.addListener((tabId) => {
  networkRequestBuffers.delete(tabId);
});

// ==========================================================================
// Tool Execution Router
// ==========================================================================

/**
 * Execute a tool and return the result
 * @param {string} toolName - Name of the tool to execute
 * @param {object} toolInput - Input parameters for the tool
 * @returns {Promise<object>} - Tool execution result
 */
async function executeTool(toolName, toolInput) {
  try {
    // Get active tab for content script calls
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    if (!tab) {
      throw new Error('No active tab found');
    }
    const tabId = tab.id;

    // Route to appropriate handler
    switch (toolName) {
      // ========================================
      // Content Script Delegation
      // ========================================

      // DOM interaction
      case 'click_element':
      case 'type_text':
      case 'scroll_to':
      case 'scroll_to_element':
      case 'hover_element':
      case 'focus_element':
      case 'select_option':
      case 'set_checkbox':
      case 'fill_form':
        return await sendToContentScript(tabId, toolName, toolInput);

      case 'press_key':
        // Translate modifiers array to individual boolean flags
        const modifiers = toolInput.modifiers || [];
        return await sendToContentScript(tabId, toolName, {
          key: toolInput.key,
          selector: toolInput.selector,
          ctrlKey: modifiers.includes('ctrl'),
          shiftKey: modifiers.includes('shift'),
          altKey: modifiers.includes('alt'),
          metaKey: modifiers.includes('meta')
        });

      // DOM querying
      case 'query_selector':
      case 'get_element_properties':
      case 'get_computed_styles':
      case 'get_element_bounds':
        return await sendToContentScript(tabId, toolName, toolInput);

      // Page content
      case 'get_page_content':
        return await sendToContentScript(tabId, 'get_dom', toolInput);

      case 'dom_stats':
      case 'get_dom_structure':
        return await sendToContentScript(tabId, toolName, toolInput);

      // Script execution
      case 'execute_script':
        return await sendToContentScript(tabId, toolName, toolInput);

      // Storage
      case 'get_local_storage':
        return await sendToContentScript(tabId, 'get_storage', { type: 'local', ...toolInput });

      case 'get_session_storage':
        return await sendToContentScript(tabId, 'get_storage', { type: 'session', ...toolInput });

      case 'set_storage_item':
        // Translate storageType to type for content script
        return await sendToContentScript(tabId, 'set_storage', {
          type: toolInput.storageType || 'local',
          key: toolInput.key,
          value: toolInput.value
        });

      case 'clear_storage':
        // Translate storageType to type for content script
        return await sendToContentScript(tabId, 'clear_storage', {
          type: toolInput.storageType || 'both'
        });

      // Wait operations
      case 'wait_for_element':
        return await sendToContentScript(tabId, toolName, toolInput);

      // ========================================
      // Browser API Handlers
      // ========================================

      // Navigation
      case 'navigate':
        return await handleNavigate(tabId, toolInput);

      case 'reload_page':
        return await handleReloadPage(tabId, toolInput);

      case 'go_back':
        return await handleGoBack(tabId);

      case 'go_forward':
        return await handleGoForward(tabId);

      // Tab info
      case 'get_current_url':
        return { url: tab.url };

      case 'get_page_title':
        return { title: tab.title };

      // Screenshots
      case 'take_screenshot':
        return await handleTakeScreenshot(toolInput);

      // File Output (Markdown preferred)
      case 'create_markdown':
        return await handleCreateMarkdown(toolInput);

      case 'create_html':
        return await handleCreateHtml(toolInput);

      case 'open_download':
        return await handleOpenDownload(toolInput);

      // Cookies
      case 'get_cookies':
        return await handleGetCookies(tab.url, toolInput);

      case 'set_cookie':
        return await handleSetCookie(tab.url, toolInput);

      case 'delete_cookie':
        return await handleDeleteCookie(tab.url, toolInput);

      // Tab management
      case 'list_tabs':
        return await handleGetTabs();

      case 'switch_tab':
        return await handleSwitchTab(toolInput);

      case 'create_tab':
        return await handleCreateTab(toolInput);

      case 'close_tab':
        return await handleCloseTab(toolInput);

      // Clipboard
      case 'read_clipboard':
        return await handleReadClipboard(tabId);

      case 'write_clipboard':
        return await handleWriteClipboard(tabId, toolInput);

      // Network requests
      case 'get_network_requests':
        return handleGetNetworkRequests(tabId, toolInput);

      case 'clear_network_requests':
        return handleClearNetworkRequests(tabId);

      // Wait for navigation
      case 'wait_for_navigation':
        return await handleWaitForNavigation(tabId, toolInput);

      // Get active tab info
      case 'get_active_tab':
        return { id: tab.id, url: tab.url, title: tab.title, status: tab.status };

      // List frames
      case 'list_frames':
        return await sendToContentScript(tabId, 'list_frames', toolInput);

      // Element screenshot
      case 'take_element_screenshot':
        return await handleTakeElementScreenshot(tabId, toolInput);

      // Read image for visual analysis
      case 'read_image':
        return await handleReadImage(tabId, toolInput);

      // Simple wait/delay
      case 'wait':
        return await handleWait(toolInput);

      // Network request detail
      case 'get_network_request_detail':
        return handleGetNetworkRequestDetail(tabId, toolInput);

      // Set request headers
      case 'set_request_headers':
        return handleSetRequestHeaders(tabId, toolInput);

      // Block URLs
      case 'block_urls':
        return handleBlockUrls(tabId, toolInput);

      // Query buffer (console, errors, network, websocket)
      case 'query_buffer':
        return handleQueryBuffer(tabId, toolInput);

      // Clear buffer
      case 'clear_buffer':
        return handleClearBuffer(tabId, toolInput);

      // Site Specs
      case 'save_site_spec':
        return await handleSaveSiteSpec(tab, toolInput);
      case 'delete_site_spec':
        return await handleDeleteSiteSpec(tab, toolInput);

      // External Fetch
      case 'fetch_url':
        return await handleFetchUrl(toolInput);

      // Task History (on-demand context retrieval)
      case 'request_history':
        return handleRequestHistory();

      // Element Marking (highlight & track using data attributes)
      case 'mark_elements':
        return await handleMarkElements(tabId, toolInput);
      case 'get_marked_elements':
        return await handleGetMarkedElements(tabId, toolInput);
      case 'clear_marked_elements':
        return await handleClearMarkedElements(tabId, toolInput);

      // User-Driven Selection Mode (user clicks to mark)
      case 'toggle_selection_mode':
        return await sendToContentScript(tabId, 'toggle_selection_mode', toolInput);
      case 'get_user_selections':
        return await sendToContentScript(tabId, 'get_user_selections', toolInput);
      case 'clear_user_selections':
        return await sendToContentScript(tabId, 'clear_user_selections', toolInput);

      // Browsing Data & Advanced Storage
      case 'list_indexeddb':
      case 'clear_indexeddb':
      case 'list_cache_storage':
      case 'clear_cache_storage':
        return await sendToContentScript(tabId, toolName, toolInput);

      case 'clear_browsing_data':
        return await handleClearBrowsingData(toolInput);

      case 'search_history':
        return await handleSearchHistory(toolInput);

      case 'delete_history':
        return await handleDeleteHistory(toolInput);

      // Text Utilities
      case 'clean_text':
        return await sendToContentScript(tabId, 'clean_text', toolInput);

      // Accessibility tree & element discovery
      case 'get_accessibility_tree':
        return await sendToContentScript(tabId, 'get_accessibility_tree', toolInput);

      case 'find_elements':
        return await sendToContentScript(tabId, 'find_elements', toolInput);

      case 'fetch_with_session':
        return await sendToContentScript(tabId, 'fetch_with_session', toolInput);

      case 'upload_file':
        return await sendToContentScript(tabId, 'upload_file', toolInput);

      case 'handle_dialog':
        return await sendToContentScript(tabId, 'handle_dialog', toolInput);

      // Developer Tools
      case 'detect_page_tech':
        return await handleDetectPageTech(tabId);
      case 'get_performance_metrics':
        return await handleGetPerformanceMetrics(tabId, toolInput);
      case 'audit_accessibility':
        return await handleAuditAccessibility(tabId, toolInput);
      case 'inspect_app_state':
        return await handleInspectAppState(tabId, toolInput);

      // Workflow Recording
      case 'start_recording': {
        if (!window.workflowRecording) return { error: 'Workflow recording not initialized' };
        window.workflowRecording.active = true;
        window.workflowRecording.tabId = tabId;
        window.workflowRecording.steps = [];
        window.workflowRecording.lastUrl = tab.url;
        try { await sendToContentScript(tabId, 'start_recording', {}); } catch (e) {}
        return { recording: true, message: 'Recording started. Ask the user to perform the steps, then call stop_recording when done.' };
      }

      case 'stop_recording': {
        if (!window.workflowRecording) return { error: 'Workflow recording not initialized' };
        window.workflowRecording.active = false;
        const recordedSteps = [...window.workflowRecording.steps];
        window.workflowRecording.steps = [];
        window.workflowRecording.tabId = null;
        try { await sendToContentScript(tabId, 'stop_recording', {}); } catch (e) {}
        if (recordedSteps.length === 0) return { steps: [], message: 'No steps were recorded. Make sure to perform actions after calling start_recording.' };
        return {
          steps: recordedSteps,
          stepCount: recordedSteps.length,
          summary: recordedSteps.map((s, i) => `${i + 1}. ${s._label}`).join('\n'),
          message: `Recorded ${recordedSteps.length} step(s). Call save_workflow to save this workflow.`
        };
      }

      case 'save_workflow': {
        const { name: wfName, steps: wfSteps, description: wfDesc } = toolInput;
        if (!wfName || !wfSteps?.length) return { error: 'name and steps are required' };
        const saved = await window.saveStoredWorkflow(wfName, wfSteps, wfDesc, tab.url);
        return { success: true, name: saved.name, stepCount: saved.steps.length };
      }

      case 'list_workflows': {
        const workflows = await window.getStoredWorkflows();
        const list = Object.values(workflows).map(w => ({
          name: w.name,
          description: w.description || '(no description)',
          stepCount: w.steps.length,
          runCount: w.runCount || 0,
          created: new Date(w.created).toLocaleDateString()
        }));
        if (list.length === 0) return { workflows: [], message: 'No workflows saved yet. Use start_recording to create one.' };
        return { workflows: list, count: list.length };
      }

      case 'run_workflow': {
        return await window.runStoredWorkflow(toolInput.name);
      }

      case 'delete_workflow': {
        const workflows = await window.getStoredWorkflows();
        if (!workflows[toolInput.name]) return { error: `Workflow "${toolInput.name}" not found` };
        delete workflows[toolInput.name];
        await browser.storage.local.set({ [window.WORKFLOWS_KEY]: workflows });
        return { success: true, deleted: toolInput.name };
      }

      default:
        throw new Error(`Unknown tool: ${toolName}`);
    }
  } catch (error) {
    return { error: error.message };
  }
}

// ==========================================================================
// Content Script Communication
// ==========================================================================

/**
 * Send a command to the content script
 */
async function sendToContentScript(tabId, action, params) {
  try {
    const response = await browser.tabs.sendMessage(tabId, {
      action,
      params
    }, { frameId: 0 }); // Default to top frame

    return response;
  } catch (error) {
    // If content script not ready, try to inject it first
    if (error.message.includes('Receiving end does not exist')) {
      throw new Error('Content script not loaded on this page. The page may need to be refreshed.');
    }
    throw error;
  }
}

// ==========================================================================
// Navigation Handlers
// ==========================================================================

async function handleNavigate(tabId, params) {
  const { url } = params;
  if (!url) {
    throw new Error('URL is required for navigate');
  }
  await browser.tabs.update(tabId, { url });
  return { navigated: true, url };
}

async function handleReloadPage(tabId, params) {
  const bypassCache = params?.bypassCache || false;
  await browser.tabs.reload(tabId, { bypassCache });
  return { reloaded: true };
}

async function handleGoBack(tabId) {
  await browser.tabs.goBack(tabId);
  return { navigated: 'back' };
}

async function handleGoForward(tabId) {
  await browser.tabs.goForward(tabId);
  return { navigated: 'forward' };
}

async function handleWaitForNavigation(tabId, params) {
  const timeout = params?.timeout || 30000;
  const startTime = Date.now();

  return new Promise((resolve, reject) => {
    const checkStatus = async () => {
      try {
        const tab = await browser.tabs.get(tabId);
        if (tab.status === 'complete') {
          resolve({ navigated: true, url: tab.url, title: tab.title });
          return;
        }
      } catch (e) {
        reject(new Error('Tab no longer exists'));
        return;
      }

      if (Date.now() - startTime > timeout) {
        reject(new Error(`Navigation timeout after ${timeout}ms`));
        return;
      }

      setTimeout(checkStatus, 100);
    };

    checkStatus();
  });
}

// ==========================================================================
// Screenshot Handler
// ==========================================================================

async function handleTakeScreenshot(params) {
  const format = params?.format || 'png';
  const quality = params?.quality;
  const saveTo = params?.saveTo;

  const options = { format };
  if (quality && format === 'jpeg') {
    options.quality = quality;
  }

  const dataUrl = await browser.tabs.captureVisibleTab(null, options);

  // If saveTo is provided, save to Downloads folder
  if (saveTo) {
    let filename = saveTo;
    const ext = `.${format}`;
    if (!filename.toLowerCase().endsWith(ext)) {
      filename = filename.replace(/\.\w+$/, '') + ext;
    }

    // dataUrl from captureVisibleTab is already a data URL — use it directly
    await browser.downloads.download({
      url: dataUrl,
      filename: filename,
      saveAs: false
    });

    return {
      saved: true,
      filename,
      message: `Screenshot saved to Downloads: ${filename}`
    };
  }

  // Default: return base64 data for viewing
  return { screenshot: dataUrl, format };
}

// ==========================================================================
// File Output Handlers (Markdown preferred, HTML for interactive)
// ==========================================================================

async function handleCreateMarkdown(params) {
  const { content, filename: customFilename } = params;

  if (!content) {
    throw new Error('Markdown content is required');
  }

  const title = customFilename
    ? customFilename.replace(/\.md$/i, '')
    : 'Claude Report';

  const key = 'foxhole_viewer_' + Date.now();
  await browser.storage.local.set({ [key]: { type: 'markdown', title, content } });

  const viewerUrl = browser.runtime.getURL('viewer/viewer.html') + '#' + key;
  await browser.tabs.create({ url: viewerUrl });

  return {
    success: true,
    message: 'Report opened in new tab.',
  };
}

async function handleCreateHtml(params) {
  const { html, title } = params;

  if (!html) {
    throw new Error('HTML content is required');
  }

  // Check if HTML is already a complete document
  const trimmedHtml = html.trim();
  const isCompleteDocument = /^<!doctype\s+html/i.test(trimmedHtml) || /^<html[\s>]/i.test(trimmedHtml);

  let fullHtml;
  if (isCompleteDocument) {
    fullHtml = trimmedHtml;
  } else {
    // Wrap in complete document
    const pageTitle = title || 'Claude Report';
    fullHtml = `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${pageTitle}</title>
<style>
body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 1200px; margin: 0 auto; padding: 20px; background: #1a1a1a; color: #e0e0e0; }
h1, h2, h3 { color: #fff; }
table { border-collapse: collapse; width: 100%; margin: 20px 0; }
th, td { border: 1px solid #444; padding: 12px; text-align: left; }
th { background: #333; color: #fff; }
tr:nth-child(even) { background: #252525; }
code { background: #333; padding: 2px 6px; border-radius: 3px; }
pre { background: #333; padding: 16px; border-radius: 8px; overflow-x: auto; }
a { color: #6db3f2; }
</style>
</head>
<body>
${html}
</body>
</html>`;
  }

  const key = 'foxhole_viewer_' + Date.now();
  await browser.storage.local.set({ [key]: { type: 'html', content: fullHtml } });

  const viewerUrl = browser.runtime.getURL('viewer/viewer.html') + '#' + key;
  await browser.tabs.create({ url: viewerUrl });

  return {
    success: true,
    message: 'Report opened in new tab.',
  };
}

async function handleOpenDownload(params) {
  const { filename } = params;

  if (!filename) {
    throw new Error('Filename is required');
  }

  // Search for downloads matching the filename
  const downloads = await browser.downloads.search({
    query: [filename],
    limit: 10,
    orderBy: ['-startTime']
  });

  if (downloads.length === 0) {
    throw new Error(`No downloads found matching "${filename}"`);
  }

  // Find the most recent complete download
  const download = downloads.find(d => d.state === 'complete');

  if (!download) {
    throw new Error(`No completed downloads found matching "${filename}"`);
  }

  // Open the file
  await browser.downloads.open(download.id);

  return {
    success: true,
    message: `Opened: ${download.filename}`,
    filename: download.filename
  };
}

// ==========================================================================
// Cookie Handlers
// ==========================================================================

async function handleGetCookies(tabUrl, params) {
  const url = params?.url || tabUrl;
  const cookies = await browser.cookies.getAll({ url });
  return { cookies };
}

async function handleSetCookie(tabUrl, params) {
  const { name, value, domain, path, secure, httpOnly, sameSite, expirationDate } = params;

  if (!name || value === undefined) {
    throw new Error('Cookie name and value are required');
  }

  const url = params.url || tabUrl;

  const cookieDetails = {
    url,
    name,
    value
  };

  if (domain) cookieDetails.domain = domain;
  if (path) cookieDetails.path = path;
  if (secure !== undefined) cookieDetails.secure = secure;
  if (httpOnly !== undefined) cookieDetails.httpOnly = httpOnly;
  if (sameSite) cookieDetails.sameSite = sameSite;
  if (expirationDate) cookieDetails.expirationDate = expirationDate;

  await browser.cookies.set(cookieDetails);
  return { set: true, name };
}

async function handleDeleteCookie(tabUrl, params) {
  const { name } = params;
  if (!name) {
    throw new Error('Cookie name is required');
  }

  const url = params.url || tabUrl;
  await browser.cookies.remove({ url, name });
  return { deleted: true, name };
}

// ==========================================================================
// Tab Management Handlers
// ==========================================================================

async function handleGetTabs() {
  const tabs = await browser.tabs.query({});
  return {
    tabs: tabs.map(tab => ({
      id: tab.id,
      url: tab.url,
      title: tab.title,
      active: tab.active,
      windowId: tab.windowId,
      status: tab.status
    }))
  };
}

async function handleSwitchTab(params) {
  const { tabId } = params;
  if (!tabId) {
    throw new Error('tabId is required');
  }

  await browser.tabs.update(tabId, { active: true });
  const tab = await browser.tabs.get(tabId);
  await browser.windows.update(tab.windowId, { focused: true });

  return { switched: true, tabId };
}

async function handleCreateTab(params) {
  const { url, active } = params;

  const tab = await browser.tabs.create({
    url: url || 'about:blank',
    active: active !== false // Default to active
  });

  // Notify sidebar if this tab is active so it can show fresh chat
  if (active !== false) {
    browser.runtime.sendMessage({
      type: 'TAB_CREATED_BY_TOOL',
      tabId: tab.id
    }).catch(() => {}); // Sidebar may not be open
  }

  return { created: true, tabId: tab.id, url: tab.url };
}

async function handleCloseTab(params) {
  const { tabId } = params;
  if (!tabId) {
    throw new Error('tabId is required');
  }

  await browser.tabs.remove(tabId);
  return { closed: true, tabId };
}

// ==========================================================================
// Clipboard Handlers
// ==========================================================================

async function handleReadClipboard(tabId) {
  // Use content script to read clipboard (requires user gesture in some cases)
  const result = await sendToContentScript(tabId, 'execute_script', {
    script: `
      (async () => {
        try {
          const text = await navigator.clipboard.readText();
          return { text };
        } catch (e) {
          return { error: e.message };
        }
      })()
    `
  });

  if (result.result) {
    return result.result;
  }
  return result;
}

async function handleWriteClipboard(tabId, params) {
  const { text } = params;
  if (text === undefined) {
    throw new Error('text is required');
  }

  const result = await sendToContentScript(tabId, 'execute_script', {
    script: `
      (async () => {
        try {
          await navigator.clipboard.writeText(${JSON.stringify(text)});
          return { written: true };
        } catch (e) {
          return { error: e.message };
        }
      })()
    `
  });

  if (result.result) {
    return result.result;
  }
  return result;
}

// ==========================================================================
// Network Request Handlers
// ==========================================================================

function handleGetNetworkRequests(tabId, params) {
  const buffer = networkRequestBuffers.get(tabId) || [];
  const limit = params?.limit || 50;
  const filter = params?.filter;
  const typeFilter = params?.type;

  let requests = [...buffer];

  // Apply type filter if provided
  if (typeFilter) {
    const mapped = (typeFilter === 'xhr' || typeFilter === 'fetch') ? 'xmlhttprequest' : typeFilter;
    requests = requests.filter(req => req.type === mapped);
  }

  // Apply text filter if provided
  if (filter) {
    const filterLower = filter.toLowerCase();
    requests = requests.filter(req =>
      req.url.toLowerCase().includes(filterLower) ||
      req.method.toLowerCase().includes(filterLower) ||
      (req.type && req.type.toLowerCase().includes(filterLower))
    );
  }

  // Return most recent requests up to limit
  const result = requests.slice(-limit);

  return {
    requests: result,
    total: buffer.length,
    returned: result.length
  };
}

function handleClearNetworkRequests(tabId) {
  networkRequestBuffers.delete(tabId);
  return { cleared: true, tabId };
}

// ==========================================================================
// Element Screenshot Handler
// ==========================================================================

async function handleTakeElementScreenshot(tabId, params) {
  const { selector } = params;
  if (!selector) {
    throw new Error('selector is required');
  }

  // Get element bounds from content script
  const bounds = await sendToContentScript(tabId, 'get_element_bounds', { selector });
  if (bounds.error) {
    throw new Error(bounds.error);
  }

  // Take full viewport screenshot
  const dataUrl = await browser.tabs.captureVisibleTab(null, { format: 'png' });

  // Return with element bounds for client-side cropping
  return {
    screenshot: dataUrl,
    bounds,
    selector,
    note: 'Full viewport captured. Use bounds to crop to element.'
  };
}

// ==========================================================================
// Read Image Handler
// ==========================================================================

async function handleReadImage(tabId, params) {
  const { selector, url } = params;

  if (!selector && !url) {
    throw new Error('Either selector or url is required');
  }

  // Build script to run in page context
  // Strategy: draw image onto canvas, export as dataURL
  // Fallback: if tainted canvas (CORS), fetch the URL as blob and convert to base64
  const script = `
    (async () => {
      try {
        let imgSrc;
        let imgEl;

        ${selector ? `
        // Selector mode: find the <img> element
        imgEl = document.querySelector(${JSON.stringify(selector)});
        if (!imgEl) {
          return { error: 'Element not found: ${selector.replace(/'/g, "\\'")}' };
        }
        if (imgEl.tagName !== 'IMG') {
          // Try to find an img inside the element
          const innerImg = imgEl.querySelector('img');
          if (innerImg) {
            imgEl = innerImg;
          } else {
            return { error: 'Element is not an <img> and contains no <img>: ' + imgEl.tagName };
          }
        }
        imgSrc = imgEl.src || imgEl.currentSrc;
        if (!imgSrc) {
          return { error: 'Image element has no src' };
        }
        ` : `
        // URL mode: use provided URL directly
        imgSrc = ${JSON.stringify(url)};
        `}

        // Helper: fetch image as base64 via blob (CORS fallback)
        async function fetchAsBase64(imageUrl) {
          const resp = await fetch(imageUrl);
          if (!resp.ok) throw new Error('Fetch failed: ' + resp.status);
          const blob = await resp.blob();
          return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onloadend = () => resolve(reader.result);
            reader.onerror = reject;
            reader.readAsDataURL(blob);
          });
        }

        // Try canvas approach first (works for same-origin and CORS-enabled images)
        try {
          // If we have the element and it's already loaded, use it directly
          if (imgEl && imgEl.complete && imgEl.naturalWidth > 0) {
            const canvas = document.createElement('canvas');
            canvas.width = imgEl.naturalWidth;
            canvas.height = imgEl.naturalHeight;
            const ctx = canvas.getContext('2d');
            ctx.drawImage(imgEl, 0, 0);
            const dataUrl = canvas.toDataURL('image/png');
            return { screenshot: dataUrl };
          }

          // Load image fresh (handles URL mode and not-yet-loaded images)
          const img = new Image();
          img.crossOrigin = 'anonymous';
          const loaded = await new Promise((resolve, reject) => {
            img.onload = () => resolve(true);
            img.onerror = () => reject(new Error('Image load failed'));
            img.src = imgSrc;
          });

          const canvas = document.createElement('canvas');
          canvas.width = img.naturalWidth;
          canvas.height = img.naturalHeight;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0);
          const dataUrl = canvas.toDataURL('image/png');
          return { screenshot: dataUrl };
        } catch (canvasErr) {
          // Canvas tainted by CORS or load failed — try fetch fallback
          console.warn('[read_image] Canvas approach failed, trying fetch fallback:', canvasErr.message);
          try {
            const dataUrl = await fetchAsBase64(imgSrc);
            return { screenshot: dataUrl };
          } catch (fetchErr) {
            return { error: 'Could not read image. Canvas: ' + canvasErr.message + '. Fetch: ' + fetchErr.message };
          }
        }
      } catch (e) {
        return { error: e.message };
      }
    })()
  `;

  const result = await sendToContentScript(tabId, 'execute_script', { code: script });

  // execute_script wraps in { result: ... }
  if (result && result.result) {
    return result.result;
  }
  return result;
}

// ==========================================================================
// Wait Handler
// ==========================================================================

async function handleWait(params) {
  const { ms } = params;
  if (!ms || ms <= 0) {
    throw new Error('ms must be a positive number');
  }
  if (ms > 30000) {
    throw new Error('Maximum wait time is 30000ms (30 seconds)');
  }

  await new Promise(resolve => setTimeout(resolve, ms));
  return { waited: ms };
}

// ==========================================================================
// Network Request Detail Handler
// ==========================================================================

function handleGetNetworkRequestDetail(tabId, params) {
  const { requestId } = params;
  if (!requestId) {
    throw new Error('requestId is required');
  }

  const buffer = networkRequestBuffers.get(tabId) || [];
  const request = buffer.find(r => r.requestId === requestId);

  if (!request) {
    return { error: 'Request not found', requestId };
  }

  return { request };
}

// ==========================================================================
// Set Request Headers Handler
// ==========================================================================

function handleSetRequestHeaders(tabId, params) {
  const { headers } = params;
  if (!headers || typeof headers !== 'object') {
    throw new Error('headers object is required');
  }

  customRequestHeaders.set(tabId, headers);
  return { set: true, headers: Object.keys(headers) };
}

// ==========================================================================
// Block URLs Handler
// ==========================================================================

function handleBlockUrls(tabId, params) {
  const { patterns } = params;
  if (!patterns || !Array.isArray(patterns)) {
    throw new Error('patterns array is required');
  }

  blockedUrlPatterns.set(tabId, patterns);
  return { blocked: true, patterns };
}

// ==========================================================================
// Query Buffer Handler
// ==========================================================================

function handleQueryBuffer(tabId, params) {
  const { type, transform } = params;
  if (!type) {
    throw new Error('type is required');
  }
  if (!transform) {
    throw new Error('transform is required');
  }

  let buffer;
  switch (type) {
    case 'console':
      buffer = consoleBuffers.get(tabId) || [];
      break;
    case 'errors':
      buffer = errorBuffers.get(tabId) || [];
      break;
    case 'network':
      buffer = networkRequestBuffers.get(tabId) || [];
      break;
    case 'websocket':
      buffer = websocketBuffers.get(tabId) || [];
      break;
    default:
      throw new Error(`Unknown buffer type: ${type}`);
  }

  // Apply JS transform
  try {
    const transformFn = new Function('data', `return data${transform}`);
    const result = transformFn(buffer);
    return { result, type, originalCount: buffer.length };
  } catch (e) {
    return { error: `Transform error: ${e.message}`, transform };
  }
}

// ==========================================================================
// Clear Buffer Handler
// ==========================================================================

function handleClearBuffer(tabId, params) {
  const { dataType = 'all' } = params;

  const cleared = [];

  if (dataType === 'all' || dataType === 'console') {
    consoleBuffers.delete(tabId);
    cleared.push('console');
  }
  if (dataType === 'all' || dataType === 'errors') {
    errorBuffers.delete(tabId);
    cleared.push('errors');
  }
  if (dataType === 'all' || dataType === 'network') {
    networkRequestBuffers.delete(tabId);
    cleared.push('network');
  }
  if (dataType === 'all' || dataType === 'websocket') {
    websocketBuffers.delete(tabId);
    cleared.push('websocket');
  }

  return { cleared, tabId };
}

// ==========================================================================
// Buffer Management Helpers
// ==========================================================================

function addToConsoleBuffer(tabId, entry) {
  if (!consoleBuffers.has(tabId)) {
    consoleBuffers.set(tabId, []);
  }
  const buffer = consoleBuffers.get(tabId);
  buffer.push(entry);
  // Keep last 500 entries
  while (buffer.length > 500) {
    buffer.shift();
  }
}

function addToErrorBuffer(tabId, entry) {
  if (!errorBuffers.has(tabId)) {
    errorBuffers.set(tabId, []);
  }
  const buffer = errorBuffers.get(tabId);
  buffer.push(entry);
  // Keep last 200 entries
  while (buffer.length > 200) {
    buffer.shift();
  }
}

function addToWebsocketBuffer(tabId, entry) {
  if (!websocketBuffers.has(tabId)) {
    websocketBuffers.set(tabId, []);
  }
  const buffer = websocketBuffers.get(tabId);
  buffer.push(entry);
  // Keep last 200 entries
  while (buffer.length > 200) {
    buffer.shift();
  }
}

// ==========================================================================
// Site Specs Handler
// ==========================================================================

async function handleSaveSiteSpec(tab, params) {
  const { type, description, content } = params;

  // Validate required fields
  if (!type || !description || !content) {
    return { success: false, error: 'Missing required fields: type, description, and content are all required' };
  }

  // Validate type
  const validTypes = ['profile', 'dom', 'api', 'storage', 'shortcut'];
  if (!validTypes.includes(type)) {
    return { success: false, error: `Invalid type: ${type}. Must be one of: ${validTypes.join(', ')}` };
  }

  // Get domain from current tab
  let domain;
  try {
    const url = new URL(tab.url);
    domain = url.hostname.replace(/^www\./, '');
  } catch (e) {
    return { success: false, error: 'Could not determine domain from current tab' };
  }

  // Build knowledge item (SiteKnowledge API expects 'title' not 'description')
  // Note: spec content is authored by Claude, not read from pages.
  // Injection defense (layers 1-3) already sanitized page content before Claude saw it.
  // Only escape backticks here to prevent structural breakout in prompt formatting.
  const safeContent = content.replace(/```/g, '`\u200B``');

  const item = {
    type,
    title: description,
    content: safeContent,
    path: '*'
  };

  // Save via SiteKnowledge (unified API) — update if duplicate title exists
  try {
    if (!window.SiteKnowledge) {
      return { success: false, error: 'SiteKnowledge module not available' };
    }

    // Enforce one profile per domain — auto-update if exists
    if (type === 'profile') {
      const existing = await window.SiteKnowledge.get(domain);
      const existingProfile = existing?.find(e => e.type === 'profile');
      if (existingProfile) {
        const updated = await window.SiteKnowledge.update(domain, existingProfile.id, {
          type: 'profile',
          title: description,
          content: safeContent,
          path: '*'
        });
        if (updated) {
          console.log(`[SiteKnowledge] Tool updated site profile for ${domain}`);
          return { success: true, message: `Updated site profile for ${domain}`, action: 'updated', spec: updated };
        }
      }
    }

    // Check for existing spec with same title
    const existing = await window.SiteKnowledge.get(domain);
    const match = existing?.find(e => e.title.toLowerCase() === description.toLowerCase());

    if (match) {
      // Update existing spec with new content
      const updated = await window.SiteKnowledge.update(domain, match.id, {
        type,
        content: safeContent,
        path: '*'
      });
      if (updated) {
        console.log(`[SiteKnowledge] Tool updated spec for ${domain}:`, description);
        return {
          success: true,
          message: `Updated existing spec for ${domain}: "${description}"`,
          action: 'updated',
          spec: updated
        };
      }
    }

    // No duplicate — add new
    const saved = await window.SiteKnowledge.add(domain, item);
    if (saved) {
      console.log(`[SiteKnowledge] Tool saved spec for ${domain}:`, description);
      return {
        success: true,
        message: `Saved new spec for ${domain}: "${description}"`,
        action: 'created',
        spec: saved
      };
    }

    return { success: false, error: 'Failed to save spec' };
  } catch (error) {
    console.error('[SiteKnowledge] Tool error:', error);
    return { success: false, error: error.message };
  }
}

// ==========================================================================
// Delete Site Spec Handler
// ==========================================================================

async function handleDeleteSiteSpec(tab, params) {
  const { spec_id, reason } = params;

  if (!spec_id) {
    return { success: false, error: 'spec_id is required' };
  }

  const domain = new URL(tab.url).hostname.replace(/^www\./, '');

  try {
    if (!window.SiteKnowledge) {
      return { success: false, error: 'SiteKnowledge module not available' };
    }

    const deleted = await window.SiteKnowledge.delete(domain, spec_id);
    if (deleted) {
      console.log(`[SiteKnowledge] Deleted spec ${spec_id} from ${domain}${reason ? ': ' + reason : ''}`);
      return { success: true, message: `Deleted spec from ${domain}${reason ? ' (' + reason + ')' : ''}` };
    }

    return { success: false, error: `Spec ${spec_id} not found for ${domain}` };
  } catch (error) {
    console.error('[SiteKnowledge] Delete error:', error);
    return { success: false, error: error.message };
  }
}

// ==========================================================================
// Fetch URL Handler
// ==========================================================================

async function handleFetchUrl(params) {
  const { url, selector, maxLength = 15000, method, headers: customHeaders, body: requestBody, raw } = params;

  if (!url) {
    throw new Error('url is required');
  }

  // Validate URL
  let parsedUrl;
  try {
    parsedUrl = new URL(url);
    if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
      throw new Error('Only HTTP/HTTPS URLs are supported');
    }
  } catch (e) {
    throw new Error(`Invalid URL: ${e.message}`);
  }

  console.log(`[FetchUrl] Fetching: ${url}`);

  // Raw API mode: custom method/headers/body, return JSON directly.
  // Runs from extension background — bypasses page CSP and CORS (Firefox MV2 with <all_urls>).
  if (raw || method || customHeaders || requestBody) {
    const fetchMethod = (method || 'GET').toUpperCase();
    const mergedHeaders = Object.assign({}, customHeaders);
    const fetchInit = { method: fetchMethod, headers: mergedHeaders };
    if (requestBody && fetchMethod !== 'GET' && fetchMethod !== 'HEAD') {
      if (typeof requestBody === 'object') {
        fetchInit.body = JSON.stringify(requestBody);
        if (!mergedHeaders['Content-Type'] && !mergedHeaders['content-type']) {
          mergedHeaders['Content-Type'] = 'application/json';
        }
      } else {
        fetchInit.body = requestBody;
      }
    }

    try {
      const resp = await fetch(url, fetchInit);
      const respText = await resp.text();
      const ct = resp.headers.get('content-type') || '';
      let respBody = respText;
      if (ct.includes('json')) {
        try { respBody = JSON.parse(respText); } catch (_) {}
      }
      const respHeaders = {};
      resp.headers.forEach((v, k) => { respHeaders[k] = v; });
      return { status: resp.status, ok: resp.ok, headers: respHeaders, body: respBody, url: resp.url };
    } catch (error) {
      throw new Error(`fetch_url (raw) failed for ${url}: ${error.message}`);
    }
  }

  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; ClaudeAssistant/1.0)',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      }
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('text/html') && !contentType.includes('text/plain') && !contentType.includes('application/json')) {
      throw new Error(`Unsupported content type: ${contentType}`);
    }

    const html = await response.text();

    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');

    let content;
    let title = doc.title || null;
    let byline = null;
    let excerpt = null;
    let extractionMethod;

    if (selector) {
      // Caller wants a specific element — skip Readability, extract directly
      const targetEl = doc.querySelector(selector);
      if (!targetEl) {
        throw new Error(`Selector "${selector}" not found on page`);
      }
      content = targetEl.textContent || '';
      extractionMethod = 'selector';
    } else if (typeof Readability !== 'undefined') {
      // Use Mozilla Readability for clean article extraction
      try {
        const article = new Readability(doc).parse();
        if (article && article.textContent && article.textContent.trim().length > 200) {
          content = article.textContent;
          title = article.title || title;
          byline = article.byline || null;
          excerpt = article.excerpt || null;
          extractionMethod = 'readability';
        }
      } catch (e) {
        console.warn('[FetchUrl] Readability failed, falling back:', e.message);
      }
    }

    // Fallback: manual extraction (Readability unavailable or returned too little)
    if (!content) {
      const removeSelectors = [
        'script', 'style', 'noscript', 'iframe', 'svg',
        'nav', 'footer', 'header', 'aside',
        '[role="navigation"]', '[role="banner"]', '[role="contentinfo"]',
        '.nav', '.navbar', '.footer', '.header', '.sidebar', '.ad', '.ads', '.advertisement',
        '#nav', '#navbar', '#footer', '#header', '#sidebar'
      ];
      removeSelectors.forEach(sel => {
        doc.querySelectorAll(sel).forEach(el => el.remove());
      });
      const main = doc.querySelector('main, article, [role="main"], .main-content, #main, #content, .content');
      content = (main || doc.body)?.textContent || '';
      extractionMethod = 'fallback';
    }

    // Normalize whitespace
    content = content
      .replace(/\t/g, ' ')
      .replace(/[ \t]{2,}/g, ' ')
      .replace(/\n[ \t]+/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();

    const truncated = content.length > maxLength;
    if (truncated) {
      content = content.substring(0, maxLength) + '\n\n[Content truncated...]';
    }

    console.log(`[FetchUrl] Extracted ${content.length} chars via ${extractionMethod} from ${url}`);

    return {
      url,
      title,
      byline,
      excerpt,
      contentLength: content.length,
      truncated,
      extractionMethod,
      content
    };

  } catch (error) {
    console.error(`[FetchUrl] Error:`, error);
    throw new Error(`Failed to fetch ${url}: ${error.message}`);
  }
}

// ==========================================================================
// Task History
// ==========================================================================

/**
 * Handle request_history tool - returns last 3 task summaries
 * Task history is managed in background.js, accessed via window.getTaskHistory
 */
function handleRequestHistory() {
  if (typeof window.getTaskHistory !== 'function') {
    console.warn('[RequestHistory] getTaskHistory not available');
    return { tasks: [], message: 'No task history available' };
  }

  const history = window.getTaskHistory();

  if (history.length === 0) {
    return { tasks: [], message: 'No previous tasks recorded' };
  }

  // Format for Claude consumption
  const formatted = history.map((task, idx) => ({
    taskNumber: history.length - idx,  // Most recent = highest number
    userRequest: task.userMessage,
    outcome: task.assistantResponse,
    timestamp: new Date(task.timestamp).toISOString()
  }));

  return {
    taskCount: formatted.length,
    tasks: formatted,
    note: 'Most recent task listed first. Use this context to inform your current action.'
  };
}

// ==========================================================================
// ELEMENT MARKING HANDLERS
// Routed to content script — browser.tabs.executeScript is MV2-only
// ==========================================================================

async function handleMarkElements(tabId, params) {
  return await sendToContentScript(tabId, 'mark_elements', params);
}

async function handleGetMarkedElements(tabId, params) {
  return await sendToContentScript(tabId, 'get_marked_elements', params);
}

async function handleClearMarkedElements(tabId, params) {
  return await sendToContentScript(tabId, 'clear_marked_elements', params);
}

// ==========================================================================
// Browsing Data Handler
// ==========================================================================

async function handleClearBrowsingData(params) {
  const { dataTypes, since, originTypes } = params;

  if (!dataTypes || !Array.isArray(dataTypes) || dataTypes.length === 0) {
    throw new Error('dataTypes array is required and must not be empty');
  }

  // Map friendly names to browsingData API options
  const dataTypesMap = {
    cache: 'cache',
    cookies: 'cookies',
    history: 'history',
    formData: 'formData',
    downloads: 'downloads',
    serviceWorkers: 'serviceWorkers',
    localStorage: 'localStorage',
  };

  const removalOptions = {};
  for (const dt of dataTypes) {
    const apiKey = dataTypesMap[dt];
    if (!apiKey) {
      throw new Error(`Unknown data type: ${dt}. Valid types: ${Object.keys(dataTypesMap).join(', ')}`);
    }
    removalOptions[apiKey] = true;
  }

  const options = {};
  if (since) {
    // Convert minutes ago to epoch ms
    options.since = Date.now() - (since * 60 * 1000);
  }
  if (originTypes) {
    options.originTypes = { [originTypes]: true };
  }

  await browser.browsingData.remove(options, removalOptions);

  return {
    cleared: dataTypes,
    since: since ? `last ${since} minutes` : 'all time',
    originTypes: originTypes || 'all'
  };
}

// ==========================================================================
// Search History Handler
// ==========================================================================

async function handleSearchHistory(params) {
  const { query, maxResults = 25, startTime, endTime } = params;

  if (!query && query !== '') {
    throw new Error('query is required');
  }

  const searchParams = {
    text: query,
    maxResults: Math.min(maxResults, 100),
  };

  if (startTime) {
    const ts = typeof startTime === 'string' ? new Date(startTime).getTime() : Number(startTime);
    if (!isNaN(ts)) searchParams.startTime = ts;
  }
  if (endTime) {
    const ts = typeof endTime === 'string' ? new Date(endTime).getTime() : Number(endTime);
    if (!isNaN(ts)) searchParams.endTime = ts;
  }

  const results = await browser.history.search(searchParams);

  return {
    results: results.map(item => ({
      url: item.url,
      title: item.title,
      visitCount: item.visitCount,
      lastVisitTime: item.lastVisitTime ? new Date(item.lastVisitTime).toISOString() : null,
    })),
    query,
    total: results.length,
  };
}

// ==========================================================================
// Delete History Handler
// ==========================================================================

async function handleDeleteHistory(params) {
  const { url, startTime, endTime, all } = params;

  if (all) {
    await browser.history.deleteAll();
    return { message: 'All history deleted' };
  }

  if (url) {
    await browser.history.deleteUrl({ url });
    return { message: `History deleted for URL: ${url}` };
  }

  if (startTime && endTime) {
    const start = typeof startTime === 'string' ? new Date(startTime).getTime() : Number(startTime);
    const end = typeof endTime === 'string' ? new Date(endTime).getTime() : Number(endTime);

    if (isNaN(start) || isNaN(end)) {
      throw new Error('Invalid startTime or endTime');
    }

    await browser.history.deleteRange({ startTime: start, endTime: end });
    return { message: `History deleted for range: ${new Date(start).toISOString()} to ${new Date(end).toISOString()}` };
  }

  throw new Error('Provide one of: url, startTime+endTime, or all:true');
}

// ==========================================================================
// DEVELOPER TOOLS HANDLERS
// ==========================================================================

/**
 * Detect frameworks, libraries, and technologies on the current page
 */
async function handleDetectPageTech(tabId) {
  const script = `
    (() => {
      const tech = { frameworks: [], stateManagement: [], uiFrameworks: [], buildTools: [], analytics: [], libraries: [], meta: {} };

      // === Frameworks ===
      if (window.__NEXT_DATA__ || document.getElementById('__next')) {
        tech.frameworks.push('Next.js');
        if (window.__NEXT_DATA__) tech.meta.nextVersion = window.__NEXT_DATA__.buildId ? 'App Router' : 'Pages Router';
      }
      if (window.__NUXT__ || window.__nuxt__) tech.frameworks.push('Nuxt');
      if (window.__SVELTE_HMR || document.querySelector('[class^="svelte-"]')) tech.frameworks.push('Svelte');
      if (document.querySelector('[data-sveltekit-hydrate], [data-sveltekit]')) tech.frameworks.push('SvelteKit');
      if (window.Ember || document.querySelector('[id="ember-testing"],.ember-view')) tech.frameworks.push('Ember');
      if (window.__GATSBY) tech.frameworks.push('Gatsby');
      if (window.__remixContext) tech.frameworks.push('Remix');
      if (document.querySelector('astro-island, [data-astro-cid]')) tech.frameworks.push('Astro');

      // React (check after Next.js/Gatsby/Remix since they use React)
      const reactRoot = document.querySelector('[data-reactroot], #__next, #root, #app');
      if (reactRoot && reactRoot._reactRootContainer) tech.frameworks.push('React');
      else if (document.querySelector('[data-reactroot]')) tech.frameworks.push('React');
      else {
        // Check fibers
        const el = document.querySelector('#root, #__next, #app, [data-reactroot]');
        if (el) {
          const fiberKey = Object.keys(el).find(k => k.startsWith('__reactFiber') || k.startsWith('__reactInternalInstance'));
          if (fiberKey) tech.frameworks.push('React');
        }
      }

      // Vue
      if (window.__VUE__) tech.frameworks.push('Vue 3');
      else if (window.Vue) tech.frameworks.push('Vue 2');
      else if (document.querySelector('[data-v-]') || document.querySelector('[class*="v-"]')) tech.frameworks.push('Vue');

      // Angular
      if (window.ng || document.querySelector('[ng-version]')) {
        const ver = document.querySelector('[ng-version]')?.getAttribute('ng-version');
        tech.frameworks.push(ver ? 'Angular ' + ver : 'Angular');
      } else if (document.querySelector('[ng-app], [data-ng-app], .ng-scope')) {
        tech.frameworks.push('AngularJS');
      }

      // === State Management ===
      if (window.__REDUX_DEVTOOLS_EXTENSION__ || window.__REDUX_STATE__) tech.stateManagement.push('Redux');
      // Check for Redux store on common root elements
      try {
        const rootEl = document.querySelector('#root, #__next, #app');
        if (rootEl) {
          const fKey = Object.keys(rootEl).find(k => k.startsWith('__reactFiber'));
          if (fKey) {
            let fiber = rootEl[fKey];
            for (let i = 0; i < 20 && fiber; i++) {
              if (fiber.memoizedProps?.store?.getState) { if (!tech.stateManagement.includes('Redux')) tech.stateManagement.push('Redux'); break; }
              fiber = fiber.return;
            }
          }
        }
      } catch(e) {}
      if (window.__MOBX_DEVTOOLS_GLOBAL_HOOK__ || window.$mobx) tech.stateManagement.push('MobX');
      if (window.__VUEX__) tech.stateManagement.push('Vuex');
      if (window.__pinia) tech.stateManagement.push('Pinia');
      if (window.__ZUSTAND__) tech.stateManagement.push('Zustand');
      if (window.__RECOIL_DEVTOOLS_EXTENSION__) tech.stateManagement.push('Recoil');
      if (window.jotaiStore) tech.stateManagement.push('Jotai');
      if (document.querySelector('[data-xstate]')) tech.stateManagement.push('XState');

      // === UI Frameworks ===
      const html = document.documentElement.outerHTML.slice(0, 50000);
      const hasClass = (pattern) => document.querySelector('[class*="' + pattern + '"]');
      if (hasClass('tw-') || document.querySelector('[class*="tailwind"]') || html.match(/class="[^"]*\\b(flex|grid|bg-|text-|p-|m-|w-|h-)\\w/)) {
        // More specific tailwind check
        const sample = document.body?.className || '';
        const allClasses = document.querySelectorAll('[class]');
        let twCount = 0;
        for (let i = 0; i < Math.min(allClasses.length, 50); i++) {
          if (allClasses[i].className.match && allClasses[i].className.match(/\\b(flex|grid|bg-\\w|text-\\w|p-\\d|m-\\d|w-\\d|rounded|shadow|border-\\w)/)) twCount++;
        }
        if (twCount > 5) tech.uiFrameworks.push('Tailwind CSS');
      }
      if (hasClass('bootstrap') || document.querySelector('[class*="btn-primary"], [class*="container-fluid"], .row > [class*="col-"]')) tech.uiFrameworks.push('Bootstrap');
      if (hasClass('MuiButton') || hasClass('MuiBox') || hasClass('css-') && document.querySelector('[class*="Mui"]')) tech.uiFrameworks.push('Material UI');
      if (hasClass('chakra-')) tech.uiFrameworks.push('Chakra UI');
      if (hasClass('ant-')) tech.uiFrameworks.push('Ant Design');
      if (document.querySelector('[data-radix-collection-item], [data-radix-popper-content-wrapper]')) tech.uiFrameworks.push('Radix UI');
      if (hasClass('mantine-')) tech.uiFrameworks.push('Mantine');

      // === Build Tools ===
      const scripts = Array.from(document.querySelectorAll('script[src]')).map(s => s.src);
      const links = Array.from(document.querySelectorAll('link[href]')).map(l => l.href);
      const allSrcs = [...scripts, ...links].join(' ');
      if (allSrcs.includes('/_next/')) tech.buildTools.push('Next.js bundler');
      else if (allSrcs.match(/\\/assets\\/[\\w-]+\\.[a-f0-9]+\\.js/) || document.querySelector('script[type="module"][src*=".js"]')?.src?.includes('/assets/')) tech.buildTools.push('Vite');
      if (allSrcs.includes('webpack') || window.webpackChunk || window.webpackJsonp) tech.buildTools.push('Webpack');
      if (allSrcs.includes('parcel')) tech.buildTools.push('Parcel');
      if (document.querySelector('script[src*="turbopack"], script[src*="_next/static/chunks"]') && window.__NEXT_DATA__) tech.buildTools.push('Turbopack (possible)');

      // === Analytics ===
      if (window.ga || window.gtag || document.querySelector('script[src*="google-analytics"], script[src*="googletagmanager"]')) tech.analytics.push('Google Analytics');
      if (window.google_tag_manager || document.querySelector('script[src*="gtm.js"]')) tech.analytics.push('Google Tag Manager');
      if (window.analytics && window.analytics.track) tech.analytics.push('Segment');
      if (window.hj || document.querySelector('script[src*="hotjar"]')) tech.analytics.push('Hotjar');
      if (window.mixpanel) tech.analytics.push('Mixpanel');
      if (window.amplitude) tech.analytics.push('Amplitude');
      if (window.posthog) tech.analytics.push('PostHog');
      if (window.Sentry || window.__SENTRY__) tech.analytics.push('Sentry');
      if (window.LogRocket) tech.analytics.push('LogRocket');
      if (window.FS || document.querySelector('script[src*="fullstory"]')) tech.analytics.push('FullStory');
      if (window.Intercom) tech.analytics.push('Intercom');
      if (window.drift) tech.analytics.push('Drift');
      if (window.fbq || document.querySelector('script[src*="facebook"]')) tech.analytics.push('Facebook Pixel');

      // === Other Libraries ===
      if (window.jQuery || window.$?.fn?.jquery) tech.libraries.push('jQuery ' + (window.jQuery?.fn?.jquery || window.$?.fn?.jquery || ''));
      if (window._ && window._.VERSION) tech.libraries.push('Lodash ' + window._.VERSION);
      if (window.axios) tech.libraries.push('Axios');
      if (window.moment) tech.libraries.push('Moment.js');
      if (window.gsap || window.TweenMax) tech.libraries.push('GSAP');
      if (window.d3) tech.libraries.push('D3.js');
      if (window.Chart) tech.libraries.push('Chart.js');
      if (window.THREE) tech.libraries.push('Three.js');
      if (window.io) tech.libraries.push('Socket.io');
      if (window.Stripe) tech.libraries.push('Stripe.js');
      if (document.querySelector('script[src*="recaptcha"]')) tech.libraries.push('reCAPTCHA');

      // === Meta ===
      tech.meta.doctype = document.doctype ? document.doctype.name : 'none';
      tech.meta.charset = document.characterSet;
      const viewport = document.querySelector('meta[name="viewport"]');
      tech.meta.responsive = !!viewport;
      const generator = document.querySelector('meta[name="generator"]');
      if (generator) tech.meta.generator = generator.content;

      // PWA
      if (document.querySelector('link[rel="manifest"]')) tech.meta.pwa = true;
      if (navigator.serviceWorker?.controller) tech.meta.serviceWorker = true;

      // Clean up empty arrays
      for (const key of Object.keys(tech)) {
        if (Array.isArray(tech[key]) && tech[key].length === 0) delete tech[key];
      }
      if (Object.keys(tech.meta).length === 0) delete tech.meta;

      return tech;
    })()
  `;

  try {
    const result = await browser.tabs.executeScript(tabId, { code: script, frameId: 0 });
    return result[0] || { error: 'No result from script' };
  } catch (error) {
    return { error: error.message };
  }
}

/**
 * Get page performance metrics including Core Web Vitals
 */
async function handleGetPerformanceMetrics(tabId, params) {
  const includeResources = params?.includeResources !== false;

  const script = `
    (() => {
      const metrics = {};

      // Navigation Timing
      try {
        const nav = performance.getEntriesByType('navigation')[0];
        if (nav) {
          metrics.navigation = {
            dnsLookup: Math.round(nav.domainLookupEnd - nav.domainLookupStart),
            tcpConnect: Math.round(nav.connectEnd - nav.connectStart),
            tlsHandshake: Math.round(nav.secureConnectionStart > 0 ? nav.connectEnd - nav.secureConnectionStart : 0),
            ttfb: Math.round(nav.responseStart - nav.requestStart),
            responseDownload: Math.round(nav.responseEnd - nav.responseStart),
            domParsing: Math.round(nav.domInteractive - nav.responseEnd),
            domContentLoaded: Math.round(nav.domContentLoadedEventEnd - nav.startTime),
            pageLoad: Math.round(nav.loadEventEnd - nav.startTime),
            transferSize: nav.transferSize,
            decodedBodySize: nav.decodedBodySize,
            protocol: nav.nextHopProtocol,
            redirectCount: nav.redirectCount,
          };
        }
      } catch(e) {}

      // Core Web Vitals
      metrics.webVitals = {};

      // FCP
      try {
        const fcp = performance.getEntriesByName('first-contentful-paint')[0];
        if (fcp) metrics.webVitals.fcp = { value: Math.round(fcp.startTime), rating: fcp.startTime <= 1800 ? 'good' : fcp.startTime <= 3000 ? 'needs-improvement' : 'poor' };
      } catch(e) {}

      // LCP (from PerformanceObserver buffered entries)
      try {
        const lcpEntries = performance.getEntriesByType('largest-contentful-paint');
        if (lcpEntries.length > 0) {
          const lcp = lcpEntries[lcpEntries.length - 1];
          metrics.webVitals.lcp = { value: Math.round(lcp.startTime), element: lcp.element?.tagName?.toLowerCase() || null, url: lcp.url || null, rating: lcp.startTime <= 2500 ? 'good' : lcp.startTime <= 4000 ? 'needs-improvement' : 'poor' };
        }
      } catch(e) {}

      // CLS
      try {
        const clsEntries = performance.getEntriesByType('layout-shift');
        if (clsEntries.length > 0) {
          let clsValue = 0;
          let sessionValue = 0;
          let sessionEntries = [];
          let maxSessionValue = 0;
          let previousEntry;
          for (const entry of clsEntries) {
            if (!entry.hadRecentInput) {
              if (previousEntry && entry.startTime - previousEntry.startTime < 1000 && entry.startTime - sessionEntries[0]?.startTime < 5000) {
                sessionValue += entry.value;
              } else {
                sessionValue = entry.value;
                sessionEntries = [];
              }
              sessionEntries.push(entry);
              previousEntry = entry;
              maxSessionValue = Math.max(maxSessionValue, sessionValue);
            }
          }
          clsValue = maxSessionValue;
          metrics.webVitals.cls = { value: parseFloat(clsValue.toFixed(4)), rating: clsValue <= 0.1 ? 'good' : clsValue <= 0.25 ? 'needs-improvement' : 'poor' };
        }
      } catch(e) {}

      // INP (approximate — check event timing entries)
      try {
        const eventEntries = performance.getEntriesByType('event');
        if (eventEntries.length > 0) {
          const durations = eventEntries.map(e => e.duration).sort((a, b) => b - a);
          // INP is approximately the 98th percentile interaction
          const idx = Math.min(Math.floor(durations.length * 0.02), durations.length - 1);
          const inp = durations[idx] || durations[0];
          metrics.webVitals.inp = { value: Math.round(inp), sampleSize: eventEntries.length, rating: inp <= 200 ? 'good' : inp <= 500 ? 'needs-improvement' : 'poor' };
        }
      } catch(e) {}

      // Slowest Resources
      if (${includeResources}) {
        try {
          const resources = performance.getEntriesByType('resource');
          const sorted = resources
            .map(r => ({
              name: r.name.split('/').pop().split('?')[0] || r.name.slice(0, 80),
              fullUrl: r.name.slice(0, 200),
              type: r.initiatorType,
              duration: Math.round(r.duration),
              transferSize: r.transferSize,
              dns: Math.round(r.domainLookupEnd - r.domainLookupStart),
              tcp: Math.round(r.connectEnd - r.connectStart),
              ttfb: Math.round(r.responseStart - r.requestStart),
              download: Math.round(r.responseEnd - r.responseStart),
            }))
            .sort((a, b) => b.duration - a.duration)
            .slice(0, 10);
          if (sorted.length > 0) metrics.slowestResources = sorted;
        } catch(e) {}
      }

      // Long Tasks
      try {
        const longTasks = performance.getEntriesByType('longtask');
        if (longTasks.length > 0) {
          metrics.longTasks = {
            count: longTasks.length,
            totalBlockingTime: Math.round(longTasks.reduce((sum, t) => sum + Math.max(0, t.duration - 50), 0)),
            longest: Math.round(Math.max(...longTasks.map(t => t.duration))),
          };
        }
      } catch(e) {}

      // Memory (Chrome-only, but check anyway)
      try {
        if (performance.memory) {
          metrics.memory = {
            usedJSHeapSize: Math.round(performance.memory.usedJSHeapSize / 1048576) + ' MB',
            totalJSHeapSize: Math.round(performance.memory.totalJSHeapSize / 1048576) + ' MB',
            jsHeapSizeLimit: Math.round(performance.memory.jsHeapSizeLimit / 1048576) + ' MB',
          };
        }
      } catch(e) {}

      // Custom Performance Marks & Measures
      try {
        const marks = performance.getEntriesByType('mark');
        const measures = performance.getEntriesByType('measure');
        if (marks.length > 0 || measures.length > 0) {
          metrics.custom = {};
          if (marks.length > 0) metrics.custom.marks = marks.slice(-20).map(m => ({ name: m.name, time: Math.round(m.startTime) }));
          if (measures.length > 0) metrics.custom.measures = measures.slice(-20).map(m => ({ name: m.name, duration: Math.round(m.duration), start: Math.round(m.startTime) }));
        }
      } catch(e) {}

      // Resource summary
      try {
        const resources = performance.getEntriesByType('resource');
        const byType = {};
        for (const r of resources) {
          const t = r.initiatorType || 'other';
          if (!byType[t]) byType[t] = { count: 0, totalSize: 0, totalDuration: 0 };
          byType[t].count++;
          byType[t].totalSize += r.transferSize || 0;
          byType[t].totalDuration += r.duration || 0;
        }
        for (const t of Object.keys(byType)) {
          byType[t].totalSize = Math.round(byType[t].totalSize / 1024) + ' KB';
          byType[t].avgDuration = Math.round(byType[t].totalDuration / byType[t].count) + ' ms';
          delete byType[t].totalDuration;
        }
        metrics.resourceSummary = { total: resources.length, byType };
      } catch(e) {}

      return metrics;
    })()
  `;

  try {
    const result = await browser.tabs.executeScript(tabId, { code: script, frameId: 0 });
    return result[0] || { error: 'No result from script' };
  } catch (error) {
    return { error: error.message };
  }
}

/**
 * Audit accessibility — 10 WCAG checks
 */
async function handleAuditAccessibility(tabId, params) {
  const maxIssues = Math.min(params?.maxIssues || 20, 50);

  const script = `
    (() => {
      const MAX = ${maxIssues};
      const issues = {};
      const add = (category, item) => {
        if (!issues[category]) issues[category] = [];
        if (issues[category].length < MAX) issues[category].push(item);
      };
      const getSelector = (el) => {
        if (el.id) return '#' + el.id;
        if (el.getAttribute('data-testid')) return '[data-testid="' + el.getAttribute('data-testid') + '"]';
        if (el.getAttribute('aria-label')) return el.tagName.toLowerCase() + '[aria-label="' + el.getAttribute('aria-label') + '"]';
        let sel = el.tagName.toLowerCase();
        if (el.className && typeof el.className === 'string') {
          const cls = el.className.split(' ').filter(c => c && !c.match(/^(css-|sc-|svelte-)/)).slice(0, 2).join('.');
          if (cls) sel += '.' + cls;
        }
        return sel;
      };

      // 1. Images missing alt
      document.querySelectorAll('img:not([alt]), img[alt=""], [role="img"]:not([aria-label])').forEach(el => {
        add('missingAlt', { selector: getSelector(el), src: (el.src || '').slice(0, 100) });
      });

      // 2. Unlabeled inputs
      document.querySelectorAll('input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="reset"]), select, textarea').forEach(el => {
        const hasLabel = el.id && document.querySelector('label[for="' + el.id + '"]');
        const hasAriaLabel = el.getAttribute('aria-label') || el.getAttribute('aria-labelledby');
        const wrappedInLabel = el.closest('label');
        const hasTitle = el.getAttribute('title');
        const hasPlaceholder = el.getAttribute('placeholder');
        if (!hasLabel && !hasAriaLabel && !wrappedInLabel && !hasTitle) {
          add('unlabeledInputs', { selector: getSelector(el), type: el.type || el.tagName.toLowerCase(), hasPlaceholder: !!hasPlaceholder, note: hasPlaceholder ? 'placeholder is not a substitute for a label' : undefined });
        }
      });

      // 3. Missing lang
      if (!document.documentElement.getAttribute('lang')) {
        add('missingLang', { issue: 'Document <html> element has no lang attribute' });
      }

      // 4. Empty links
      document.querySelectorAll('a[href]').forEach(el => {
        const text = (el.textContent || '').trim();
        const ariaLabel = el.getAttribute('aria-label') || el.getAttribute('aria-labelledby');
        const hasImg = el.querySelector('img[alt]:not([alt=""])');
        if (!text && !ariaLabel && !hasImg) {
          add('emptyLinks', { selector: getSelector(el), href: (el.href || '').slice(0, 100) });
        }
      });

      // 5. Empty buttons
      document.querySelectorAll('button, [role="button"]').forEach(el => {
        const text = (el.textContent || '').trim();
        const ariaLabel = el.getAttribute('aria-label') || el.getAttribute('aria-labelledby');
        const hasImg = el.querySelector('img[alt]:not([alt=""]), svg[aria-label]');
        if (!text && !ariaLabel && !hasImg) {
          add('emptyButtons', { selector: getSelector(el) });
        }
      });

      // 6. Heading hierarchy
      const headings = Array.from(document.querySelectorAll('h1, h2, h3, h4, h5, h6'));
      let prevLevel = 0;
      headings.forEach(h => {
        const level = parseInt(h.tagName[1]);
        if (prevLevel > 0 && level > prevLevel + 1) {
          add('headingHierarchy', { issue: 'Skipped from h' + prevLevel + ' to h' + level, selector: getSelector(h), text: (h.textContent || '').trim().slice(0, 60) });
        }
        prevLevel = level;
      });
      const h1Count = document.querySelectorAll('h1').length;
      if (h1Count === 0) add('headingHierarchy', { issue: 'No h1 element found' });
      else if (h1Count > 1) add('headingHierarchy', { issue: h1Count + ' h1 elements found (should be 1)' });

      // 7. Color contrast (sample check on visible text elements)
      try {
        const textEls = document.querySelectorAll('p, span, a, li, td, th, label, h1, h2, h3, h4, h5, h6');
        const checked = new Set();
        let contrastIssues = 0;
        for (let i = 0; i < textEls.length && contrastIssues < MAX; i++) {
          const el = textEls[i];
          const rect = el.getBoundingClientRect();
          if (rect.width === 0 || rect.height === 0) continue;
          const style = window.getComputedStyle(el);
          const fg = style.color;
          const bg = style.backgroundColor;
          if (!fg || !bg || bg === 'rgba(0, 0, 0, 0)' || bg === 'transparent') continue;

          const parseColor = (c) => {
            const m = c.match(/rgba?\\((\\d+),\\s*(\\d+),\\s*(\\d+)/);
            return m ? [+m[1], +m[2], +m[3]] : null;
          };
          const luminance = ([r, g, b]) => {
            const [rs, gs, bs] = [r, g, b].map(c => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); });
            return 0.2126 * rs + 0.7152 * gs + 0.0722 * bs;
          };

          const fgRgb = parseColor(fg);
          const bgRgb = parseColor(bg);
          if (!fgRgb || !bgRgb) continue;

          const l1 = luminance(fgRgb);
          const l2 = luminance(bgRgb);
          const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);

          const fontSize = parseFloat(style.fontSize);
          const isBold = parseInt(style.fontWeight) >= 700;
          const isLargeText = fontSize >= 24 || (fontSize >= 18.66 && isBold);
          const threshold = isLargeText ? 3 : 4.5;

          if (ratio < threshold) {
            const key = fg + '|' + bg;
            if (!checked.has(key)) {
              checked.add(key);
              add('colorContrast', { selector: getSelector(el), ratio: parseFloat(ratio.toFixed(2)), required: threshold, foreground: fg, background: bg, text: (el.textContent || '').trim().slice(0, 40) });
              contrastIssues++;
            }
          }
        }
      } catch(e) {}

      // 8. ARIA landmarks
      const landmarks = {
        banner: document.querySelectorAll('header, [role="banner"]').length,
        navigation: document.querySelectorAll('nav, [role="navigation"]').length,
        main: document.querySelectorAll('main, [role="main"]').length,
        contentinfo: document.querySelectorAll('footer, [role="contentinfo"]').length,
      };
      if (landmarks.main === 0) add('landmarks', { issue: 'No main landmark (<main> or [role="main"])' });
      if (landmarks.navigation === 0) add('landmarks', { issue: 'No navigation landmark (<nav> or [role="navigation"])' });
      // Report what exists
      add('landmarks', { found: landmarks });

      // 9. Positive tabindex
      document.querySelectorAll('[tabindex]').forEach(el => {
        const val = parseInt(el.getAttribute('tabindex'));
        if (val > 0) {
          add('tabindexIssues', { selector: getSelector(el), tabindex: val, issue: 'Positive tabindex disrupts natural tab order' });
        }
      });

      // 10. Duplicate IDs
      const ids = {};
      document.querySelectorAll('[id]').forEach(el => {
        const id = el.id;
        if (!ids[id]) ids[id] = 0;
        ids[id]++;
      });
      for (const [id, count] of Object.entries(ids)) {
        if (count > 1) {
          add('duplicateIds', { id, count, issue: 'ID "' + id + '" used ' + count + ' times' });
        }
      }

      // Summary
      const summary = {};
      let totalIssues = 0;
      for (const [cat, items] of Object.entries(issues)) {
        if (cat === 'landmarks' && items.length === 1 && items[0].found) continue;
        summary[cat] = items.length;
        totalIssues += items.length;
      }

      return { totalIssues, summary, issues };
    })()
  `;

  try {
    const result = await browser.tabs.executeScript(tabId, { code: script, frameId: 0 });
    return result[0] || { error: 'No result from script' };
  } catch (error) {
    return { error: error.message };
  }
}

/**
 * Inspect application state (React, Redux, Vue, Angular, globals)
 */
async function handleInspectAppState(tabId, params) {
  const target = params?.target || 'auto';
  const selector = params?.selector || null;
  const path = params?.path || null;
  const maxDepth = Math.min(params?.maxDepth || 3, 6);

  const script = `
    (() => {
      const TARGET = ${JSON.stringify(target)};
      const SELECTOR = ${JSON.stringify(selector)};
      const PATH = ${JSON.stringify(path)};
      const MAX_DEPTH = ${maxDepth};
      const MAX_KEYS = 50;
      const MAX_STR = 200;
      const MAX_ARRAY = 20;

      function safeSerialize(obj, depth) {
        if (depth === undefined) depth = 0;
        if (depth > MAX_DEPTH) return '[max depth]';
        if (obj === null) return null;
        if (obj === undefined) return undefined;
        const t = typeof obj;
        if (t === 'string') return obj.length > MAX_STR ? obj.slice(0, MAX_STR) + '...[' + obj.length + ' chars]' : obj;
        if (t === 'number' || t === 'boolean') return obj;
        if (t === 'function') return '[function ' + (obj.name || 'anonymous') + ']';
        if (t === 'symbol') return obj.toString();
        if (obj instanceof HTMLElement) return '[HTMLElement: ' + obj.tagName.toLowerCase() + (obj.id ? '#' + obj.id : '') + ']';
        if (obj instanceof Error) return { error: obj.message, stack: (obj.stack || '').slice(0, 200) };
        if (Array.isArray(obj)) {
          const result = obj.slice(0, MAX_ARRAY).map(item => safeSerialize(item, depth + 1));
          if (obj.length > MAX_ARRAY) result.push('[...' + (obj.length - MAX_ARRAY) + ' more]');
          return result;
        }
        if (t === 'object') {
          const result = {};
          const keys = Object.keys(obj).slice(0, MAX_KEYS);
          for (const key of keys) {
            try { result[key] = safeSerialize(obj[key], depth + 1); } catch(e) { result[key] = '[error: ' + e.message + ']'; }
          }
          const totalKeys = Object.keys(obj).length;
          if (totalKeys > MAX_KEYS) result['__truncated__'] = totalKeys + ' total keys, showing ' + MAX_KEYS;
          return result;
        }
        return String(obj);
      }

      function resolvePath(obj, path) {
        if (!path) return obj;
        const parts = path.split('.');
        let current = obj;
        for (const part of parts) {
          if (current === null || current === undefined) return undefined;
          // Handle bracket notation like [0]
          const bracketMatch = part.match(/^(\\w+)\\[(\\d+)\\]$/);
          if (bracketMatch) {
            current = current[bracketMatch[1]];
            if (current === null || current === undefined) return undefined;
            current = current[parseInt(bracketMatch[2])];
          } else {
            current = current[part];
          }
        }
        return current;
      }

      function getReactFiber(el) {
        if (!el) return null;
        // Firefox content scripts see Xray-wrapped DOM nodes — wrappedJSObject
        // exposes page-world expandos like __reactFiber$* that are otherwise hidden.
        const pageEl = (el && typeof el.wrappedJSObject !== 'undefined') ? el.wrappedJSObject : el;
        const key = Object.keys(pageEl).find(k => k.startsWith('__reactFiber') || k.startsWith('__reactInternalInstance'));
        return key ? pageEl[key] : null;
      }

      function getReactState(sel) {
        const el = sel ? document.querySelector(sel) : (document.querySelector('#root, #__next, #app, [data-reactroot]'));
        if (!el) return { error: 'Element not found' + (sel ? ': ' + sel : '') };

        const fiber = getReactFiber(el);
        if (!fiber) return { error: 'No React fiber found on element' };

        // Walk up to find component with state/props
        const components = [];
        let node = fiber;
        for (let i = 0; i < 30 && node; i++) {
          if (node.memoizedState || node.memoizedProps) {
            const name = node.type?.displayName || node.type?.name || null;
            if (name) {
              const comp = { component: name };
              if (node.memoizedProps) comp.props = safeSerialize(node.memoizedProps, 0);
              // Extract hooks state
              if (node.memoizedState) {
                const hooks = [];
                let hookNode = node.memoizedState;
                for (let h = 0; h < 10 && hookNode; h++) {
                  if (hookNode.memoizedState !== undefined && hookNode.memoizedState !== null) {
                    hooks.push(safeSerialize(hookNode.memoizedState, 0));
                  }
                  hookNode = hookNode.next;
                }
                if (hooks.length > 0) comp.hooks = hooks;
              }
              components.push(comp);
              if (components.length >= 5) break;
            }
          }
          node = node.return;
        }

        return components.length > 0 ? { framework: 'React', components } : { error: 'No React components with state found' };
      }

      function getReduxState() {
        // Try __REDUX_DEVTOOLS_EXTENSION__
        let store = null;
        try {
          if (window.__REDUX_DEVTOOLS_EXTENSION__) {
            // Try to find store via common patterns
            const rootEl = document.querySelector('#root, #__next, #app');
            if (rootEl) {
              const fiber = getReactFiber(rootEl);
              let node = fiber;
              for (let i = 0; i < 50 && node; i++) {
                if (node.memoizedProps?.store?.getState) { store = node.memoizedProps.store; break; }
                // Check stateNode for class components with context
                if (node.stateNode?.store?.getState) { store = node.stateNode.store; break; }
                node = node.return;
              }
            }
          }
        } catch(e) {}

        // Try common global patterns
        if (!store) {
          const candidates = [window.store, window.__store__, window.reduxStore, window.__REDUX_STORE__];
          store = candidates.find(s => s && typeof s.getState === 'function');
        }

        if (!store) return { error: 'Redux store not found. Store may not be exposed globally.' };

        let state = store.getState();
        if (PATH) state = resolvePath(state, PATH);
        return { framework: 'Redux', state: safeSerialize(state, 0) };
      }

      function getVueState(sel) {
        const el = sel ? document.querySelector(sel) : document.querySelector('#app, [data-v-app], #__nuxt');
        if (!el) return { error: 'Vue root not found' };
        const pageEl = (el && typeof el.wrappedJSObject !== 'undefined') ? el.wrappedJSObject : el;

        // Vue 3
        if (pageEl.__vue_app__) {
          const result = { framework: 'Vue 3' };
          const instance = pageEl.__vue_app__?.config?.globalProperties?.$root || pageEl.__vue__?.$root;

          // Try Pinia
          if (window.__pinia) {
            try {
              const stores = {};
              window.__pinia._s.forEach((store, id) => {
                stores[id] = safeSerialize(store.$state, 0);
              });
              result.pinia = stores;
            } catch(e) {}
          }

          return result;
        }

        // Vue 2
        if (pageEl.__vue__) {
          const vm = pageEl.__vue__;
          const result = { framework: 'Vue 2', data: safeSerialize(vm.$data, 0) };
          if (vm.$store) result.vuex = safeSerialize(vm.$store.state, 0);
          return result;
        }

        return { error: 'No Vue instance found on element' };
      }

      function getAngularState(sel) {
        const el = sel ? document.querySelector(sel) : document.querySelector('[ng-version], [_nghost], [ng-app]');
        if (!el) return { error: 'Angular element not found' };

        // Angular 2+
        if (window.ng) {
          try {
            const component = window.ng.getComponent(el);
            if (component) {
              return { framework: 'Angular', component: component.constructor?.name, state: safeSerialize(component, 0) };
            }
          } catch(e) {}

          // Try child elements
          const children = el.querySelectorAll('*');
          for (let i = 0; i < Math.min(children.length, 20); i++) {
            try {
              const comp = window.ng.getComponent(children[i]);
              if (comp) return { framework: 'Angular', component: comp.constructor?.name, state: safeSerialize(comp, 0) };
            } catch(e) {}
          }
        }

        // AngularJS
        if (window.angular) {
          try {
            const scope = window.angular.element(el).scope();
            if (scope) return { framework: 'AngularJS', scope: safeSerialize(scope, 0) };
          } catch(e) {}
        }

        return { error: 'No Angular component found' };
      }

      function getGlobalState() {
        if (!PATH) return { error: 'path is required for target:"global" (e.g., "document.title", "myApp.config")' };
        const value = resolvePath(window, PATH);
        if (value === undefined) return { error: 'Property not found: ' + PATH };
        return { path: PATH, value: safeSerialize(value, 0) };
      }

      function autoDetect() {
        const results = {};

        // Check React
        const reactRoot = document.querySelector('#root, #__next, #app, [data-reactroot]');
        if (reactRoot && getReactFiber(reactRoot)) {
          results.react = getReactState(SELECTOR);
        }

        // Check Redux
        if (window.__REDUX_DEVTOOLS_EXTENSION__ || window.store?.getState) {
          const redux = getReduxState();
          if (!redux.error) results.redux = redux;
        }

        // Check Vue
        const vueRoot = document.querySelector('#app, [data-v-app], #__nuxt');
        if (vueRoot && (vueRoot.__vue_app__ || vueRoot.__vue__)) {
          results.vue = getVueState(SELECTOR);
        }

        // Check Angular
        if (window.ng || window.angular) {
          const angular = getAngularState(SELECTOR);
          if (!angular.error) results.angular = angular;
        }

        if (Object.keys(results).length === 0) return { error: 'No supported framework state detected. Try target:"global" with a specific path.' };
        return results;
      }

      try {
        switch (TARGET) {
          case 'react': return getReactState(SELECTOR);
          case 'redux': return getReduxState();
          case 'vue': return getVueState(SELECTOR);
          case 'angular': return getAngularState(SELECTOR);
          case 'global': return getGlobalState();
          case 'auto': default: return autoDetect();
        }
      } catch (e) {
        return { error: e.message };
      }
    })()
  `;

  try {
    const result = await browser.tabs.executeScript(tabId, { code: script, frameId: 0 });
    return result[0] || { error: 'No result from script' };
  } catch (error) {
    return { error: error.message };
  }
}

// ==========================================================================

// Make executeTool available globally for background.js
window.executeTool = executeTool;

// Export buffer management functions for background.js
window.addToConsoleBuffer = addToConsoleBuffer;
window.addToErrorBuffer = addToErrorBuffer;
window.addToWebsocketBuffer = addToWebsocketBuffer;

// Export network buffer access for debugging
window.getNetworkRequests = (tabId) => networkRequestBuffers.get(tabId) || [];
window.clearAllNetworkRequests = () => networkRequestBuffers.clear();

// Export header/blocking access
window.getCustomRequestHeaders = (tabId) => customRequestHeaders.get(tabId) || {};
window.getBlockedUrlPatterns = (tabId) => blockedUrlPatterns.get(tabId) || [];

console.log('[Claude Assistant] Tool router initialized');
