import { describe, expect, it } from 'vitest';
import { classifyElement, mapElements, mapForms, suggestLocator, toInteractiveElement } from '../../src/scout/elements.js';

import type { RawDomElement, RawDomForm } from '../../src/scout/domRaw.js';

/** Build a raw element with sensible defaults, overriding only what a test cares about. */
function raw(overrides: Partial<RawDomElement> = {}): RawDomElement {
  return {
    domIndex: 0,
    tag: 'button',
    typeHint: '',
    role: null,
    ariaLabel: null,
    text: null,
    label: null,
    name: null,
    id: null,
    placeholder: null,
    href: null,
    value: null,
    title: null,
    selector: 'button',
    visible: true,
    enabled: true,
    disabled: false,
    readonly: false,
    required: false,
    tabIndex: null,
    testId: null,
    formIndex: null,
    isSubmitControl: false,
    isExternalSubmit: false,
    ...overrides,
  };
}

describe('classifyElement', () => {
  it('classifies anchor tags as links', () => {
    expect(classifyElement(raw({ tag: 'a', href: '/x' }))).toBe('link');
  });

  it('classifies an explicit role over the tag', () => {
    expect(classifyElement(raw({ tag: 'div', role: 'button', text: 'x' }))).toBe('button');
    expect(classifyElement(raw({ tag: 'div', role: 'textbox', ariaLabel: 'notes' }))).toBe('input');
  });

  it('splits input types into their own categories', () => {
    expect(classifyElement(raw({ tag: 'input', typeHint: 'text' }))).toBe('input');
    expect(classifyElement(raw({ tag: 'input', typeHint: 'password' }))).toBe('input');
    expect(classifyElement(raw({ tag: 'input', typeHint: 'checkbox' }))).toBe('checkbox');
    expect(classifyElement(raw({ tag: 'input', typeHint: 'radio' }))).toBe('radio');
    expect(classifyElement(raw({ tag: 'input', typeHint: 'submit' }))).toBe('button');
    expect(classifyElement(raw({ tag: 'input', typeHint: 'file' }))).toBe('input');
  });

  it('keeps select and textarea as themselves', () => {
    expect(classifyElement(raw({ tag: 'select' }))).toBe('select');
    expect(classifyElement(raw({ tag: 'textarea' }))).toBe('textarea');
  });
});

describe('suggestLocator', () => {
  it('prefers a test id above everything else', () => {
    expect(suggestLocator(raw({ testId: 'place-order', text: 'Place order' }), 'button')).toBe(
      "page.getByTestId('place-order')",
    );
  });

  it('falls back to role and accessible name', () => {
    expect(suggestLocator(raw({ tag: 'button', text: 'Place order' }), 'button')).toBe(
      "page.getByRole('button', { name: 'Place order' })",
    );
  });

  it('falls back to a label when the element has no role', () => {
    // A `label` doubles as the accessible name, so for any roled control the
    // role locator wins. The label branch is for unroled elements.
    const unroled = raw({ tag: 'div', label: 'Email address' });
    expect(suggestLocator(unroled, classifyElement(unroled))).toBe("page.getByLabel('Email address')");
  });

  it('falls back to a placeholder last', () => {
    expect(suggestLocator(raw({ tag: 'input', typeHint: 'text', placeholder: 'you@example.com' }), 'input')).toBe(
      "page.getByPlaceholder('you@example.com')",
    );
  });

  it('returns null when nothing stable exists', () => {
    expect(suggestLocator(raw({ tag: 'input', typeHint: 'text' }), 'input')).toBeNull();
  });

  it('escapes embedded quotes so the locator stays valid', () => {
    expect(suggestLocator(raw({ testId: "it's-fine" }), 'button')).toBe("page.getByTestId('it\\'s-fine')");
  });
});

describe('toInteractiveElement', () => {
  it('produces a fully typed record', () => {
    const element = toInteractiveElement(
      raw({
        tag: 'a',
        href: '/about',
        text: 'About',
        selector: 'nav > a:nth-of-type(1)',
        testId: null,
      }),
      3,
      'https://x.test/home',
    );

    expect(element).toMatchObject({
      type: 'link',
      tag: 'a',
      text: 'About',
      href: 'https://x.test/about',
      selector: 'nav > a:nth-of-type(1)',
      visible: true,
      enabled: true,
      index: 3,
      formIndex: null,
    });
    expect(typeof element.locator).toBe('string');
  });

  it('exposes inputType only for form controls', () => {
    expect(toInteractiveElement(raw({ tag: 'input', typeHint: 'email' }), 0, null).inputType).toBe('email');
    expect(toInteractiveElement(raw({ tag: 'button' }), 0, null).inputType).toBeNull();
  });
});

describe('mapElements / mapForms', () => {
  it('preserves DOM order and index', () => {
    const elements = mapElements(
      [raw({ tag: 'a', href: '/a' }), raw({ tag: 'input', typeHint: 'text' }), raw({ tag: 'button' })],
      'https://x.test/',
    );
    expect(elements.map((element) => element.index)).toEqual([0, 1, 2]);
    expect(elements.map((element) => element.type)).toEqual(['link', 'input', 'button']);
  });

  it('groups fields and submit buttons under their form', () => {
    const raws = [
      raw({ tag: 'input', typeHint: 'text', name: 'email', formIndex: 0 }),
      raw({ tag: 'input', typeHint: 'submit', name: 'go', formIndex: 0, isSubmitControl: true }),
    ];
    const elements = mapElements(raws, 'https://x.test/');
    const forms: RawDomForm[] = [
      {
        domIndex: 0,
        selector: 'form#checkout',
        action: '/orders',
        method: 'post',
        name: null,
        id: 'checkout',
        visible: true,
        fieldIndices: [0],
        submitIndices: [1],
        externalSubmitIndices: [],
      },
    ];

    const [form] = mapForms(forms, elements, 'https://x.test/');
    expect(form).toBeDefined();
    expect(form!.fields).toHaveLength(1);
    expect(form!.fields[0]!.name).toBe('email');
    expect(form!.submitButtons).toHaveLength(1);
    expect(form!.action).toBe('https://x.test/orders');
    expect(form!.method).toBe('POST');
  });
});
