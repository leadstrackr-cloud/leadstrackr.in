(function () {
  'use strict';

  // Configuration
  const CONFIG = {
    API_BASE: 'https://app.leadstrackr.com/api/projects',
    MAX_RETRIES: 2, // Reduced from 3 for faster failure
    RETRY_DELAY: 800, // Reduced from 1000ms
    REQUEST_TIMEOUT: 8000, // Reduced from 10000ms for faster timeout
    RATE_LIMIT_WINDOW: 1000,
    DEBUG_MODE: false, // Set to true for debugging
    CACHE_DURATION: 300000 // 5 minutes cache for country/validation
  };

  // Performance optimization: Cache and state
  const cache = {
    country: null,
    countryTimestamp: 0,
    deviceInfo: null,
    scriptKey: null
  };

  let lastRequestTime = 0;
  let isTracking = false;
  let trackingInitialized = false;

  // Minimal logging - only errors in production
  function log(level, message, data) {
    if (level === 'error' || CONFIG.DEBUG_MODE) {
      // IMPROVED: Better iOS Safari console compatibility
      try {
        if (data !== undefined && data !== null && data !== '') {
          console[level](`[LeadsTrackr] ${message}`, data);
        } else {
          console[level](`[LeadsTrackr] ${message}`);
        }
      } catch (e) {
        // Fallback if console methods fail on some iOS versions
        console.log(`[LeadsTrackr] ${level.toUpperCase()}: ${message}`);
      }
    }
  }

  // Get script key with caching
  function getScriptKey() {
    if (cache.scriptKey) return cache.scriptKey;

    try {
      const scripts = document.getElementsByTagName("script");
      // Search from end (most recent scripts first)
      for (let i = scripts.length - 1; i >= 0; i--) {
        const src = scripts[i].src;
        if (src?.includes("tracker.js")) {
          const match = src.match(/[?&]key=([A-Za-z0-9_-]{16,})/);
          if (match?.[1]) {
            cache.scriptKey = match[1];
            return cache.scriptKey;
          }
        }
      }
    } catch (error) {
      log('error', 'Error extracting script key:', error);
    }
    return null;
  }

  // Optimized device detection with caching
  function getDeviceInfo() {
    if (cache.deviceInfo) return cache.deviceInfo;

    try {
      const ua = navigator.userAgent || '';
      // IMPROVED: Better iPhone/iOS detection
      const isIPhone = /iPhone/i.test(ua);
      const isIPad = /iPad/i.test(ua);
      const isIPod = /iPod/i.test(ua);
      const isIOS = isIPhone || isIPad || isIPod;
      const isAndroid = /Android/i.test(ua);
      const isMobile = isIPhone || isIPod || /Mobi|Android/i.test(ua);
      const isTablet = isIPad || /Tablet/i.test(ua);

      cache.deviceInfo = {
        type: isMobile ? 'Mobile' : isTablet ? 'Tablet' : 'Desktop',
        screen: `${screen.width}x${screen.height}`,
        language: navigator.language || 'unknown',
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'unknown'
      };

      return cache.deviceInfo;
    } catch (error) {
      cache.deviceInfo = { type: 'Unknown', screen: 'unknown', language: 'unknown', timezone: 'unknown' };
      return cache.deviceInfo;
    }
  }

  // Optimized country detection with caching and timeout
  async function getCountryWithTimeout() {
    const now = Date.now();

    // Return cached value if still valid
    if (cache.country && (now - cache.countryTimestamp) < CONFIG.CACHE_DURATION) {
      return cache.country;
    }

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 2000); // Reduced to 2s

      // IMPROVED: iOS Safari compatibility - remove priority as it's not widely supported
      const fetchOptions = {
        signal: controller.signal,
        cache: 'force-cache'
      };

      // Add priority only if supported (not available in older iOS Safari)
      if ('priority' in Request.prototype) {
        fetchOptions.priority = 'low';
      }

      const response = await fetch("https://ipapi.co/json", fetchOptions);

      clearTimeout(timeoutId);

      if (response.ok) {
        const data = await response.json();
        cache.country = data?.country_code || null;
        cache.countryTimestamp = now;
        return cache.country;
      }
    } catch (error) {
      // Silent fail - country is optional
    }

    cache.country = null;
    cache.countryTimestamp = now;
    return null;
  }

  // Fast URL normalization
  function normalizeUrl(url) {
    try {
      const urlObj = new URL(url);
      return `${urlObj.protocol}//${urlObj.hostname}${urlObj.pathname}`.toLowerCase();
    } catch (error) {
      return null;
    }
  }

  // Quick URL validation
  function isValidTrackingUrl(url) {
    try {
      const urlObj = new URL(url);
      const protocol = urlObj.protocol;
      const hostname = urlObj.hostname;

      return (protocol === 'https:' || protocol === 'http:') &&
        !(hostname.includes('localhost') && window.location.hostname !== 'localhost');
    } catch (error) {
      return false;
    }
  }

  // Optimized fetch with retry and timeout (CORS-safe)
  async function secureFetch(url, options = {}, retries = CONFIG.MAX_RETRIES) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), CONFIG.REQUEST_TIMEOUT);

    try {
      // IMPROVED: iOS Safari compatibility
      const fetchOptions = {
        ...options,
        signal: controller.signal,
        credentials: 'omit', // CRITICAL: Don't send cookies/credentials for CORS
        mode: 'cors', // Explicit CORS mode
        headers: {
          'Content-Type': 'application/json',
          ...options.headers
        }
      };

      // iOS Safari needs explicit keepalive for form submissions
      if (options.keepalive !== undefined) {
        fetchOptions.keepalive = options.keepalive;
      }

      const response = await fetch(url, fetchOptions);

      clearTimeout(timeoutId);
      return response;
    } catch (error) {
      clearTimeout(timeoutId);

      // Retry only on network errors, not on abort/timeout
      if (retries > 0 && !controller.signal.aborted && error.name !== 'AbortError') {
        await new Promise(resolve => setTimeout(resolve, CONFIG.RETRY_DELAY));
        return secureFetch(url, options, retries - 1);
      }

      throw error;
    }
  }

  // Fast UTM extraction
  function extractUTM() {
    const params = new URLSearchParams(window.location.search);
    const utm = {};
    const utmParams = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content'];

    for (const param of utmParams) {
      const value = params.get(param);
      if (value && value.length < 100) {
        utm[param] = value.substring(0, 100);
      }
    }

    return Object.keys(utm).length > 0 ? utm : null;
  }

  // Main tracking initialization - optimized
  async function initializeTracking() {
    if (trackingInitialized) return;
    trackingInitialized = true;

    const scriptKey = getScriptKey();
    if (!scriptKey) {
      log('error', 'Script key not found');
      return;
    }

    const currentUrl = window.location.href;
    if (!isValidTrackingUrl(currentUrl)) {
      log('error', 'Invalid URL');
      return;
    }

    if (isTracking) return;
    isTracking = true;

    try {
      // Fast domain validation
      const normalizedUrl = normalizeUrl(currentUrl);
      const checkApiUrl = `${CONFIG.API_BASE}/${scriptKey}/check`;

      const checkRes = await secureFetch(checkApiUrl, {
        method: "GET",
        credentials: 'omit', // No credentials needed for validation
        headers: { 'X-Requested-URL': normalizedUrl || currentUrl }
      });

      if (!checkRes.ok) {
        log('error', `Validation failed: ${checkRes.status}`);
        isTracking = false;
        return;
      }

      const checkData = await checkRes.json();

      if (!checkData.isAllowed) {
        log('error', 'URL not allowed');
        isTracking = false;
        return;
      }

      // Start tracking - optimized
      await startTracking(scriptKey);

    } catch (error) {
      log('error', 'Init failed:', error.message);
      isTracking = false;
    }
  }

  // Optimized tracking function
  async function startTracking(scriptKey) {
    try {
      // Get device info (cached)
      const deviceInfo = getDeviceInfo();

      // Extract UTM (fast)
      const utm = extractUTM();

      // Start country detection in background (non-blocking)
      const countryPromise = getCountryWithTimeout();

      // Track page view immediately (don't wait for country)
      trackPageView(scriptKey, deviceInfo, utm, null).then(async () => {
        // Update with country when available
        const country = await countryPromise;
        if (country) {
          // Country available, but page view already sent - that's OK
        }
      });

      // Setup form tracking (non-blocking)
      // IMPROVED: iOS Safari may not have requestIdleCallback, use setTimeout as fallback
      if (typeof requestIdleCallback !== 'undefined' && requestIdleCallback) {
        requestIdleCallback(() => setupFormTracking(scriptKey, deviceInfo, utm, countryPromise), { timeout: 2000 });
      } else {
        // Fallback for iOS Safari and older browsers
        setTimeout(() => setupFormTracking(scriptKey, deviceInfo, utm, countryPromise), 100);
      }

    } catch (error) {
      log('error', 'Tracking error:', error.message);
    }
  }

  // Optimized page view tracking with CORS-safe fetch
  async function trackPageView(scriptKey, deviceInfo, utm, country) {
    try {
      const currentUrl = window.location.href;
      const normalizedUrl = normalizeUrl(currentUrl);

      const payload = {
        key: scriptKey,
        url: normalizedUrl || currentUrl,
        path: window.location.pathname,
        referrer: document.referrer || '',
        userAgent: navigator.userAgent || '',
        device: deviceInfo.type,
        screen: deviceInfo.screen,
        language: deviceInfo.language,
        timezone: deviceInfo.timezone,
        utm: utm,
        country: country,
        timestamp: new Date().toISOString()
      };

      // Direct call to page-view endpoint
      const apiUrl = `${CONFIG.API_BASE}/${scriptKey}/page-view`;

      try {
        const response = await secureFetch(apiUrl, {
          method: "POST",
          body: JSON.stringify(payload),
          credentials: 'omit', // CRITICAL: No credentials for CORS wildcard
          keepalive: true,     // Ensures request completes even if page unloads
          headers: {
            'X-Requested-URL': currentUrl
          }
        });

        if (!response.ok) {
          log('error', `Page view tracking failed: ${response.status}`);
        }
      } catch (fetchError) {
        log('error', 'Page view error:', fetchError.message);
      }
    } catch (error) {
      log('error', 'Page view error:', error.message);
    }
  }

  // Validate that all required form fields are filled
  function validateRequiredFields(form) {
    try {
      const elements = form.elements || form.querySelectorAll('input, select, textarea');
      const elementsArray = Array.from(elements);
      const missingFields = [];

      for (let i = 0; i < elementsArray.length; i++) {
        const element = elementsArray[i];

        // Check if field is required
        if (!element.required && !element.hasAttribute('required')) {
          continue;
        }

        // Skip disabled or hidden fields
        if (element.disabled || element.type === 'hidden') {
          continue;
        }

        // Validate based on field type
        let isEmpty = false;

        if (element.type === 'checkbox' || element.type === 'radio') {
          // For checkboxes and radio buttons, check if at least one is checked
          if (element.type === 'radio') {
            // For radio buttons with the same name, check if any in the group is checked
            const radioGroup = form.querySelectorAll(`input[name="${element.name}"][type="radio"]`);
            const isAnyChecked = Array.from(radioGroup).some(radio => radio.checked);
            if (!isAnyChecked) {
              isEmpty = true;
            }
          } else {
            // For checkboxes, simply check if this one is checked
            isEmpty = !element.checked;
          }
        } else if (element.tagName === 'SELECT') {
          // For select elements, check if a valid option is selected
          isEmpty = !element.value || element.value === '' || element.selectedIndex === -1;
        } else {
          // For text inputs, textareas, etc., check if value is not empty
          isEmpty = !element.value || element.value.trim() === '';
        }

        if (isEmpty) {
          const fieldLabel = element.name || element.id || element.type;
          missingFields.push(fieldLabel);

          if (CONFIG.DEBUG_MODE) {
            console.log('[LeadsTrackr] Required field not filled:', fieldLabel);
          }
        }
      }

      if (missingFields.length > 0) {
        if (CONFIG.DEBUG_MODE) {
          console.log('[LeadsTrackr] Form validation failed. Missing required fields:', missingFields);
        }
        return {
          valid: false,
          missingFields: missingFields
        };
      }

      return {
        valid: true,
        missingFields: []
      };
    } catch (error) {
      log('error', 'Required field validation error:', error.message);
      // On error, allow submission (fail open to not break user's forms)
      return {
        valid: true,
        missingFields: []
      };
    }
  }

  // Optimized form tracking with IntersectionObserver
  function setupFormTracking(scriptKey, deviceInfo, utm, countryPromise) {
    try {
      const forms = document.querySelectorAll("form[data-leadstrackr-key], form[data-fraudclicks-key]");

      if (forms.length === 0) return;

      forms.forEach((form) => {
        // Skip if already tracked
        if (form.dataset.leadstrackrTracked) return;
        form.dataset.leadstrackrTracked = 'true';

        // IMPROVED: Better iOS Safari compatibility
        // iOS Safari requires non-passive listeners for form submission tracking
        // Use capture phase to ensure we get the event before any other handlers
        form.addEventListener("submit", async function (event) {
          try {
            // Validate that all required fields are filled
            const validation = validateRequiredFields(form);

            if (!validation.valid) {
              log('error', 'Form submission not tracked - required fields missing:', validation.missingFields.join(', '));
              // Don't track the form submission if required fields are not filled
              return;
            }

            const formData = extractFormData(form);
            const country = await countryPromise;

            // Track form submission (don't await to avoid delaying form submission)
            trackFormSubmission(scriptKey, deviceInfo, utm, country, formData).catch(error => {
              log('error', 'Form tracking error:', error.message);
            });
          } catch (error) {
            log('error', 'Form tracking error:', error.message);
          }
        }, { capture: true, passive: false });
      });
    } catch (error) {
      log('error', 'Form setup error:', error.message);
    }
  }

  // Comprehensive form data extraction - handles all input types
  function extractFormData(form) {
    const data = {};
    const maxFieldLength = 500;
    const sensitiveFields = ['password', 'ssn', 'credit', 'card', 'cvv', 'cvc'];

    // Debug tracking
    let processedFields = 0;
    let skippedFields = 0;

    try {
      // IMPROVED: iOS Safari compatibility - ensure elements is properly accessed
      const elements = form.elements || form.querySelectorAll('input, select, textarea');

      // Debug: Log form info
      if (CONFIG.DEBUG_MODE) {
        console.log('[LeadsTrackr] Extracting data from form with', elements.length, 'elements');
      }

      // Convert to array for better iOS Safari compatibility
      const elementsArray = Array.from(elements);

      for (let i = 0; i < elementsArray.length; i++) {
        const element = elementsArray[i];

        // Skip if no name attribute
        if (!element.name) {
          skippedFields++;
          if (CONFIG.DEBUG_MODE) {
            console.log('[LeadsTrackr] Skipped element (no name):', element.tagName, element.type);
          }
          continue;
        }

        // Skip password fields
        if (element.type === 'password') {
          skippedFields++;
          if (CONFIG.DEBUG_MODE) {
            console.log('[LeadsTrackr] Skipped password field:', element.name);
          }
          continue;
        }

        // Skip sensitive fields
        const fieldName = element.name.toLowerCase();
        if (sensitiveFields.some(s => fieldName.includes(s))) {
          skippedFields++;
          if (CONFIG.DEBUG_MODE) {
            console.log('[LeadsTrackr] Skipped sensitive field:', element.name);
          }
          continue;
        }

        // Handle different input types
        let value = null;

        if (element.type === 'checkbox') {
          // For checkboxes, only store if checked (skip unchecked to reduce noise)
          if (element.checked) {
            value = element.value || 'checked';
          } else {
            // Skip unchecked checkboxes
            skippedFields++;
            continue;
          }
        } else if (element.type === 'radio') {
          // For radio buttons, only store if checked
          if (element.checked) {
            value = element.value;
          } else {
            continue; // Skip unchecked radio buttons
          }
        } else if (element.type === 'select-multiple') {
          // For multi-select, collect all selected options
          const selectedOptions = [];
          for (let j = 0; j < element.options.length; j++) {
            if (element.options[j].selected) {
              selectedOptions.push(element.options[j].value);
            }
          }
          value = selectedOptions.join(', ');
        } else if (element.tagName === 'SELECT' || element.tagName === 'TEXTAREA' || element.type === 'text' || element.type === 'email' || element.type === 'tel' || element.type === 'number' || element.type === 'url' || element.type === 'date' || element.type === 'time' || element.type === 'datetime-local') {
          // For regular inputs, textareas, and selects
          value = element.value;
        } else if (element.type === 'file') {
          // For file inputs, store filename(s) only
          if (element.files && element.files.length > 0) {
            const fileNames = [];
            for (let j = 0; j < element.files.length; j++) {
              fileNames.push(element.files[j].name);
            }
            value = fileNames.join(', ');
          }
        } else {
          // Default: try to get value for any other input type
          value = element.value;
        }

        // Only add if value exists and is not empty
        if (value !== null && value !== undefined && value !== '') {
          // Truncate long values
          if (typeof value === 'string') {
            data[element.name] = value.substring(0, maxFieldLength);
          } else {
            data[element.name] = value;
          }
          processedFields++;

          // Debug: Log each captured field
          if (CONFIG.DEBUG_MODE) {
            console.log('[LeadsTrackr] Captured field:', element.name, '=', value);
          }
        } else {
          skippedFields++;
          if (CONFIG.DEBUG_MODE) {
            console.log('[LeadsTrackr] Skipped empty field:', element.name);
          }
        }
      }

      // IMPROVED: Extract custom lt- attributes for custom fields
      // Supports both static (fixed value) and dynamic (input value) custom fields
      const customData = {};
      const elementsWithLtAttrs = form.querySelectorAll('[class*="lt-"], [id*="lt-"], input[lt-], select[lt-], textarea[lt-], button[lt-], div[lt-], span[lt-], label[lt-], [data-lt-]');

      // Better selector: find all elements with any lt- attribute
      const allFormElements = form.querySelectorAll('*');
      const ltElements = [];

      for (let i = 0; i < allFormElements.length; i++) {
        const elem = allFormElements[i];
        const attrs = elem.attributes;
        for (let j = 0; j < attrs.length; j++) {
          if (attrs[j].name.startsWith('lt-')) {
            ltElements.push(elem);
            break;
          }
        }
      }

      if (CONFIG.DEBUG_MODE) {
        console.log('[LeadsTrackr] Checking for custom lt- attributes in', ltElements.length, 'elements');
      }

      ltElements.forEach(element => {
        // Get all lt- attributes
        const attributes = element.attributes;
        for (let i = 0; i < attributes.length; i++) {
          const attr = attributes[i];
          // Check if it's an lt- attribute
          if (attr.name.startsWith('lt-')) {
            const attrValue = attr.value;
            let capturedValue = null;

            // Determine if it's static or dynamic
            if (attrValue && attrValue.trim() !== '') {
              // STATIC: Attribute has a value, use it directly
              capturedValue = attrValue.trim();

              if (CONFIG.DEBUG_MODE) {
                console.log('[LeadsTrackr] Captured STATIC custom field:', attr.name, '=', capturedValue);
              }
            } else {
              // DYNAMIC: Attribute is empty, capture from element value
              // Check if element has a value property (input, select, textarea)
              if (element.value !== undefined && element.value !== null) {
                const elementValue = element.value;

                if (elementValue && elementValue.trim() !== '') {
                  capturedValue = elementValue.trim();

                  if (CONFIG.DEBUG_MODE) {
                    console.log('[LeadsTrackr] Captured DYNAMIC custom field:', attr.name, '=', capturedValue, 'from', element.tagName);
                  }
                }
              }
            }

            // Add to customData if we have a value
            if (capturedValue) {
              customData[attr.name] = capturedValue.substring(0, maxFieldLength);
            }
          }
        }
      });

      // Add customData to main data object if any custom attributes were found
      if (Object.keys(customData).length > 0) {
        data._customData = customData;
        if (CONFIG.DEBUG_MODE) {
          console.log('[LeadsTrackr] Custom data captured:', customData);
        }
      }

      // Debug summary
      if (CONFIG.DEBUG_MODE || processedFields === 0) {
        console.log('[LeadsTrackr] Form extraction complete:');
        console.log('  - Processed:', processedFields, 'fields');
        console.log('  - Skipped:', skippedFields, 'fields');
        console.log('  - Data:', data);
        console.log('  - Custom Data:', customData);
      }
    } catch (error) {
      log('error', 'Form extraction error:', error.message);
    }

    return data;
  }

  // Optimized form submission tracking with CORS-safe fetch
  async function trackFormSubmission(scriptKey, deviceInfo, utm, country, formData) {
    try {
      const currentUrl = window.location.href;
      const normalizedUrl = normalizeUrl(currentUrl);

      // Debug: Log formData being sent
      if (CONFIG.DEBUG_MODE || Object.keys(formData).length === 0) {
        console.log('[LeadsTrackr] Form data extracted:', formData);
        console.log('[LeadsTrackr] Form fields count:', Object.keys(formData).length);
      }

      // Extract custom data if present
      const customData = formData._customData || {};
      // Remove _customData from formData to keep it clean
      const cleanFormData = { ...formData };
      delete cleanFormData._customData;

      const payload = {
        key: scriptKey,
        url: normalizedUrl || currentUrl,
        path: window.location.pathname,
        referrer: document.referrer || '',
        userAgent: navigator.userAgent || '',
        device: deviceInfo.type,
        screen: deviceInfo.screen,
        language: deviceInfo.language,
        timezone: deviceInfo.timezone,
        utm: utm,
        country: country,
        formData: cleanFormData,
        customData: Object.keys(customData).length > 0 ? customData : undefined,
        email: cleanFormData.email || cleanFormData.Email || cleanFormData.EMAIL || '',
        phone: cleanFormData.phone || cleanFormData.Phone || cleanFormData.PHONE || '',
        timestamp: new Date().toISOString()
      };

      // Debug: Log payload
      if (CONFIG.DEBUG_MODE) {
        console.log('[LeadsTrackr] Payload being sent:', JSON.stringify(payload, null, 2));
      }

      // Direct call to form-submit endpoint
      const apiUrl = `${CONFIG.API_BASE}/${scriptKey}/form-submit`;

      try {
        const response = await secureFetch(apiUrl, {
          method: "POST",
          body: JSON.stringify(payload),
          credentials: 'omit', // CRITICAL: No credentials for CORS wildcard
          keepalive: true,     // Ensures request completes even on page unload
          headers: {
            'X-Requested-URL': currentUrl
          }
        });

        if (!response.ok) {
          log('error', `Form submission failed: ${response.status}`);
        }
      } catch (fetchError) {
        log('error', 'Form submit error:', fetchError.message);
      }
    } catch (error) {
      log('error', 'Form submit error:', error.message);
    }
  }

  // Initialize tracking - optimized
  try {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', initializeTracking, { once: true });
    } else {
      // DOM already ready - use setTimeout to not block
      setTimeout(initializeTracking, 0);
    }
  } catch (error) {
    log('error', 'Script init error:', error.message);
  }

})();
