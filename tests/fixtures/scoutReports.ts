/**
 * Scout report fixtures for Journey Intelligence tests.
 *
 * These are plain objects shaped like Build 1 output. No browser is opened and
 * no HTML is parsed - planning is a pure function of the goal and this data,
 * which is exactly what the fixtures are here to prove.
 */

import type { InteractiveElement, ScoutForm, ScoutReport } from '../../src/scout/types.js';

/** An interactive element with sensible defaults for planner tests. */
export function el(overrides: Partial<InteractiveElement> & { index: number }): InteractiveElement {
  return {
    type: 'input',
    tag: 'input',
    text: null,
    label: null,
    name: null,
    id: null,
    placeholder: null,
    ariaLabel: null,
    role: null,
    href: null,
    inputType: null,
    value: null,
    selector: `#element-${overrides.index + 1}`,
    locator: null,
    visible: true,
    enabled: true,
    required: false,
    disabled: false,
    readonly: false,
    formIndex: null,
    ...overrides,
  };
}

/** A form referencing the given element indices. */
export function form(overrides: Partial<ScoutForm> = {}): ScoutForm {
  return {
    selector: 'form#main',
    action: null,
    method: null,
    name: null,
    id: null,
    visible: true,
    fields: [],
    submitButtons: [],
    externalSubmitButtons: [],
    ...overrides,
  };
}

/** Assemble a minimal but structurally valid Scout report. */
export function scoutReport(overrides: Partial<ScoutReport> = {}): ScoutReport {
  return {
    meta: {
      tool: 'CrashLab Scout',
      version: '0.1.0',
      schemaVersion: 1,
      createdAt: '2026-01-01T00:00:00.000Z',
      durationMs: 100,
      browser: 'chromium',
      userAgent: 'fixture',
      viewport: { width: 1280, height: 800 },
      navigationTimings: { domContentLoadedMs: 10, loadMs: 20, timeSinceNavigationMs: 30 },
      config: {
        headless: true,
        timeoutMs: 30000,
        settleMs: 1000,
        slowMoMs: 0,
        ignoreHttpsErrors: false,
        domScope: ['input', 'button', 'a[href]'],
      },
    },
    target: {
      inputUrl: 'https://staging.example.test/',
      finalUrl: 'https://staging.example.test/',
      title: 'Fixture',
      redirected: false,
      secureContext: true,
    },
    page: {
      detectedPageType: 'unknown',
      pageTypeConfidence: 0,
      pageTypeReason: 'fixture',
      pageTypeCandidates: [],
      visibleTextSample: '',
      visibleTextLength: 0,
      readyState: 'complete',
      htmlLang: 'en',
      canonicalUrl: null,
      metaDescription: null,
    },
    interactiveElements: [],
    forms: [],
    network: [],
    networkSummary: {
      totalRequests: 0,
      failedRequests: 0,
      errorResponses: 0,
      slowRequests: 0,
      thirdPartyRequests: 0,
      byMethod: {},
      byResourceType: {},
      byStatus: [],
    },
    console: [],
    consoleSummary: { total: 0, byType: {} },
    errors: [],
    scoutErrors: [],
    warnings: [],
    elementCounts: {},
    ...overrides,
  };
}

/** A conventional login page: email, password, sign-in button. */
export function loginScoutReport(): ScoutReport {
  return scoutReport({
    target: {
      inputUrl: 'https://staging.example.test/login',
      finalUrl: 'https://staging.example.test/login',
      title: 'Sign in',
      redirected: false,
      secureContext: true,
    },
    interactiveElements: [
      el({ index: 0, type: 'input', tag: 'input', inputType: 'email', name: 'email', id: 'email', label: 'Email', formIndex: 0 }),
      el({ index: 1, type: 'input', tag: 'input', inputType: 'password', name: 'password', id: 'password', label: 'Password', formIndex: 0 }),
      el({ index: 2, type: 'button', tag: 'button', text: 'Sign in', name: 'commit', formIndex: 0 }),
      el({ index: 3, type: 'link', tag: 'a', text: 'Forgot password?', href: 'https://staging.example.test/reset' }),
    ],
    forms: [form({ id: 'login', fields: [], submitButtons: [] })],
  });
}

/** A registration page: name, email, password, confirm, register button. */
export function registrationScoutReport(): ScoutReport {
  return scoutReport({
    target: {
      inputUrl: 'https://staging.example.test/register',
      finalUrl: 'https://staging.example.test/register',
      title: 'Create account',
      redirected: false,
      secureContext: true,
    },
    interactiveElements: [
      el({ index: 0, type: 'input', tag: 'input', inputType: 'text', name: 'name', id: 'name', label: 'Full name', formIndex: 0 }),
      el({ index: 1, type: 'input', tag: 'input', inputType: 'email', name: 'email', label: 'Email', formIndex: 0 }),
      el({ index: 2, type: 'input', tag: 'input', inputType: 'password', name: 'password', label: 'Password', formIndex: 0 }),
      el({ index: 3, type: 'input', tag: 'input', inputType: 'password', name: 'password_confirmation', label: 'Confirm password', formIndex: 0 }),
      el({ index: 4, type: 'button', tag: 'button', text: 'Create account', name: 'commit', formIndex: 0 }),
      el({ index: 5, type: 'link', tag: 'a', text: 'Sign in', href: 'https://staging.example.test/login' }),
    ],
    forms: [form({ id: 'registration' })],
  });
}

/** A product page with a buy button, quantity, cart and checkout controls. */
export function checkoutScoutReport(): ScoutReport {
  return scoutReport({
    target: {
      inputUrl: 'https://shop.example.test/product/9',
      finalUrl: 'https://shop.example.test/product/9',
      title: 'Blue Widget',
      redirected: false,
      secureContext: true,
    },
    interactiveElements: [
      el({ index: 0, type: 'link', tag: 'a', text: 'Home', href: 'https://shop.example.test/' }),
      el({ index: 1, type: 'button', tag: 'button', text: 'Buy now', id: 'buy-now' }),
      el({ index: 2, type: 'button', tag: 'button', text: 'Add to cart', id: 'add-to-cart' }),
      el({ index: 3, type: 'input', tag: 'input', inputType: 'number', name: 'quantity', id: 'quantity', label: 'Quantity' }),
      el({ index: 4, type: 'link', tag: 'a', text: 'View cart', href: 'https://shop.example.test/cart' }),
      // Present in the DOM but not rendered, and present but disabled: neither
      // may be planned as a usable control.
      el({ index: 5, type: 'button', tag: 'button', text: 'Checkout', id: 'checkout', visible: false }),
      el({ index: 6, type: 'button', tag: 'button', text: 'Pay now', id: 'pay-now', disabled: true, enabled: false }),
    ],
    forms: [],
  });
}

/** An event page with ticket selection and reservation controls. */
export function ticketScoutReport(): ScoutReport {
  return scoutReport({
    target: {
      inputUrl: 'https://events.example.test/concert',
      finalUrl: 'https://events.example.test/concert',
      title: 'Concert Tickets',
      redirected: false,
      secureContext: true,
    },
    interactiveElements: [
      el({ index: 0, type: 'button', tag: 'button', text: 'Buy ticket', id: 'buy-ticket' }),
      el({ index: 1, type: 'button', tag: 'button', text: 'Reserve seat', id: 'reserve' }),
      el({ index: 2, type: 'select', tag: 'select', name: 'quantity', id: 'qty', label: 'Number of tickets' }),
      el({ index: 3, type: 'link', tag: 'a', text: 'View basket', href: 'https://events.example.test/basket' }),
      el({ index: 4, type: 'button', tag: 'button', text: 'Pay now', id: 'pay' }),
    ],
    forms: [],
  });
}

/** A contact/application form. */
export function formScoutReport(): ScoutReport {
  return scoutReport({
    target: {
      inputUrl: 'https://example.test/apply',
      finalUrl: 'https://example.test/apply',
      title: 'Apply',
      redirected: false,
      secureContext: true,
    },
    interactiveElements: [
      el({ index: 0, type: 'input', tag: 'input', inputType: 'text', name: 'name', label: 'Full name', formIndex: 0 }),
      el({ index: 1, type: 'input', tag: 'input', inputType: 'email', name: 'email', label: 'Email', formIndex: 0 }),
      el({ index: 2, type: 'select', tag: 'select', name: 'country', label: 'Country', formIndex: 0 }),
      el({ index: 3, type: 'textarea', tag: 'textarea', name: 'message', label: 'Message', formIndex: 0 }),
      el({ index: 4, type: 'input', tag: 'input', inputType: 'file', name: 'cv', label: 'Attach CV', formIndex: 0 }),
      el({ index: 5, type: 'button', tag: 'button', text: 'Submit application', name: 'commit', formIndex: 0 }),
      // Outside the form, so `formForElement` has something to decline.
      el({ index: 6, type: 'link', tag: 'a', text: 'Privacy policy', href: 'https://example.test/privacy' }),
    ],
    forms: [form({ id: 'application', action: 'https://example.test/thank-you', method: 'post' })],
  });
}

/** A page with a search input and button. */
export function searchScoutReport(): ScoutReport {
  return scoutReport({
    target: {
      inputUrl: 'https://example.test/catalog',
      finalUrl: 'https://example.test/catalog',
      title: 'Catalog',
      redirected: false,
      secureContext: true,
    },
    interactiveElements: [
      el({ index: 0, type: 'input', tag: 'input', inputType: 'search', name: 'q', id: 'q', placeholder: 'Search products', formIndex: 0 }),
      el({ index: 1, type: 'button', tag: 'button', text: 'Search', formIndex: 0 }),
    ],
    forms: [form({ id: 'search' })],
  });
}

/** A page with a contact form. */
export function contactScoutReport(): ScoutReport {
  return scoutReport({
    target: {
      inputUrl: 'https://example.test/contact',
      finalUrl: 'https://example.test/contact',
      title: 'Contact us',
      redirected: false,
      secureContext: true,
    },
    interactiveElements: [
      el({ index: 0, type: 'input', tag: 'input', inputType: 'text', name: 'name', label: 'Your name', formIndex: 0 }),
      el({ index: 1, type: 'input', tag: 'input', inputType: 'email', name: 'email', label: 'Email address', formIndex: 0 }),
      el({ index: 2, type: 'textarea', tag: 'textarea', name: 'message', label: 'Message', formIndex: 0 }),
      el({ index: 3, type: 'button', tag: 'button', text: 'Send message', formIndex: 0 }),
    ],
    forms: [form({ id: 'contact' })],
  });
}

/** A page with a file input and upload button. */
export function uploadScoutReport(): ScoutReport {
  return scoutReport({
    target: {
      inputUrl: 'https://example.test/upload',
      finalUrl: 'https://example.test/upload',
      title: 'Upload a document',
      redirected: false,
      secureContext: true,
    },
    interactiveElements: [
      el({ index: 0, type: 'input', tag: 'input', inputType: 'file', name: 'document', id: 'document', label: 'Choose file' }),
      el({ index: 1, type: 'button', tag: 'button', text: 'Upload', id: 'upload' }),
    ],
    forms: [],
  });
}

/** A valid report whose page has no controls relevant to any goal. */
export function noMatchScoutReport(): ScoutReport {
  return scoutReport({
    target: {
      inputUrl: 'https://example.test/blank',
      finalUrl: 'https://example.test/blank',
      title: 'Blank page',
      redirected: false,
      secureContext: true,
    },
    interactiveElements: [el({ index: 0, type: 'link', tag: 'a', text: 'Privacy policy', href: 'https://example.test/privacy' })],
    forms: [],
  });
}

/** A report with several equally plausible submit controls. */
export function ambiguousScoutReport(): ScoutReport {
  return scoutReport({
    interactiveElements: [
      el({ index: 0, type: 'button', tag: 'button', text: 'Submit', id: 'submit-a' }),
      el({ index: 1, type: 'button', tag: 'button', text: 'Submit', id: 'submit-b' }),
      el({ index: 2, type: 'button', tag: 'button', text: 'Submit', id: 'submit-c' }),
    ],
    forms: [],
  });
}

/** A page where the only matching controls are hidden. */
export function hiddenOnlyScoutReport(): ScoutReport {
  return scoutReport({
    interactiveElements: [
      el({ index: 0, type: 'button', tag: 'button', text: 'Checkout', id: 'checkout', visible: false }),
      el({ index: 1, type: 'input', tag: 'input', inputType: 'text', name: 'coupon', label: 'Coupon code', visible: false }),
    ],
    forms: [],
  });
}

/** A page where the only matching controls are disabled. */
export function disabledOnlyScoutReport(): ScoutReport {
  return scoutReport({
    interactiveElements: [
      el({ index: 0, type: 'button', tag: 'button', text: 'Checkout', id: 'checkout', enabled: false, disabled: true }),
    ],
    forms: [],
  });
}

/** A page with no interactive elements at all. */
export function emptyScoutReport(): ScoutReport {
  return scoutReport({
    target: {
      inputUrl: 'https://example.test/empty',
      finalUrl: 'https://example.test/empty',
      title: 'Nothing here',
      redirected: false,
      secureContext: true,
    },
    interactiveElements: [],
    forms: [],
  });
}
