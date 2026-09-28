import { describe, expect, it } from 'vitest';
import { CONFIDENCE_THRESHOLD, detectPageType } from '../../src/scout/pageType.js';
import type { RawPageSignals } from '../../src/scout/domRaw.js';

/** Build page signals with neutral defaults so each test states only its evidence. */
function signals(overrides: Partial<RawPageSignals> = {}): RawPageSignals {
  return {
    path: '/',
    title: '',
    text: '',
    formCount: 0,
    formActionPaths: [],
    inputTypes: [],
    visibleFieldCount: 0,
    hasPasswordField: false,
    hasFileInput: false,
    hasSearchInput: false,
    tableCount: 0,
    navCount: 0,
    headingTexts: [],
    buttonTexts: [],
    linkTexts: [],
    repeatedBlockCount: 0,
    ...overrides,
  };
}

describe('detectPageType', () => {
  it('returns unknown for a page with no distinguishing evidence', () => {
    const result = detectPageType(signals({ title: 'Nothing here', text: 'Nothing here' }));
    expect(result.detectedPageType).toBe('unknown');
    expect(result.pageTypeConfidence).toBeLessThan(CONFIDENCE_THRESHOLD);
  });

  it('detects a login page from a password field and sign-in wording', () => {
    const result = detectPageType(
      signals({
        path: '/login',
        title: 'Sign in',
        hasPasswordField: true,
        formCount: 1,
        visibleFieldCount: 3,
        buttonTexts: ['Sign in'],
      }),
    );
    expect(result.detectedPageType).toBe('login');
    expect(result.pageTypeConfidence).toBeGreaterThanOrEqual(CONFIDENCE_THRESHOLD);
    expect(result.pageTypeReason).toMatch(/password field/i);
  });

  it('detects a checkout page from order and payment evidence', () => {
    const result = detectPageType(
      signals({
        path: '/checkout',
        title: 'Checkout',
        text: 'Order summary, shipping address, payment method. Subtotal 40.00',
        buttonTexts: ['Place order'],
        formCount: 1,
        visibleFieldCount: 5,
        formActionPaths: ['/api/payments'],
      }),
    );
    expect(result.detectedPageType).toBe('checkout');
  });

  it('detects a search page from a search input plus corroborating wording', () => {
    const result = detectPageType(
      signals({ path: '/catalog?q=shoes', title: 'Search results', hasSearchInput: true, formCount: 1, visibleFieldCount: 1 }),
    );
    expect(result.detectedPageType).toBe('search');
  });

  it('stays unknown when a search input is the only evidence', () => {
    // One search field on a catalog page is genuinely ambiguous, so Scout
    // should decline rather than guess.
    const result = detectPageType(signals({ path: '/catalog', hasSearchInput: true, formCount: 1, visibleFieldCount: 1 }));
    expect(result.detectedPageType).toBe('unknown');
  });

  it('detects signup and does not call it a login page', () => {
    const result = detectPageType(
      signals({
        path: '/register',
        title: 'Create your account',
        hasPasswordField: true,
        formCount: 1,
        visibleFieldCount: 4,
        buttonTexts: ['Create account'],
      }),
    );
    expect(result.detectedPageType).toBe('signup');
  });

  it('detects a list page from repeated blocks', () => {
    const result = detectPageType(signals({ path: '/products', repeatedBlockCount: 24, navCount: 1 }));
    expect(result.detectedPageType).toBe('list');
  });

  it('detects a dashboard from tables and overview copy', () => {
    const result = detectPageType(
      signals({ path: '/dashboard', text: 'Dashboard overview, recent activity, statistics', tableCount: 3, navCount: 2 }),
    );
    expect(result.detectedPageType).toBe('dashboard');
  });

  it('falls back to form for a plain multi-field form', () => {
    const result = detectPageType(signals({ path: '/contact', formCount: 1, visibleFieldCount: 4 }));
    expect(result.detectedPageType).toBe('form');
  });

  it('reports candidates with reasons, sorted by confidence', () => {
    const result = detectPageType(
      signals({ path: '/checkout', title: 'Checkout', formCount: 1, visibleFieldCount: 4, buttonTexts: ['Place order'] }),
    );
    expect(result.pageTypeCandidates.length).toBeGreaterThan(0);
    for (const candidate of result.pageTypeCandidates) {
      expect(candidate.reason.length).toBeGreaterThan(0);
      expect(candidate.confidence).toBeGreaterThanOrEqual(0);
      expect(candidate.confidence).toBeLessThanOrEqual(1);
    }
    const first = result.pageTypeCandidates[0]!;
    const second = result.pageTypeCandidates[1];
    if (second) expect(first.confidence).toBeGreaterThanOrEqual(second.confidence);
  });

  it('stays unknown when the best candidate is below the confidence bar', () => {
    // A single weak form signal, with nothing to corroborate it.
    const result = detectPageType(signals({ formCount: 1, visibleFieldCount: 2 }));
    expect(result.detectedPageType).toBe('unknown');
    expect(result.pageTypeReason).toMatch(/ambiguous/i);
  });
});
