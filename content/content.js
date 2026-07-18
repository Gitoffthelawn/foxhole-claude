/**
 * Foxhole for Claude - Content Script
 * Handles DOM manipulation commands from background script
 * Adapted from FoxHole Debug Bridge content.js
 */

(function() {
  'use strict';

  // Prevent multiple injections
  if (window.__claude_assistant_injected) {
    return;
  }
  window.__claude_assistant_injected = true;

  // ============================================================================
  // SPA NAVIGATION DETECTION
  // SPAs change URLs via pushState/replaceState without a network event.
  // Patch history methods and listen to popstate so background knows the view changed.
  // ============================================================================

  (function patchHistory() {
    const emit = (url) => {
      browser.runtime.sendMessage({ type: 'spa_navigation', url }).catch(() => {});
    };
    const _pushState = history.pushState.bind(history);
    const _replaceState = history.replaceState.bind(history);
    history.pushState = function(...args) {
      _pushState(...args);
      emit(location.href);
    };
    history.replaceState = function(...args) {
      _replaceState(...args);
      emit(location.href);
    };
    window.addEventListener('popstate', () => emit(location.href));
  })();

  // ============================================================================
  // ELEMENT REGISTRY (WeakRef-based stable handles, survive SPA re-renders)
  // ============================================================================

  let _foxRefCounter = 0;
  const _foxRefMap = new Map();
  const _foxReverseMap = new WeakMap();
  // Stable attrs stored at registration time for re-anchoring after SPA re-renders
  const _foxRefMeta = new Map();

  function registerElement(el) {
    if (_foxReverseMap.has(el)) return _foxReverseMap.get(el);
    const id = `tref_${++_foxRefCounter}`;
    _foxRefMap.set(id, new WeakRef(el));
    _foxReverseMap.set(el, id);
    _foxRefMeta.set(id, {
      tag: el.tagName.toLowerCase(),
      id: el.id || null,
      ariaLabel: el.getAttribute('aria-label') || null,
      testId: el.getAttribute('data-testid') || el.getAttribute('data-test-id') || null,
      role: el.getAttribute('role') || null,
    });
    return id;
  }

  // ============================================================================
  // DEBUG LOGGING
  // ============================================================================

  let _contentDebugLogging = false;
  const _contentDebugBuffer = [];
  const _CONTENT_DEBUG_MAX = 500;
  const _CONTENT_DEBUG_PERSIST = 200;

  function debugLog(level, ...args) {
    const entry = {
      ts: Date.now(),
      level,
      src: 'content',
      msg: args.map(a => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ')
    };
    if (_contentDebugLogging) {
      _contentDebugBuffer.push(entry);
      if (_contentDebugBuffer.length > _CONTENT_DEBUG_MAX) _contentDebugBuffer.shift();
      browser.storage.local.set({ foxholeDebugLogs_content: _contentDebugBuffer.slice(-_CONTENT_DEBUG_PERSIST) }).catch(() => {});
    }
    if (level === 'ERROR') {
      console.error('[Content]', ...args);
    } else {
      console.log('[Content]', ...args);
    }
  }

  browser.storage.local.get('debugLogging').then(r => {
    _contentDebugLogging = r.debugLogging === true;
  }).catch(() => {});

  browser.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.debugLogging !== undefined) {
      _contentDebugLogging = changes.debugLogging.newValue === true;
    }
  });

  // Settings - default to capturing source
  let captureLogSource = true;

  // Load setting from storage
  browser.storage.local.get('captureLogSource').then(result => {
    captureLogSource = result.captureLogSource !== false;
    // Update the page script setting
    window.postMessage({ type: '__claude_assistant_setting', captureLogSource }, '*');
  }).catch(() => {
    // Ignore errors, use default
  });

  // Listen for console logs from page context
  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    if (event.data?.type === '__claude_assistant_console') {
      try {
        browser.runtime.sendMessage({
          type: 'console_log',
          data: event.data.data
        }).catch(() => {});
      } catch (e) {
        // Ignore
      }
    }
  });

  // Inject console hook into page context
  const pageScript = `
(function() {
  if (window.__claude_assistant_page_injected) return;
  window.__claude_assistant_page_injected = true;

  let captureLogSource = true;

  // Listen for setting updates from content script
  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    if (event.data?.type === '__claude_assistant_setting' && 'captureLogSource' in event.data) {
      captureLogSource = event.data.captureLogSource;
    }
  });

  const originalConsole = {
    log: console.log,
    warn: console.warn,
    error: console.error,
    info: console.info,
    debug: console.debug
  };

  function interceptConsole(level) {
    console[level] = function(...args) {
      originalConsole[level].apply(console, args);

      let source = null;
      if (captureLogSource) {
        try {
          const stack = new Error().stack;
          if (stack) {
            const lines = stack.split('\\n');
            for (let i = 2; i < lines.length; i++) {
              const line = lines[i].trim();
              if (!line) continue;
              // Skip our injected script
              if (line.includes('__claude_assistant')) continue;

              let match = line.match(/@(.+):(\\d+):(\\d+)$/);
              if (!match) match = line.match(/\\((.+):(\\d+):(\\d+)\\)$/);
              if (!match) match = line.match(/at (.+):(\\d+):(\\d+)$/);

              if (match) {
                source = { file: match[1], line: parseInt(match[2], 10), column: parseInt(match[3], 10) };
                break;
              }
            }
          }
        } catch (e) {}
      }

      try {
        window.postMessage({
          type: '__claude_assistant_console',
          data: {
            level,
            args: args.map(arg => {
              try {
                if (arg instanceof Error) {
                  return { type: 'Error', message: arg.message, stack: arg.stack };
                }
                return typeof arg === 'object' ? JSON.stringify(arg) : String(arg);
              } catch (e) {
                return String(arg);
              }
            }),
            timestamp: Date.now(),
            location: window.location.href,
            source
          }
        }, '*');
      } catch (e) {}
    };
  }

  ['log', 'warn', 'error', 'info', 'debug'].forEach(interceptConsole);
})();
`;

  // Inject script into page context
  const script = document.createElement('script');
  script.textContent = pageScript;
  (document.documentElement || document.head || document.body).appendChild(script);
  script.remove();

  // Error interception
  window.addEventListener('error', (event) => {
    try {
      browser.runtime.sendMessage({
        type: 'js_error',
        data: {
          message: event.message,
          source: event.filename,
          lineno: event.lineno,
          colno: event.colno,
          error: event.error ? {
            message: event.error.message,
            stack: event.error.stack
          } : null,
          timestamp: Date.now(),
          location: window.location.href
        }
      }).catch(() => {});
    } catch (e) {
      // Ignore
    }
  }, true);

  window.addEventListener('unhandledrejection', (event) => {
    try {
      // Serialize the rejection reason properly
      let reasonMessage;
      let reasonData = null;
      const reason = event.reason;

      if (reason instanceof Error) {
        reasonMessage = reason.message;
      } else if (typeof reason === 'string') {
        reasonMessage = reason;
      } else if (reason && typeof reason === 'object') {
        try {
          reasonMessage = JSON.stringify(reason);
          reasonData = reason;
        } catch (e) {
          reasonMessage = reason.message || reason.toString();
        }
      } else {
        reasonMessage = String(reason);
      }

      browser.runtime.sendMessage({
        type: 'js_error',
        data: {
          message: 'Unhandled Promise Rejection: ' + reasonMessage,
          error: reason ? {
            message: reasonMessage,
            stack: reason?.stack,
            data: reasonData
          } : null,
          timestamp: Date.now(),
          location: window.location.href
        }
      }).catch(() => {});
    } catch (e) {
      // Ignore
    }
  });

  // WebSocket interception (wrapped in try-catch as Firefox marks WebSocket as read-only)
  try {
    const OriginalWebSocket = window.WebSocket;
    window.WebSocket = function(...args) {
      const ws = new OriginalWebSocket(...args);
      const url = args[0];

      ws.addEventListener('message', (event) => {
        try {
          browser.runtime.sendMessage({
            type: 'websocket_message',
            data: {
              direction: 'receive',
              url,
              data: event.data,
              timestamp: Date.now(),
              location: window.location.href
            }
          }).catch(() => {});
        } catch (e) {
          // Ignore
        }
      });

      const originalSend = ws.send;
      ws.send = function(data) {
        try {
          browser.runtime.sendMessage({
            type: 'websocket_message',
            data: {
              direction: 'send',
              url,
              data,
              timestamp: Date.now(),
              location: window.location.href
            }
          }).catch(() => {});
        } catch (e) {
          // Ignore
        }
        return originalSend.call(this, data);
      };

      return ws;
    };
  } catch (e) {
    // WebSocket interception not available (Firefox marks it as read-only)
    // Continue without WebSocket monitoring
  }

  // ==========================================================================
  // USER-DRIVEN SELECTION MODE
  // Allows user to click elements to mark them for later retrieval
  // ==========================================================================

  // Workflow recording
  let _recordingActive = false;

  let selectionModeActive = false;
  let hoveredElement = null;
  let selectedElements = new Set();
  let selectionObserver = null;

  function startSelectionObserver() {
    if (selectionObserver) return;
    selectionObserver = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.type === 'attributes' && mutation.attributeName === 'data-user-selected') {
          const el = mutation.target;
          if (selectedElements.has(el) && el.isConnected && !el.hasAttribute('data-user-selected')) {
            el.setAttribute('data-user-selected', 'true');
          }
        }
      }
    });
    selectionObserver.observe(document.body, {
      attributes: true,
      attributeFilter: ['data-user-selected'],
      subtree: true
    });
  }

  function stopSelectionObserver() {
    if (selectionObserver) {
      selectionObserver.disconnect();
      selectionObserver = null;
    }
  }

  function enterSelectionMode() {
    if (selectionModeActive) return { alreadyActive: true };

    selectionModeActive = true;
    document.body.style.cursor = 'crosshair';

    // Inject selection mode styles
    const style = document.createElement('style');
    style.id = 'claude-selection-mode-styles';
    style.textContent = `
      .claude-hover-highlight { outline: 2px dashed #007bff !important; outline-offset: 2px; }
      [data-user-selected="true"] { outline: 3px solid #FFD700 !important; outline-offset: 2px; background-color: rgba(255,215,0,0.1) !important; }
    `;
    document.head.appendChild(style);

    document.addEventListener('mouseover', handleSelectionHover);
    document.addEventListener('mouseout', handleSelectionHoverOut);
    document.addEventListener('click', handleSelectionClick, true);
    document.addEventListener('keydown', handleSelectionEscape);

    startSelectionObserver();

    return { active: true, message: 'Selection mode activated. Click elements to mark them. Press Escape to exit.' };
  }

  function exitSelectionMode() {
    if (!selectionModeActive) return { alreadyInactive: true };

    selectionModeActive = false;
    document.body.style.cursor = '';
    document.getElementById('claude-selection-mode-styles')?.remove();
    document.removeEventListener('mouseover', handleSelectionHover);
    document.removeEventListener('mouseout', handleSelectionHoverOut);
    document.removeEventListener('click', handleSelectionClick, true);
    document.removeEventListener('keydown', handleSelectionEscape);

    if (hoveredElement) {
      hoveredElement.classList.remove('claude-hover-highlight');
      hoveredElement = null;
    }

    const activeCount = [...selectedElements].filter(el => el.isConnected).length;
    return { active: false, selectedCount: activeCount, message: `Selection mode deactivated. ${activeCount} element(s) selected.` };
  }

  function handleSelectionHover(e) {
    if (!selectionModeActive) return;
    if (hoveredElement) hoveredElement.classList.remove('claude-hover-highlight');
    hoveredElement = e.target;
    hoveredElement.classList.add('claude-hover-highlight');
  }

  function handleSelectionHoverOut(e) {
    if (e.target === hoveredElement) {
      hoveredElement.classList.remove('claude-hover-highlight');
    }
  }

  function handleSelectionClick(e) {
    if (!selectionModeActive) return;
    e.preventDefault();
    e.stopPropagation();

    const el = e.target;
    // Toggle selection — Set is the source of truth, attribute is visual only
    if (selectedElements.has(el)) {
      selectedElements.delete(el);
      el.removeAttribute('data-user-selected');
    } else {
      selectedElements.add(el);
      el.setAttribute('data-user-selected', 'true');
    }
  }

  function handleSelectionEscape(e) {
    if (e.key === 'Escape' && selectionModeActive) {
      exitSelectionMode();
      // Notify background that selection mode was exited via Escape
      try {
        browser.runtime.sendMessage({
          type: 'selection_mode_exited',
          selectedCount: [...selectedElements].filter(el => el.isConnected).length
        }).catch(() => {});
      } catch (err) {
        // Ignore
      }
    }
  }

  function getUserSelections(params = {}) {
    const { include_html = false, include_text = true, include_parent = true } = params;
    // Read from Set (source of truth); filter detached nodes from React/SPA unmounts
    const elements = [...selectedElements].filter(el => el.isConnected);

    const items = elements.map((el, index) => {
      const item = {
        index,
        tag: el.tagName.toLowerCase(),
        id: el.id || null,
        className: el.className || null
      };

      if (include_text) {
        const text = el.textContent?.trim() || '';
        item.text = text.slice(0, 200) + (text.length > 200 ? '...' : '');
      }

      if (include_html) {
        const html = el.outerHTML || '';
        item.html = html.slice(0, 500) + (html.length > 500 ? '...' : '');
      }

      // Include parent container info for partial selections (e.g. price tag within product card)
      if (include_parent) {
        const parent = findMeaningfulParent(el);
        if (parent && parent !== el) {
          const parentText = parent.textContent?.trim() || '';
          item.parent = {
            tag: parent.tagName.toLowerCase(),
            id: parent.id || null,
            className: parent.className || null,
            text: parentText.slice(0, 500) + (parentText.length > 500 ? '...' : '')
          };
          item.parentSelector = buildSelector(parent);
        }
      }

      return item;
    });

    return {
      count: items.length,
      items,
      selectionModeActive
    };
  }

  // Find meaningful parent container based on DOM structure
  // Looks for a parent with significantly more content than the selected element
  function findMeaningfulParent(el) {
    const selectedTextLen = (el.textContent?.trim() || '').length;
    let current = el.parentElement;
    let depth = 0;

    while (current && depth < 8) {
      const tag = current.tagName.toLowerCase();

      // Skip layout containers that are too broad
      if (['body', 'html', 'main', 'header', 'footer', 'nav'].includes(tag)) break;

      const parentTextLen = (current.textContent?.trim() || '').length;
      const hasMoreContent = parentTextLen > selectedTextLen * 1.5 && parentTextLen < 2000;
      const hasMultipleChildren = current.children.length > 1;

      // Good parent: has more content and multiple children (suggests it's a container)
      if (hasMoreContent && hasMultipleChildren) {
        return current;
      }

      current = current.parentElement;
      depth++;
    }

    // Fallback: immediate parent if it has more content
    if (el.parentElement) {
      const parentTextLen = (el.parentElement.textContent?.trim() || '').length;
      if (parentTextLen > selectedTextLen * 1.2) {
        return el.parentElement;
      }
    }

    return null;
  }

  // Build CSS selector for element
  function buildSelector(el) {
    if (el.id) return `#${el.id}`;
    const tag = el.tagName.toLowerCase();
    if (el.className) {
      const mainClass = el.className.split(/\s+/)[0];
      if (mainClass && !mainClass.includes(':')) return `${tag}.${mainClass}`;
    }
    return tag;
  }

  function clearUserSelections() {
    let cleared = 0;
    for (const el of selectedElements) {
      if (el.isConnected) {
        el.removeAttribute('data-user-selected');
        cleared++;
      }
    }
    selectedElements.clear();
    stopSelectionObserver();
    return { cleared };
  }

  // ==========================================================================
  // Element Marking
  // ==========================================================================

  function handleMarkElements(params) {
    const { selector, filter, label, style } = params;
    if (!selector || !label) return { error: 'selector and label are required' };

    const defaultStyle = 'outline: 3px solid #FFD700; outline-offset: 2px; background-color: rgba(255, 215, 0, 0.1);';
    const highlightStyle = style || defaultStyle;

    if (!document.getElementById('claude-mark-styles')) {
      const styleEl = document.createElement('style');
      styleEl.id = 'claude-mark-styles';
      styleEl.textContent = `[data-claude-marked] { ${highlightStyle} }`;
      document.head.appendChild(styleEl);
    }

    const elements = document.querySelectorAll(selector);
    let marked = 0;

    elements.forEach((el, idx) => {
      let shouldMark = true;
      if (filter) {
        try { shouldMark = (new Function('el', `return ${filter}`))(el); }
        catch (e) { shouldMark = false; }
      }
      if (shouldMark) {
        el.setAttribute('data-claude-marked', label);
        el.setAttribute('data-claude-mark-index', marked.toString());
        marked++;
      }
    });

    return { marked, total: elements.length, label };
  }

  function handleGetMarkedElements(params) {
    const { label, include_text = true } = params || {};
    const selector = label ? `[data-claude-marked="${label}"]` : '[data-claude-marked]';
    const elements = document.querySelectorAll(selector);
    const byLabel = {};
    const items = [];

    elements.forEach((el, idx) => {
      const elLabel = el.getAttribute('data-claude-marked');
      byLabel[elLabel] = (byLabel[elLabel] || 0) + 1;
      if (include_text) {
        const text = (el.textContent || '').trim().slice(0, 100);
        items.push({ index: idx, label: elLabel, tag: el.tagName.toLowerCase(), text });
      }
    });

    return { totalMarked: elements.length, byLabel, items: include_text ? items : undefined };
  }

  function handleClearMarkedElements(params) {
    const { label } = params || {};
    const selector = label ? `[data-claude-marked="${label}"]` : '[data-claude-marked]';
    const elements = document.querySelectorAll(selector);
    let cleared = 0;
    elements.forEach(el => {
      el.removeAttribute('data-claude-marked');
      el.removeAttribute('data-claude-mark-index');
      cleared++;
    });
    if (!label) {
      document.getElementById('claude-mark-styles')?.remove();
    }
    return { cleared, label: label || 'all' };
  }

  // ==========================================================================
  // Command Handlers - Receive commands from background script
  // ==========================================================================

  browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
    const { action, params } = message;

    // Skip messages that aren't commands for us
    if (!action) {
      return false;
    }

    // Handle command asynchronously
    handleCommand(action, params || {})
      .then(result => sendResponse(result))
      .catch(error => sendResponse({ error: error.message }));

    return true; // Keep channel open for async response
  });

  /**
   * Get cleaned page content with hidden/injected elements stripped.
   * Clones the DOM to avoid mutating the live page.
   */
  function getCleanedPageContent() {
    const clone = document.documentElement.cloneNode(true);

    // Remove script, style, noscript, stylesheet links
    clone.querySelectorAll('script, style, noscript, link[rel="stylesheet"]').forEach(el => el.remove());

    // Remove meta tags with content attribute (can carry hidden instructions)
    clone.querySelectorAll('meta[content]').forEach(el => el.remove());

    // Remove aria-hidden elements
    clone.querySelectorAll('[aria-hidden="true"]').forEach(el => el.remove());

    // Remove elements hidden via inline styles
    clone.querySelectorAll('*').forEach(el => {
      const style = el.getAttribute('style');
      if (style) {
        const lower = style.toLowerCase();
        if (
          lower.includes('display:none') || lower.includes('display: none') ||
          lower.includes('visibility:hidden') || lower.includes('visibility: hidden') ||
          /opacity\s*:\s*0(?:[;\s]|$)/.test(lower)
        ) {
          el.remove();
        }
      }
    });

    // Remove HTML comment nodes (recursive walk)
    const walker = document.createTreeWalker(clone, NodeFilter.SHOW_COMMENT, null, false);
    const comments = [];
    while (walker.nextNode()) {
      comments.push(walker.currentNode);
    }
    comments.forEach(c => c.parentNode && c.parentNode.removeChild(c));

    return clone.outerHTML;
  }

  async function handleCommand(action, params) {
    switch (action) {
      case 'ping':
        return { pong: true, frameId: getFrameId() };

      case 'get_dom':
      case 'get_page_content':
        return { html: getCleanedPageContent() };

      case 'get_page_text':
        return { text: document.body.innerText };

      case 'query_selector':
        return handleQuerySelector(params);

      case 'get_computed_styles':
        return handleGetComputedStyles(params);

      case 'get_element_properties':
        return handleGetElementProperties(params);

      case 'execute_script':
        return handleExecuteScript(params);

      case 'click_element':
        return handleClickElement(params);

      case 'type_text':
        return handleTypeText(params);

      case 'press_key':
        return handlePressKey(params);

      case 'scroll':
      case 'scroll_to':
        return handleScroll(params);

      case 'scroll_to_element':
        return handleScrollToElement(params);

      case 'hover_element':
        return handleHoverElement(params);

      case 'focus_element':
        return handleFocusElement(params);

      case 'select_option':
        return handleSelectOption(params);

      case 'set_checkbox':
        return handleSetCheckbox(params);

      case 'get_storage':
      case 'get_local_storage':
        return handleGetStorage({ type: 'local', ...params });

      case 'get_session_storage':
        return handleGetStorage({ type: 'session', ...params });

      case 'set_storage':
      case 'set_local_storage':
        return handleSetStorage({ type: 'local', ...params });

      case 'clear_storage':
        return handleClearStorage(params);

      case 'get_element_bounds':
        return handleGetElementBounds(params);

      case 'dom_stats':
        return handleDomStats(params);

      case 'get_dom_structure':
        return handleGetDomStructure(params);

      case 'wait_for_element':
        return handleWaitForElement(params);

      case 'fill_form':
        return handleFillForm(params);

      case 'list_frames':
        return handleListFrames(params);

      case 'update_setting':
        if ('captureLogSource' in params) {
          captureLogSource = params.captureLogSource;
          // Also update the page script
          window.postMessage({ type: '__claude_assistant_setting', captureLogSource: params.captureLogSource }, '*');
        }
        return { success: true };

      // User-driven selection mode
      case 'toggle_selection_mode':
        if (params.enable) {
          return enterSelectionMode();
        } else {
          return exitSelectionMode();
        }

      case 'get_user_selections':
        return getUserSelections(params);

      case 'clear_user_selections':
        return clearUserSelections();

      case 'mark_elements':
        return handleMarkElements(params);

      case 'get_marked_elements':
        return handleGetMarkedElements(params);

      case 'clear_marked_elements':
        return handleClearMarkedElements(params);

      // Clean text (remove excessive blank lines)
      case 'clean_text':
        return handleCleanText(params);

      // Region selection for screenshot
      case 'startRegionSelection':
        return startRegionSelection();

      // IndexedDB and Cache Storage
      case 'list_indexeddb':
        return await handleListIndexedDB(params);
      case 'clear_indexeddb':
        return await handleClearIndexedDB(params);
      case 'list_cache_storage':
        return await handleListCacheStorage(params);
      case 'clear_cache_storage':
        return await handleClearCacheStorage(params);

      // Accessibility tree & element discovery
      case 'get_accessibility_tree':
        return handleGetAccessibilityTree(params);

      case 'find_elements':
        return handleFindElements(params);

      // Fetch with session cookies
      case 'fetch_with_session':
        return await handleFetchWithSession(params);

      // File upload
      case 'upload_file':
        return handleUploadFile(params);

      // Dialog intercept
      case 'handle_dialog':
        return handleDialog(params);

      // Workflow recording
      case 'start_recording':
        return startWorkflowRecording();

      case 'stop_recording':
        return stopWorkflowRecording();

      default:
        throw new Error(`Unknown action: ${action}`);
    }
  }

  // ==========================================================================
  // Region Selection for Screenshot
  // ==========================================================================

  let regionSelecting = false;
  let regionOverlay = null;
  let regionBox = null;
  let regionStartX = 0;
  let regionStartY = 0;

  function startRegionSelection() {
    if (regionSelecting) return { error: 'Already in selection mode' };
    regionSelecting = true;

    // Inject overlay styles
    const styleEl = document.createElement('style');
    styleEl.id = 'foxhole-region-styles';
    styleEl.textContent = `
      #foxhole-region-overlay {
        position: fixed; top: 0; left: 0; width: 100%; height: 100%; z-index: 2147483647;
        cursor: crosshair; background: rgba(0,0,0,0.15);
      }
      #foxhole-region-box {
        position: fixed; border: 2px solid #C4A052; background: rgba(196,160,82,0.1);
        pointer-events: none; z-index: 2147483647; display: none;
      }
      #foxhole-region-instructions {
        position: fixed; top: 12px; left: 50%; transform: translateX(-50%);
        background: rgba(0,0,0,0.8); color: #fff; padding: 6px 14px; border-radius: 6px;
        font-size: 13px; z-index: 2147483647; pointer-events: none; white-space: nowrap;
      }
    `;
    document.head.appendChild(styleEl);

    regionOverlay = document.createElement('div');
    regionOverlay.id = 'foxhole-region-overlay';
    document.body.appendChild(regionOverlay);

    regionBox = document.createElement('div');
    regionBox.id = 'foxhole-region-box';
    document.body.appendChild(regionBox);

    const instructions = document.createElement('div');
    instructions.id = 'foxhole-region-instructions';
    instructions.textContent = 'Click and drag to select a region — Press Esc to cancel';
    document.body.appendChild(instructions);

    regionOverlay.addEventListener('mousedown', onRegionMouseDown);
    document.addEventListener('mousemove', onRegionMouseMove);
    document.addEventListener('mouseup', onRegionMouseUp);
    document.addEventListener('keydown', onRegionKeyDown);

    return { started: true };
  }

  function cleanupRegionSelection() {
    regionSelecting = false;
    regionStartX = 0;
    regionStartY = 0;
    document.getElementById('foxhole-region-styles')?.remove();
    document.getElementById('foxhole-region-overlay')?.remove();
    document.getElementById('foxhole-region-box')?.remove();
    document.getElementById('foxhole-region-instructions')?.remove();
    regionOverlay = null;
    regionBox = null;
    document.removeEventListener('mousemove', onRegionMouseMove);
    document.removeEventListener('mouseup', onRegionMouseUp);
    document.removeEventListener('keydown', onRegionKeyDown);
  }

  function onRegionMouseDown(e) {
    if (e.button !== 0) return;
    e.preventDefault();
    regionStartX = e.clientX;
    regionStartY = e.clientY;
    regionBox.style.display = 'block';
    regionBox.style.left = regionStartX + 'px';
    regionBox.style.top = regionStartY + 'px';
    regionBox.style.width = '0px';
    regionBox.style.height = '0px';
  }

  function onRegionMouseMove(e) {
    if (!regionStartX && !regionStartY) return;
    const x = Math.min(e.clientX, regionStartX);
    const y = Math.min(e.clientY, regionStartY);
    const w = Math.abs(e.clientX - regionStartX);
    const h = Math.abs(e.clientY - regionStartY);
    regionBox.style.left = x + 'px';
    regionBox.style.top = y + 'px';
    regionBox.style.width = w + 'px';
    regionBox.style.height = h + 'px';
  }

  function onRegionMouseUp(e) {
    if (e.button !== 0 || (!regionStartX && !regionStartY)) return;
    e.preventDefault();
    const x = Math.min(e.clientX, regionStartX);
    const y = Math.min(e.clientY, regionStartY);
    const w = Math.abs(e.clientX - regionStartX);
    const h = Math.abs(e.clientY - regionStartY);

    cleanupRegionSelection();

    if (w < 5 || h < 5) {
      browser.runtime.sendMessage({ type: 'regionSelected', cancelled: true }).catch(() => {});
      return;
    }

    const dpr = window.devicePixelRatio || 1;
    browser.runtime.sendMessage({
      type: 'regionSelected',
      bounds: {
        left: Math.round(x * dpr),
        top: Math.round(y * dpr),
        width: Math.round(w * dpr),
        height: Math.round(h * dpr)
      }
    }).catch(() => {});
  }

  function onRegionKeyDown(e) {
    if (e.key === 'Escape') {
      cleanupRegionSelection();
      browser.runtime.sendMessage({ type: 'regionSelected', cancelled: true }).catch(() => {});
    }
  }

  // ==========================================================================
  // Helper Functions
  // ==========================================================================

  function getFrameId() {
    // Return frame identification for iframe support
    if (window === window.top) {
      return 0; // Main frame
    }
    // For iframes, try to identify by name or index
    try {
      return window.name || 'iframe';
    } catch (e) {
      return 'iframe';
    }
  }

  function findElement(selector) {
    if (typeof selector === 'string' && selector.startsWith('tref_')) {
      const ref = _foxRefMap.get(selector);
      if (!ref) throw new Error(`Ref not found: ${selector}`);
      const el = ref.deref();
      if (el && el.isConnected) return el;

      // Element was disconnected (SPA re-render). Try to re-anchor by stable attrs.
      const meta = _foxRefMeta.get(selector);
      if (meta) {
        let reanchored = null;
        if (meta.testId) {
          reanchored = document.querySelector(`[data-testid="${meta.testId}"]`) ||
                       document.querySelector(`[data-test-id="${meta.testId}"]`);
        }
        if (!reanchored && meta.ariaLabel) {
          const escaped = meta.ariaLabel.replace(/"/g, '\\"');
          reanchored = document.querySelector(`${meta.tag}[aria-label="${escaped}"]`) ||
                       document.querySelector(`[aria-label="${escaped}"]`);
        }
        if (!reanchored && meta.id) {
          reanchored = document.getElementById(meta.id);
        }
        if (reanchored) {
          _foxRefMap.set(selector, new WeakRef(reanchored));
          _foxReverseMap.set(reanchored, selector);
          return reanchored;
        }
      }

      throw new Error(`Element no longer in DOM: ${selector}`);
    }
    const element = document.querySelector(selector);
    if (!element) {
      throw new Error(`Element not found: ${selector}`);
    }
    return element;
  }

  // ==========================================================================
  // DOM Query Handlers
  // ==========================================================================

  function handleQuerySelector(params) {
    const { selector, all } = params;

    if (all) {
      const elements = Array.from(document.querySelectorAll(selector));
      return {
        elements: elements.map((el, index) => ({
          index,
          tagName: el.tagName,
          id: el.id,
          className: el.className,
          textContent: el.textContent?.substring(0, 100)
        }))
      };
    } else {
      const element = document.querySelector(selector);
      if (!element) {
        return { found: false };
      }
      return {
        found: true,
        tagName: element.tagName,
        id: element.id,
        className: element.className,
        textContent: element.textContent?.substring(0, 200),
        innerHTML: element.innerHTML?.substring(0, 500)
      };
    }
  }

  function handleGetComputedStyles(params) {
    const { selector } = params;
    const element = findElement(selector);
    const styles = window.getComputedStyle(element);

    const styleObject = {};
    for (let prop of styles) {
      styleObject[prop] = styles.getPropertyValue(prop);
    }

    return { styles: styleObject };
  }

  function handleGetElementProperties(params) {
    const { selector, properties } = params;
    const element = findElement(selector);

    const result = {
      tagName: element.tagName,
      id: element.id,
      className: element.className,
      textContent: element.textContent?.substring(0, 200),
    };

    // If specific properties requested, get those too
    if (properties && Array.isArray(properties)) {
      for (const prop of properties) {
        if (prop in element) {
          const value = element[prop];
          // Handle different value types
          if (typeof value === 'function') {
            continue; // Skip methods
          } else if (value instanceof Element) {
            result[prop] = { tagName: value.tagName, id: value.id };
          } else if (typeof value === 'object' && value !== null) {
            try {
              result[prop] = JSON.stringify(value);
            } catch (e) {
              result[prop] = String(value);
            }
          } else {
            result[prop] = value;
          }
        }
      }
    }

    return { properties: result };
  }

  function handleGetElementBounds(params) {
    const { selector } = params;
    const element = findElement(selector);
    const rect = element.getBoundingClientRect();

    return {
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
      top: rect.top,
      right: rect.right,
      bottom: rect.bottom,
      left: rect.left
    };
  }

  // ==========================================================================
  // DOM Stats and Structure (from handlers.ts inline scripts)
  // ==========================================================================

  function handleDomStats(params) {
    const includeTags = params.includeTags || false;

    const all = document.querySelectorAll('*');
    let maxDepth = 0;
    const byTag = includeTags ? {} : null;

    all.forEach(el => {
      if (byTag) {
        byTag[el.tagName] = (byTag[el.tagName] || 0) + 1;
      }
      let depth = 0, node = el;
      while (node.parentElement) {
        depth++;
        node = node.parentElement;
      }
      if (depth > maxDepth) maxDepth = depth;
    });

    const result = {
      totalElements: all.length,
      maxDepth: maxDepth,
      htmlSize: document.documentElement.outerHTML.length,
      iframeCount: document.querySelectorAll('iframe').length,
      formCount: document.querySelectorAll('form').length,
      linkCount: document.querySelectorAll('a').length,
      imageCount: document.querySelectorAll('img').length
    };

    if (includeTags && byTag) {
      const sorted = Object.entries(byTag)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 15);
      result.topTags = Object.fromEntries(sorted);
    }

    return result;
  }

  function handleGetDomStructure(params) {
    const selector = params.selector || 'body';
    const maxDepth = params.depth ?? 2;

    // Detect raw content (JSON/text/XML viewed directly in browser)
    const body = document.body;
    if (selector === 'body' && body.children.length === 1 && body.children[0].tagName === 'PRE') {
      const content = body.textContent || '';
      const size = content.length;
      let contentType = 'text';

      // Detect JSON
      const trimmed = content.trim();
      if ((trimmed.startsWith('{') && trimmed.endsWith('}')) ||
          (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
        try {
          JSON.parse(trimmed);
          contentType = 'json';
        } catch {}
      }
      // Detect XML
      else if (trimmed.startsWith('<?xml') || (trimmed.startsWith('<') && trimmed.includes('</'))) {
        contentType = 'xml';
      }

      return {
        raw_content: true,
        contentType: contentType,
        size: size,
        preview: content.slice(0, 500) + (size > 500 ? '...' : ''),
        hint: 'Use get_page_content for full payload'
      };
    }

    // Attributes to include in output
    const showAttrs = ['id', 'class', 'role', 'data-testid', 'type', 'name', 'href', 'src'];

    function getAttrsString(el) {
      let attrs = '';
      for (const attr of showAttrs) {
        let val = el.getAttribute(attr);
        if (val) {
          // Truncate long class lists
          if (attr === 'class' && val.length > 60) {
            val = val.slice(0, 57) + '...';
          }
          // Truncate long hrefs/srcs
          if ((attr === 'href' || attr === 'src') && val.length > 80) {
            val = val.slice(0, 77) + '...';
          }
          attrs += ' ' + attr + '="' + val.replace(/"/g, '&quot;') + '"';
        }
      }
      return attrs;
    }

    function summarize(node, depth, indent) {
      // Skip non-element nodes at top level of output
      if (node.nodeType !== 1) return null;

      const el = node;
      const tag = el.tagName.toLowerCase();
      const attrs = getAttrsString(el);
      const spaces = '  '.repeat(indent);

      // Count direct element children
      const elementChildren = Array.from(el.children);
      const childCount = elementChildren.length;

      // Get direct text content (not from descendants)
      let directText = '';
      for (const child of el.childNodes) {
        if (child.nodeType === 3) { // TEXT_NODE
          directText += child.textContent;
        }
      }
      directText = directText.trim();

      // Void elements (self-closing)
      const voidTags = ['area','base','br','col','embed','hr','img','input','link','meta','source','track','wbr'];
      if (voidTags.includes(tag)) {
        return spaces + '<' + tag + attrs + '/>';
      }

      // At max depth - summarize children
      if (depth >= maxDepth) {
        if (childCount > 0) {
          return spaces + '<' + tag + attrs + '><!-- ' + childCount + ' children --></' + tag + '>';
        } else if (directText.length > 0) {
          const preview = directText.length > 60 ? directText.slice(0, 57) + '...' : directText;
          return spaces + '<' + tag + attrs + '>' + preview + '</' + tag + '>';
        } else {
          return spaces + '<' + tag + attrs + '></' + tag + '>';
        }
      }

      // Recurse into children
      const childResults = [];
      for (const child of elementChildren) {
        const result = summarize(child, depth + 1, indent + 1);
        if (result) childResults.push(result);
      }

      // Build output
      if (childResults.length === 0) {
        // No element children - show text if any
        if (directText.length > 0) {
          const preview = directText.length > 60 ? directText.slice(0, 57) + '...' : directText;
          return spaces + '<' + tag + attrs + '>' + preview + '</' + tag + '>';
        }
        return spaces + '<' + tag + attrs + '></' + tag + '>';
      }

      return spaces + '<' + tag + attrs + '>\n' + childResults.join('\n') + '\n' + spaces + '</' + tag + '>';
    }

    const root = document.querySelector(selector);
    if (!root) {
      return { error: 'Selector not found', selector: selector };
    }

    return {
      structure: summarize(root, 0, 0),
      selector: selector,
      depth: maxDepth
    };
  }

  // ==========================================================================
  // Script Execution
  // ==========================================================================

  async function handleExecuteScript(params) {
    const { script, code, preview, force } = params;
    const scriptCode = script || code; // Support both 'script' and 'code' parameter names
    const PAYLOAD_LIMIT = 50000; // 50KB threshold

    if (!scriptCode) {
      return { error: 'No script/code provided' };
    }

    let result;
    try {
      result = eval(scriptCode);
      // Handle promises returned from evaluated scripts
      if (result && typeof result.then === 'function') {
        result = await result;
      }
    } catch (evalError) {
      return {
        error: 'Script execution failed',
        message: evalError.message,
        name: evalError.name
      };
    }

    // Check payload size
    let serialized;
    try {
      serialized = JSON.stringify(result);
    } catch (e) {
      serialized = String(result);
    }

    const payloadSize = serialized.length;

    // If payload exceeds limit and not forced/preview
    if (payloadSize > PAYLOAD_LIMIT && !preview && !force) {
      return {
        error: 'payload_too_large',
        size: payloadSize,
        sizeFormatted: (payloadSize / 1024).toFixed(1) + 'KB',
        limit: PAYLOAD_LIMIT,
        limitFormatted: (PAYLOAD_LIMIT / 1024).toFixed(0) + 'KB',
        message: `Result exceeds ${(PAYLOAD_LIMIT / 1024).toFixed(0)}KB (actual: ${(payloadSize / 1024).toFixed(1)}KB). Options: 1) Rewrite JS to filter/limit results, 2) Use preview:true for first ${(PAYLOAD_LIMIT / 1024).toFixed(0)}KB sample, 3) Use force:true to get full payload.`
      };
    }

    // Preview mode - return truncated sample
    if (preview && payloadSize > PAYLOAD_LIMIT) {
      return {
        preview: true,
        sample: serialized.slice(0, PAYLOAD_LIMIT),
        truncatedAt: PAYLOAD_LIMIT,
        totalSize: payloadSize,
        totalSizeFormatted: (payloadSize / 1024).toFixed(1) + 'KB',
        message: `Showing first ${(PAYLOAD_LIMIT / 1024).toFixed(0)}KB of ${(payloadSize / 1024).toFixed(1)}KB. Use force:true for full payload or rewrite JS for targeted extraction.`
      };
    }

    return { result };
  }

  // ==========================================================================
  // Element Interaction Handlers
  // ==========================================================================

  function handleClickElement(params) {
    const { selector, force } = params;
    const element = findElement(selector);
    element.scrollIntoView({ block: 'nearest' });

    if (force) {
      // Full pointer/mouse sequence for widgets that gate on pointer events
      // (custom dropdowns, drag handles, canvas UIs). Plain .click() suffices
      // for React onClick (delegated at root) but not for these.
      for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
        element.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
      }
      element.focus?.();
    } else {
      element.click();
    }

    return { success: true, clicked: true, selector };
  }

  function handleTypeText(params) {
    const { selector, text, append } = params;
    const element = findElement(selector);

    element.focus();

    // contentEditable elements (Draft.js, ProseMirror, Tiptap, etc.)
    if (element.isContentEditable) {
      if (!append) {
        document.execCommand('selectAll', false, null);
      }
      document.execCommand('insertText', false, text);
      fireChangeEvents(element);
      return { success: true, typed: true, selector, replaced: !append };
    }

    // Standard input/textarea — use native prototype setter so React/Vue detect the change.
    // Setting element.value directly bypasses framework property overrides and
    // onChange never fires.
    const newValue = append ? (element.value + text) : text;
    setNativeValue(element, newValue);
    fireChangeEvents(element);

    return { success: true, typed: true, selector, replaced: !append };
  }

  function handlePressKey(params) {
    const { selector, key, ctrlKey, shiftKey, altKey, metaKey } = params;
    const element = selector ? findElement(selector) : document.activeElement;

    const eventOptions = {
      key,
      code: key,
      ctrlKey: ctrlKey || false,
      shiftKey: shiftKey || false,
      altKey: altKey || false,
      metaKey: metaKey || false,
      bubbles: true,
      cancelable: true
    };

    element.dispatchEvent(new KeyboardEvent('keydown', eventOptions));
    element.dispatchEvent(new KeyboardEvent('keypress', eventOptions));
    element.dispatchEvent(new KeyboardEvent('keyup', eventOptions));

    return { success: true };
  }

  function handleScroll(params) {
    const { x, y, selector } = params;

    // If selector provided, scroll to element
    if (selector) {
      return handleScrollToElement({ selector, behavior: params.behavior });
    }

    window.scrollTo(x || 0, y || 0);
    return { success: true, scrolled: true };
  }

  function handleScrollToElement(params) {
    const { selector, behavior } = params;
    const element = findElement(selector);
    element.scrollIntoView({ behavior: behavior || 'smooth', block: 'center' });
    return { success: true, scrolled: true, selector };
  }

  function handleHoverElement(params) {
    const { selector } = params;
    const element = findElement(selector);

    const rect = element.getBoundingClientRect();
    const eventOptions = {
      bubbles: true,
      cancelable: true,
      clientX: rect.left + rect.width / 2,
      clientY: rect.top + rect.height / 2
    };

    element.dispatchEvent(new MouseEvent('mouseover', eventOptions));
    element.dispatchEvent(new MouseEvent('mouseenter', eventOptions));

    return { success: true };
  }

  function handleFocusElement(params) {
    const { selector } = params;
    const element = findElement(selector);
    element.focus();
    return { success: true };
  }

  function handleSelectOption(params) {
    const { selector, value, index, text } = params;
    const element = findElement(selector);

    if (element.tagName !== 'SELECT') {
      throw new Error('Element is not a SELECT element');
    }

    let selectedOption = null;

    if (value !== undefined) {
      element.value = value;
      selectedOption = { by: 'value', value };
    } else if (text !== undefined) {
      // Find option by visible text
      const options = Array.from(element.options);
      const option = options.find(opt => opt.textContent.trim() === text);
      if (!option) {
        throw new Error(`Option with text "${text}" not found`);
      }
      element.value = option.value;
      selectedOption = { by: 'text', text, value: option.value };
    } else if (index !== undefined) {
      element.selectedIndex = index;
      selectedOption = { by: 'index', index };
    }

    element.dispatchEvent(new Event('change', { bubbles: true }));
    return { success: true, selected: selectedOption };
  }

  function handleSetCheckbox(params) {
    const { selector, checked } = params;
    const element = findElement(selector);

    if (element.type !== 'checkbox' && element.type !== 'radio') {
      throw new Error('Element is not a checkbox or radio button');
    }

    element.checked = checked;
    element.dispatchEvent(new Event('change', { bubbles: true }));
    return { success: true };
  }

  function handleFillForm(params) {
    const { fields } = params;

    if (!fields || typeof fields !== 'object') {
      throw new Error('fields parameter required');
    }

    const results = [];
    for (const [selector, value] of Object.entries(fields)) {
      try {
        const element = findElement(selector);
        element.value = value;
        element.dispatchEvent(new Event('input', { bubbles: true }));
        element.dispatchEvent(new Event('change', { bubbles: true }));
        results.push({ selector, success: true });
      } catch (e) {
        results.push({ selector, success: false, error: e.message });
      }
    }

    return { success: true, filled: true, fieldCount: Object.keys(fields).length, results };
  }

  // ==========================================================================
  // Clean Text Handler
  // ==========================================================================

  /**
   * Set value on a textarea/input using the native prototype setter.
   * This bypasses React/Vue/Angular property overrides so the framework
   * sees the change and syncs it to state (and ultimately to the server).
   */
  function setNativeValue(el, value) {
    const proto = el.tagName === 'TEXTAREA'
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
    const nativeSetter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (nativeSetter) {
      nativeSetter.call(el, value);
    } else {
      el.value = value;
    }
  }

  /**
   * Fire the full sequence of events that frameworks and autosave handlers
   * listen for: InputEvent (with inputType for modern handlers), then
   * change, then blur+focus to trigger on-blur save hooks without
   * actually losing focus visually.
   */
  function fireChangeEvents(el) {
    // InputEvent with inputType — React 17+, modern frameworks
    el.dispatchEvent(new InputEvent('input', {
      bubbles: true,
      cancelable: true,
      inputType: 'insertFromPaste' // closest semantic for bulk text replacement
    }));
    // change — classic HTML forms, jQuery, Angular.js
    el.dispatchEvent(new Event('change', { bubbles: true }));
    // blur+focus cycle — triggers onBlur autosave (Notion, Confluence, etc.)
    el.dispatchEvent(new Event('blur', { bubbles: true }));
    el.dispatchEvent(new Event('focus', { bubbles: true }));
  }

  function handleCleanText() {
    const el = document.activeElement;
    if (!el) {
      return { success: false, error: 'No focused element' };
    }

    // Handle <textarea> and <input> elements
    if (el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && el.type === 'text')) {
      const start = el.selectionStart;
      const end = el.selectionEnd;
      const hasSelection = start !== end;

      let original, cleaned, newValue;
      if (hasSelection) {
        original = el.value.substring(start, end);
        cleaned = original.replace(/\n{3,}/g, '\n\n');
        newValue = el.value.substring(0, start) + cleaned + el.value.substring(end);
      } else {
        original = el.value;
        cleaned = original.replace(/\n{3,}/g, '\n\n');
        newValue = cleaned;
      }

      if (original === cleaned) {
        return { success: true, cleaned: false, linesRemoved: 0 };
      }

      // Use native setter so React/Vue detect the change
      setNativeValue(el, newValue);

      // Restore cursor / selection
      if (hasSelection) {
        el.selectionStart = start;
        el.selectionEnd = start + cleaned.length;
      }

      fireChangeEvents(el);

      const linesRemoved = original.length - cleaned.length;
      return { success: true, cleaned: true, linesRemoved };
    }

    // Handle contentEditable elements (Gmail, Notion, Confluence, etc.)
    if (el.isContentEditable) {
      const selection = window.getSelection();
      const hasSelection = selection && selection.toString().length > 0;

      if (hasSelection) {
        const selectedText = selection.toString();
        const cleaned = selectedText.replace(/\n{3,}/g, '\n\n');
        if (selectedText === cleaned) {
          return { success: true, cleaned: false, linesRemoved: 0 };
        }
        // Use execCommand so the edit enters the undo stack and
        // rich-text editors (Draft.js, ProseMirror, Tiptap) pick it up
        document.execCommand('insertText', false, cleaned);
        fireChangeEvents(el);
        const linesRemoved = selectedText.length - cleaned.length;
        return { success: true, cleaned: true, linesRemoved };
      }

      // No selection — select all content, then replace
      const original = el.innerText;
      const cleaned = original.replace(/\n{3,}/g, '\n\n');
      if (original === cleaned) {
        return { success: true, cleaned: false, linesRemoved: 0 };
      }

      // Select all content in the editable, then replace via execCommand
      const range = document.createRange();
      range.selectNodeContents(el);
      selection.removeAllRanges();
      selection.addRange(range);
      document.execCommand('insertText', false, cleaned);
      fireChangeEvents(el);

      const linesRemoved = original.length - cleaned.length;
      return { success: true, cleaned: true, linesRemoved };
    }

    return { success: false, error: 'Focused element is not a text input or contentEditable' };
  }

  // ==========================================================================
  // Accessibility Tree
  // ==========================================================================

  function getA11yRole(el) {
    const explicit = el.getAttribute('role');
    if (explicit) return explicit;
    const map = {
      A: 'link', BUTTON: 'button', INPUT: 'textbox', SELECT: 'combobox',
      TEXTAREA: 'textbox', H1: 'heading', H2: 'heading', H3: 'heading',
      H4: 'heading', H5: 'heading', H6: 'heading', IMG: 'image',
      NAV: 'navigation', MAIN: 'main', HEADER: 'banner', FOOTER: 'contentinfo',
      ASIDE: 'complementary', FORM: 'form', TABLE: 'table',
      UL: 'list', OL: 'list', LI: 'listitem', ARTICLE: 'article',
      SECTION: 'region', LABEL: 'label'
    };
    return map[el.tagName] || 'generic';
  }

  function getA11yLabel(el) {
    if (el.getAttribute('aria-label')) return el.getAttribute('aria-label');
    if (el.getAttribute('placeholder')) return el.getAttribute('placeholder');
    if (el.getAttribute('title')) return el.getAttribute('title');
    if (el.getAttribute('alt')) return el.getAttribute('alt');
    if (el.id) {
      try {
        const lbl = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
        if (lbl) return lbl.textContent.trim().slice(0, 80);
      } catch (_) {}
    }
    const wrappingLabel = el.closest('label');
    if (wrappingLabel) {
      const t = [...wrappingLabel.childNodes]
        .filter(n => n.nodeType === 3).map(n => n.textContent.trim()).filter(Boolean).join(' ');
      if (t) return t.slice(0, 80);
    }
    const prev = el.previousElementSibling;
    if (prev && prev.tagName === 'LABEL') return prev.textContent.trim().slice(0, 80);
    const parentTd = el.parentElement;
    if (parentTd && parentTd.tagName === 'TD') {
      const prevTd = parentTd.previousElementSibling;
      if (prevTd) return prevTd.textContent.trim().slice(0, 80);
    }
    const text = el.textContent?.trim();
    if (text) return text.slice(0, 100);
    return '';
  }

  function isA11yVisible(el) {
    const s = getComputedStyle(el);
    return s.display !== 'none' && s.visibility !== 'hidden' &&
      s.opacity !== '0' && el.offsetWidth > 0 && el.offsetHeight > 0;
  }

  function isA11yInteractive(el) {
    if (['A', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'DETAILS', 'SUMMARY'].includes(el.tagName)) return true;
    if (el.getAttribute('onclick') || el.getAttribute('tabindex')) return true;
    const r = el.getAttribute('role');
    if (['button', 'link', 'checkbox', 'radio', 'combobox', 'menuitem', 'option', 'tab'].includes(r)) return true;
    if (el.getAttribute('contenteditable') === 'true') return true;
    return false;
  }

  const A11Y_SEMANTIC_TAGS = new Set(['H1','H2','H3','H4','H5','H6','NAV','MAIN','HEADER','FOOTER','SECTION','ARTICLE','ASIDE']);
  const A11Y_SKIP_TAGS = new Set(['SCRIPT','STYLE','META','LINK','TITLE','NOSCRIPT','SVG','PATH']);

  function handleGetAccessibilityTree(params) {
    const { filter, depth = 15, charLimit, selector } = params || {};
    const root = selector ? document.querySelector(selector) : document.body;
    if (!root) return { error: `Root element not found: ${selector}` };

    const lines = [];
    let charCount = 0;

    function traverse(el, indent) {
      if (charLimit && charCount >= charLimit) return;
      if (A11Y_SKIP_TAGS.has(el.tagName)) return;
      if (el.getAttribute('aria-hidden') === 'true' && filter !== 'all') return;
      if (!isA11yVisible(el) && filter !== 'all') return;

      const interactive = isA11yInteractive(el);
      const semantic = A11Y_SEMANTIC_TAGS.has(el.tagName);
      const hasDirectText = el.childNodes.length === 1 && el.firstChild?.nodeType === 3 &&
        (el.firstChild.textContent.trim().length > 0);

      const include = filter === 'interactive' ? interactive
        : filter === 'all' ? true
        : (interactive || semantic || hasDirectText);

      if (include) {
        const role = getA11yRole(el);
        const label = getA11yLabel(el);
        const refId = registerElement(el);
        const attrs = [];
        if (el.tagName === 'A' && el.href) attrs.push(`href="${el.href.replace(location.origin, '')}"`);
        if (el.tagName === 'INPUT') attrs.push(`type="${el.type}"`);
        if (el.placeholder) attrs.push(`placeholder="${el.placeholder}"`);
        if (el.value && el.tagName === 'INPUT' && el.type !== 'password') attrs.push(`value="${el.value.slice(0, 50)}"`);

        const line = `${'  '.repeat(indent)}${role} "${label.slice(0, 80)}" [${refId}]${attrs.length ? ' ' + attrs.join(' ') : ''}`;
        lines.push(line);
        charCount += line.length;
      }

      if (indent < depth) {
        for (const child of el.children) {
          traverse(child, indent + (include ? 1 : 0));
        }
      }
    }

    traverse(root, 0);
    return {
      tree: lines.join('\n'),
      elementCount: lines.length,
      registeredRefs: _foxRefCounter,
      viewport: { width: window.innerWidth, height: window.innerHeight }
    };
  }

  // ==========================================================================
  // Find Elements (natural language search)
  // ==========================================================================

  function handleFindElements(params) {
    const { description = '', maxResults = 5, filter = 'interactive' } = params;
    const tokens = description.toLowerCase().split(/\s+/).filter(t => t.length > 1);

    const SKIP = new Set(['SCRIPT', 'STYLE', 'META', 'LINK', 'NOSCRIPT', 'HEAD', 'TITLE', 'SVG', 'PATH']);
    const INTERACTIVE_TAGS = new Set(['A', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'DETAILS', 'SUMMARY']);

    function isInteractiveEl(el) {
      if (INTERACTIVE_TAGS.has(el.tagName)) return true;
      const role = el.getAttribute('role');
      if (['button', 'link', 'checkbox', 'radio', 'combobox', 'menuitem', 'option', 'tab'].includes(role)) return true;
      if (el.getAttribute('onclick') !== null || el.getAttribute('tabindex') !== null) return true;
      if (el.getAttribute('contenteditable') === 'true') return true;
      return false;
    }

    function collectText(el) {
      const parts = [];
      ['aria-label', 'placeholder', 'title', 'alt', 'data-testid', 'name', 'id'].forEach(a => {
        const v = el.getAttribute(a);
        if (v) parts.push(v);
      });
      const wrappingLabel = el.closest('label');
      if (wrappingLabel) {
        const t = [...wrappingLabel.childNodes]
          .filter(n => n.nodeType === 3).map(n => n.textContent.trim()).filter(Boolean).join(' ');
        if (t) parts.push(t);
      }
      const prev = el.previousElementSibling;
      if (prev && prev.tagName === 'LABEL') parts.push(prev.textContent.trim());
      const txt = (el.textContent || '').trim();
      if (txt.length <= 200) parts.push(txt);
      parts.push(getA11yRole(el));
      parts.push(el.tagName.toLowerCase());
      return parts.join(' ').toLowerCase();
    }

    function scoreText(text) {
      if (!tokens.length) return 0;
      const hits = tokens.filter(t => text.includes(t)).length;
      const phraseBonus = text.includes(description.toLowerCase()) ? 0.25 : 0;
      return Math.min(1, hits / tokens.length + phraseBonus);
    }

    const candidates = [];
    for (const el of document.querySelectorAll('*')) {
      if (SKIP.has(el.tagName)) continue;
      const s = getComputedStyle(el);
      if (s.display === 'none' || s.visibility === 'hidden') continue;
      const interactive = isInteractiveEl(el);
      if (filter === 'interactive' && !interactive) continue;
      const score = scoreText(collectText(el));
      if (score > 0) candidates.push({ el, score, interactive });
    }

    candidates.sort((a, b) => {
      if (a.interactive !== b.interactive) return b.interactive ? 1 : -1;
      return b.score - a.score;
    });

    const matches = candidates.slice(0, maxResults).map(c => {
      const refId = registerElement(c.el);
      const rect = c.el.getBoundingClientRect();
      return {
        refId,
        score: Math.round(c.score * 100) / 100,
        role: getA11yRole(c.el),
        label: getA11yLabel(c.el).slice(0, 80),
        tag: c.el.tagName.toLowerCase(),
        interactive: c.interactive,
        rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
      };
    });

    return { matches, description, totalCandidates: candidates.length };
  }

  // ==========================================================================
  // Fetch With Session Cookies
  // ==========================================================================

  async function handleFetchWithSession(params) {
    const { url, method = 'GET', headers = {}, body = null, timeout = 30000, maxBodySize = 50000 } = params;
    const BODY_LIMIT = Math.min(maxBodySize, 200000);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);

    try {
      const init = { method, headers, credentials: 'include', signal: controller.signal };
      if (body !== null && method !== 'GET' && method !== 'HEAD') {
        init.body = typeof body === 'string' ? body : JSON.stringify(body);
      }
      const resp = await fetch(url, init);
      clearTimeout(timer);

      const responseHeaders = {};
      resp.headers.forEach((v, k) => { responseHeaders[k] = v; });
      const text = await resp.text();
      const truncated = text.length > BODY_LIMIT;
      const sample = truncated ? text.slice(0, BODY_LIMIT) : text;
      const contentType = resp.headers.get('content-type') || '';
      let responseBody = sample;
      if (contentType.includes('application/json')) {
        try { responseBody = JSON.parse(sample); } catch (_) {}
      }
      return {
        status: resp.status,
        statusText: resp.statusText,
        ok: resp.ok,
        url: resp.url,
        headers: responseHeaders,
        body: responseBody,
        truncated,
        totalBodySize: text.length
      };
    } catch (e) {
      clearTimeout(timer);
      return { error: e.name === 'AbortError' ? `Request timed out after ${timeout}ms` : e.message };
    }
  }

  // ==========================================================================
  // File Upload
  // ==========================================================================

  function handleUploadFile(params) {
    const { selector, filename, content, mimeType = '', encoding = 'text' } = params;
    const el = findElement(selector);

    if (el.tagName !== 'INPUT' || el.type !== 'file') {
      throw new Error(`Element is not a file input (got <${el.tagName.toLowerCase()} type="${el.type}">): ${selector}`);
    }

    let bytes;
    if (encoding === 'base64') {
      const binary = atob(content);
      bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    } else {
      bytes = new TextEncoder().encode(content);
    }

    const file = new File([bytes], filename, { type: mimeType || '' });
    const dt = new DataTransfer();
    dt.items.add(file);

    try {
      el.files = dt.files;
    } catch (e) {
      throw new Error(`Could not set files on input: ${e.message}`);
    }

    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new Event('input', { bubbles: true }));

    return { uploaded: true, filename: file.name, size: file.size, type: file.type };
  }

  // ==========================================================================
  // Dialog Handling
  // ==========================================================================

  function handleDialog(params) {
    const { accept = true, promptText = '', drain = false } = params || {};

    window.__foxholeDialogLog = window.__foxholeDialogLog || [];

    if (drain) {
      const logged = window.__foxholeDialogLog.splice(0);
      return { drained: true, dialogs: logged };
    }

    if (!window.__foxholeDialogOriginals) {
      window.__foxholeDialogOriginals = {
        alert: window.alert,
        confirm: window.confirm,
        prompt: window.prompt,
      };
    }

    window.alert = function(msg) {
      window.__foxholeDialogLog.push({ type: 'alert', message: String(msg ?? ''), at: Date.now() });
    };
    window.confirm = function(msg) {
      window.__foxholeDialogLog.push({ type: 'confirm', message: String(msg ?? ''), result: accept, at: Date.now() });
      return accept;
    };
    window.prompt = function(msg, defaultValue) {
      const result = accept ? (promptText || defaultValue || '') : null;
      window.__foxholeDialogLog.push({ type: 'prompt', message: String(msg ?? ''), defaultValue, result, at: Date.now() });
      return result;
    };

    const pending = window.__foxholeDialogLog.splice(0);
    return { installed: true, accept, promptText, pendingDialogs: pending };
  }

  // ==========================================================================
  // IndexedDB Handlers
  // ==========================================================================

  async function handleListIndexedDB() {
    try {
      // indexedDB.databases() is available in Firefox 126+
      if (typeof indexedDB.databases === 'function') {
        const dbs = await indexedDB.databases();
        return {
          databases: dbs.map(db => ({ name: db.name, version: db.version }))
        };
      }
      // Fallback: can't enumerate without databases() API
      return {
        databases: [],
        note: 'indexedDB.databases() not available in this Firefox version (requires 126+). Use execute_script to probe specific database names.'
      };
    } catch (e) {
      return { error: e.message };
    }
  }

  async function handleClearIndexedDB(params) {
    const { name } = params;
    const deleted = [];

    try {
      if (name) {
        // Delete a specific database
        await new Promise((resolve, reject) => {
          const req = indexedDB.deleteDatabase(name);
          req.onsuccess = () => resolve();
          req.onerror = () => reject(new Error(`Failed to delete database: ${name}`));
          req.onblocked = () => resolve(); // Still counts as deleted
        });
        deleted.push(name);
      } else {
        // Delete all databases
        if (typeof indexedDB.databases !== 'function') {
          return { error: 'indexedDB.databases() not available. Provide a specific database name to delete.' };
        }
        const dbs = await indexedDB.databases();
        for (const db of dbs) {
          try {
            await new Promise((resolve, reject) => {
              const req = indexedDB.deleteDatabase(db.name);
              req.onsuccess = () => resolve();
              req.onerror = () => reject(new Error(`Failed to delete: ${db.name}`));
              req.onblocked = () => resolve();
            });
            deleted.push(db.name);
          } catch (e) {
            // Continue deleting others even if one fails
            console.warn(`[ClearIndexedDB] Failed to delete ${db.name}:`, e);
          }
        }
      }
      return { deleted };
    } catch (e) {
      return { error: e.message, deleted };
    }
  }

  // ==========================================================================
  // Cache Storage Handlers
  // ==========================================================================

  async function handleListCacheStorage() {
    try {
      if (!('caches' in window)) {
        return { caches: [], note: 'Cache Storage API not available on this page' };
      }
      const names = await caches.keys();
      return { caches: names };
    } catch (e) {
      return { error: e.message };
    }
  }

  async function handleClearCacheStorage(params) {
    const { name } = params;
    const deleted = [];

    try {
      if (!('caches' in window)) {
        return { error: 'Cache Storage API not available on this page' };
      }

      if (name) {
        const result = await caches.delete(name);
        if (result) deleted.push(name);
        else return { error: `Cache "${name}" not found` };
      } else {
        const names = await caches.keys();
        for (const cacheName of names) {
          const result = await caches.delete(cacheName);
          if (result) deleted.push(cacheName);
        }
      }
      return { deleted };
    } catch (e) {
      return { error: e.message, deleted };
    }
  }

  // ==========================================================================
  // Storage Handlers
  // ==========================================================================

  function handleGetStorage(params) {
    const { type } = params;
    const storage = type === 'session' ? sessionStorage : localStorage;

    const data = {};
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i);
      data[key] = storage.getItem(key);
    }

    return { data };
  }

  function handleSetStorage(params) {
    const { type, key, value } = params;
    const storage = type === 'session' ? sessionStorage : localStorage;
    storage.setItem(key, value);
    return { success: true };
  }

  function handleClearStorage(params) {
    const { type = 'both' } = params;
    if (type === 'both') {
      localStorage.clear();
      sessionStorage.clear();
    } else if (type === 'session') {
      sessionStorage.clear();
    } else {
      localStorage.clear();
    }
    return { success: true, cleared: type };
  }

  // ==========================================================================
  // Wait Handlers
  // ==========================================================================

  function handleWaitForElement(params) {
    const { selector, timeout = 5000 } = params;

    return new Promise((resolve, reject) => {
      const startTime = Date.now();

      const check = () => {
        const el = document.querySelector(selector);
        if (el) {
          resolve({
            found: true,
            selector,
            tagName: el.tagName,
            id: el.id,
            className: el.className
          });
        } else if (Date.now() - startTime > timeout) {
          reject(new Error('Timeout waiting for element: ' + selector));
        } else {
          setTimeout(check, 100);
        }
      };

      check();
    });
  }

  function handleListFrames() {
    const frames = [];

    // Add main frame
    frames.push({
      frameId: 0,
      url: window.location.href,
      name: window.name || '(top)',
      isTop: true
    });

    // Find all iframes
    const iframes = document.querySelectorAll('iframe');
    iframes.forEach((iframe, index) => {
      let url = 'about:blank';
      try {
        url = iframe.src || iframe.contentWindow?.location?.href || 'about:blank';
      } catch (e) {
        // Cross-origin iframe - can't access location
        url = iframe.src || '(cross-origin)';
      }

      frames.push({
        frameId: index + 1,
        url,
        name: iframe.name || iframe.id || `iframe-${index}`,
        isTop: false,
        selector: iframe.id ? `#${iframe.id}` : (iframe.name ? `iframe[name="${iframe.name}"]` : `iframe:nth-of-type(${index + 1})`)
      });
    });

    return { frames, count: frames.length };
  }

  // ==========================================================================
  // Workflow Recording
  // ==========================================================================

  function getBestRecordingSelector(el) {
    const testId = el.dataset.testid || el.dataset.testId;
    if (testId) return `[data-testid="${testId}"]`;
    const ariaLabel = el.getAttribute('aria-label');
    if (ariaLabel) return `[aria-label="${ariaLabel.replace(/"/g, '\\"')}"]`;
    if (el.id && /^[a-zA-Z_-]/.test(el.id)) return `#${el.id}`;
    const role = el.getAttribute('role');
    if (role && el.textContent?.trim()) return `[role="${role}"]`;
    const parts = [];
    let node = el;
    for (let i = 0; i < 3 && node && node !== document.body; i++) {
      let sel = node.tagName.toLowerCase();
      const parent = node.parentElement;
      if (parent) {
        const siblings = Array.from(parent.children).filter(c => c.tagName === node.tagName);
        if (siblings.length > 1) sel += `:nth-of-type(${siblings.indexOf(node) + 1})`;
      }
      parts.unshift(sel);
      node = node.parentElement;
    }
    return parts.join(' > ');
  }

  function sendRecordingStep(step) {
    browser.runtime.sendMessage({ type: 'RECORDING_STEP', step }).catch(() => {});
  }

  function _onRecordClick(e) {
    const el = e.target.closest('a, button, [role="button"], input[type="submit"], input[type="button"], input[type="checkbox"], input[type="radio"], summary') || e.target;
    if (el.tagName === 'INPUT' && /^(text|email|password|search|tel|url|number|)$/.test(el.type || '')) return;
    if (el.tagName === 'TEXTAREA') return;
    if (el.closest('[id^="foxhole"]')) return;
    const selector = getBestRecordingSelector(el);
    const label = el.textContent?.trim().replace(/\s+/g, ' ').slice(0, 50) || el.getAttribute('aria-label') || selector;
    sendRecordingStep({ tool: 'click_element', input: { selector }, _label: `Click "${label}"` });
  }

  function _onRecordBlur(e) {
    const el = e.target;
    if (el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && /^(text|email|password|search|tel|url|number|)$/.test(el.type || ''))) {
      if (!el.value) return;
      const selector = getBestRecordingSelector(el);
      sendRecordingStep({
        tool: 'type_text',
        input: { selector, text: el.value, clearFirst: true },
        _label: `Type "${el.value.slice(0, 40)}${el.value.length > 40 ? '...' : ''}" into ${selector}`
      });
    }
  }

  function _onRecordChange(e) {
    const el = e.target;
    if (el.tagName === 'SELECT') {
      const selector = getBestRecordingSelector(el);
      const optText = el.options[el.selectedIndex]?.text || el.value;
      sendRecordingStep({ tool: 'select_option', input: { selector, value: el.value }, _label: `Select "${optText}" in ${selector}` });
    }
  }

  function startWorkflowRecording() {
    if (_recordingActive) return { ok: true, message: 'Already recording' };
    _recordingActive = true;
    document.addEventListener('click', _onRecordClick, true);
    document.addEventListener('blur', _onRecordBlur, true);
    document.addEventListener('change', _onRecordChange, true);
    return { ok: true };
  }

  function stopWorkflowRecording() {
    _recordingActive = false;
    document.removeEventListener('click', _onRecordClick, true);
    document.removeEventListener('blur', _onRecordBlur, true);
    document.removeEventListener('change', _onRecordChange, true);
    return { ok: true };
  }

  // ==========================================================================
  // Initialization
  // ==========================================================================

  // Notify background script that content script is ready
  browser.runtime.sendMessage({ type: 'content_script_ready' }).catch(() => {
    // Ignore errors if background script isn't ready yet
  });

  debugLog('INFO', '[Claude Assistant] Content script initialized');
})();
