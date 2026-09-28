import { describe, expect, it } from 'vitest';
import { normalizeGoal, tokenize } from '../../src/journey/goal.js';
import { classifyGoal } from '../../src/journey/classify.js';
import { scanArgs, flagValue, splitFlag } from '../../src/cli/args.js';

describe('normalizeGoal', () => {
  it('lower-cases and collapses whitespace', () => {
    expect(normalizeGoal('  Try   To   COMPLETE Checkout  ')).toBe('try to complete checkout');
  });

  it('normalises tabs and newlines', () => {
    expect(normalizeGoal('log\tin\nnow')).toBe('log in now');
  });

  it('returns an empty string for null, undefined or blank input', () => {
    expect(normalizeGoal(null)).toBe('');
    expect(normalizeGoal(undefined)).toBe('');
    expect(normalizeGoal('     ')).toBe('');
  });

  it('is idempotent', () => {
    const once = normalizeGoal('  Sign   Up  ');
    expect(normalizeGoal(once)).toBe(once);
  });
});

describe('tokenize', () => {
  it('splits on non-alphanumerics and drops empties', () => {
    expect(tokenize('add-to.cart / pay!')).toEqual(['add', 'to', 'cart', 'pay']);
  });

  it('returns nothing for an empty goal', () => {
    expect(tokenize('')).toEqual([]);
  });
});

describe('classifyGoal', () => {
  const classify = (goal: string) => classifyGoal(normalizeGoal(goal));

  it('classifies login goals', () => {
    for (const goal of ['log in', 'sign in', 'login to my account', 'authenticate the user', 'signin']) {
      expect(classify(goal).journeyType, goal).toBe('login');
    }
  });

  it('classifies registration goals', () => {
    for (const goal of ['register', 'sign up', 'create account', 'new account', 'registration']) {
      expect(classify(goal).journeyType, goal).toBe('registration');
    }
  });

  it('classifies checkout and purchase goals', () => {
    expect(classify('try to complete checkout').journeyType).toBe('checkout');
    expect(classify('buy a widget').journeyType).toBe('checkout');
    expect(classify('proceed to checkout').journeyType).toBe('checkout');
    expect(classify('purchase an item').journeyType).toBe('checkout');
  });

  it('classifies ticket purchase separately from generic checkout', () => {
    expect(classify('try to purchase a ticket').journeyType).toBe('ticket_purchase');
    expect(classify('buy tickets').journeyType).toBe('ticket_purchase');
    expect(classify('book a ticket').journeyType).toBe('ticket_purchase');
  });

  it('classifies form submission goals', () => {
    expect(classify('submit the form').journeyType).toBe('form_submission');
    expect(classify('apply for access').journeyType).toBe('form_submission');
    expect(classify('make a request').journeyType).toBe('form_submission');
  });

  it('classifies search goals', () => {
    expect(classify('search for widgets').journeyType).toBe('search');
    expect(classify('find the cheapest item').journeyType).toBe('search');
  });

  it('classifies contact goals', () => {
    expect(classify('contact support').journeyType).toBe('contact');
    expect(classify('send a message').journeyType).toBe('contact');
    expect(classify('get in touch').journeyType).toBe('contact');
  });

  it('classifies upload goals', () => {
    expect(classify('upload a file').journeyType).toBe('upload');
    expect(classify('attach a document').journeyType).toBe('upload');
    expect(classify('add file').journeyType).toBe('upload');
  });

  it('classifies navigation goals', () => {
    expect(classify('navigate to the settings page').journeyType).toBe('navigation');
    expect(classify('visit the about page').journeyType).toBe('navigation');
  });

  it('returns unknown for an unrecognised goal', () => {
    const result = classify('do the needful with the thingamajig');
    expect(result.journeyType).toBe('unknown');
    expect(result.unmatched).toBe(true);
    expect(result.ambiguous).toBe(false);
  });

  it('returns unknown for an empty goal', () => {
    const result = classify('');
    expect(result.journeyType).toBe('unknown');
    expect(result.unmatched).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(classify('LOG IN').journeyType).toBe(classify('log in').journeyType);
    expect(classify('CheckOut').journeyType).toBe('checkout');
  });

  it('reports ambiguity and resolves by priority', () => {
    // "sign up and log in" matches both auth categories; login outranks
    // registration, and the loser is recorded rather than hidden.
    const result = classify('sign up then log in');
    expect(result.ambiguous).toBe(true);
    expect(result.matches).toContain('login');
    expect(result.matches).toContain('registration');
    expect(result.journeyType).toBe('login');
  });

  it('prefers the more specific category over the generic one', () => {
    // "upload" outranks the generic form-submission wording it co-occurs with.
    const result = classify('submit a file upload form');
    expect(result.journeyType).toBe('upload');
    expect(result.matches).toContain('form_submission');
  });

  it('is deterministic across repeated calls', () => {
    const goal = 'try to purchase a ticket for the concert';
    const first = classify(goal);
    for (let i = 0; i < 5; i++) {
      expect(classify(goal)).toEqual(first);
    }
  });

  it('reports the terms that caused the winning match', () => {
    const result = classify('sign in to my account');
    expect(result.matchedTerms.length).toBeGreaterThan(0);
    expect(result.matchedTerms).toContain('sign in');
  });
});

describe('splitFlag', () => {
  it('splits an inline value', () => {
    expect(splitFlag('--goal=log in')).toEqual(['--goal', 'log in']);
  });

  it('returns a null value when there is none', () => {
    expect(splitFlag('--goal')).toEqual(['--goal', null]);
  });

  it('keeps an empty inline value', () => {
    expect(splitFlag('--goal=')).toEqual(['--goal', '']);
  });
});

describe('scanArgs', () => {
  it('reads space-separated flag values', () => {
    const scan = scanArgs(['--goal', 'log in', '--scout', 'reports/scout.json']);
    expect(flagValue(scan, ['--goal']).value).toBe('log in');
    expect(flagValue(scan, ['--scout']).value).toBe('reports/scout.json');
  });

  it('reads inline flag values', () => {
    expect(flagValue(scanArgs(['--goal=log in']), ['--goal']).value).toBe('log in');
  });

  it('treats a flag followed by another flag as a bare boolean', () => {
    const scan = scanArgs(['--a', '--b', 'x']);
    expect(flagValue(scan, ['--a'])).toEqual({ present: true, value: null, missingValue: true });
    expect(flagValue(scan, ['--b']).value).toBe('x');
  });

  it('treats a trailing bare flag as present without a value', () => {
    expect(flagValue(scanArgs(['--a']), ['--a'])).toEqual({ present: true, value: null, missingValue: true });
  });

  it('collects positionals', () => {
    expect(scanArgs(['try to log in']).positionals).toEqual(['try to log in']);
  });

  it('stops flag parsing at --', () => {
    const scan = scanArgs(['--goal', 'x', '--', '--not-a-flag']);
    expect(scan.positionals).toEqual(['--not-a-flag']);
  });

  it('does not treat negative numbers as flags', () => {
    expect(scanArgs(['--goal', '-42']).positionals).toEqual([]);
    expect(flagValue(scanArgs(['--goal', '-42']), ['--goal']).value).toBe('-42');
  });
});
