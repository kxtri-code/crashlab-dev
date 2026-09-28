/**
 * Browser-side DOM extraction.
 *
 * `collectDomData` is serialised and executed inside the page by Playwright, so
 * it must be fully self-contained: no imports, no references to module-level
 * values, no closure over the module scope. Every constant and helper it uses
 * is declared *inside* the function body. (A module-level constant referenced
 * here would compile fine but throw a ReferenceError at runtime in the page.)
 *
 * It returns *raw* descriptors - visibility, labels, selectors, raw attributes -
 * and performs no classification. Classification and locator generation live in
 * the pure, unit-tested layer in `elements.ts`.
 */

import type { Page } from 'playwright';

/** One interactive element, as seen from inside the page. */
export interface RawDomElement {
  /** Position in DOM order within the mapped element list. */
  domIndex: number;
  tag: string;
  /** Lowercased `type` attribute (inputs only), else empty string. */
  typeHint: string;
  role: string | null;
  ariaLabel: string | null;
  /** Accessible name from innerText / aria-label / aria-labelledby / title. */
  text: string | null;
  /** Label resolved from `label[for]`, a wrapping `<label>`, or aria. */
  label: string | null;
  name: string | null;
  id: string | null;
  placeholder: string | null;
  /** Raw `href` attribute; resolved to an absolute URL on the Node side. */
  href: string | null;
  /**
   * Static `value` attribute, and only for visible controls. The live `.value`
   * property is never read, and an invisible control's attribute is dropped
   * because that is where secrets such as a hidden CSRF token live.
   */
  value: string | null;
  title: string | null;
  /** Always a valid and unique CSS selector for this element. */
  selector: string;
  visible: boolean;
  enabled: boolean;
  disabled: boolean;
  readonly: boolean;
  required: boolean;
  tabIndex: number | null;
  /** Value of a test-id style attribute, when present. */
  testId: string | null;
  /** Index into `RawDomForm[]` when the element belongs to a `<form>`. */
  formIndex: number | null;
  /** True for controls that submit their associated form. */
  isSubmitControl: boolean;
  /** True when the submit control is outside its form (`form=` attribute). */
  isExternalSubmit: boolean;
}

/** One `<form>`, with the DOM indices of the controls it owns. */
export interface RawDomForm {
  domIndex: number;
  selector: string;
  action: string | null;
  method: string | null;
  name: string | null;
  id: string | null;
  visible: boolean;
  /** Indices into `RawDomElement[]` of every field inside the form. */
  fieldIndices: number[];
  /** Indices into `RawDomElement[]` of submit controls inside the form. */
  submitIndices: number[];
  /** Indices into `RawDomElement[]` of submit controls outside the form. */
  externalSubmitIndices: number[];
}

/** Coarse evidence gathered for page-type inference. */
export interface RawPageSignals {
  path: string;
  title: string;
  text: string;
  formCount: number;
  formActionPaths: string[];
  inputTypes: string[];
  visibleFieldCount: number;
  hasPasswordField: boolean;
  hasFileInput: boolean;
  hasSearchInput: boolean;
  tableCount: number;
  navCount: number;
  headingTexts: string[];
  buttonTexts: string[];
  linkTexts: string[];
  /** Largest number of sibling elements sharing a class - a weak "list page" hint. */
  repeatedBlockCount: number;
}

/** Page-level facts collected alongside the element map. */
export interface RawPageMeta {
  readyState: string;
  htmlLang: string | null;
  canonicalUrl: string | null;
  metaDescription: string | null;
  visibleText: string;
  visibleTextLength: number;
}

/** Everything the browser knows; the Node side turns this into a report. */
export interface RawDomData {
  elements: RawDomElement[];
  forms: RawDomForm[];
  signals: RawPageSignals;
  meta: RawPageMeta;
  /** True when `maxElements` was hit and the element list was cut short. */
  truncated: boolean;
}

/** Input parameters for `collectDomData`. */
export interface CollectDomOptions {
  /** Tag names / attribute selectors to inspect. */
  scope: string[];
  maxElements: number;
  maxTextLength: number;
}

/**
 * Extract the raw DOM map from the current page.
 *
 * Executed in the browser by `page.evaluate`; see the module comment for the
 * self-containment constraints that puts on this function.
 */
export function collectDomData(options: CollectDomOptions): RawDomData {
  // Every value this function needs is declared here, inside the body, because
  // Playwright stringifies the function and runs it in the page - anything
  // referenced from module scope throws a ReferenceError there.
  const doc = document;
  const MAX_TEXT_SAMPLE = 2000;
  const maxElements = Math.max(1, options.maxElements | 0);
  const maxText = Math.max(1, options.maxTextLength | 0);

  /** Attributes treated as test ids, in preference order. */
  const testIdAttributes = ['data-testid', 'data-test-id', 'data-test', 'data-qa', 'data-cy'];

  /** Class prefixes/patterns that look generated, so are unstable selectors. */
  const volatileClassPattern =
    /^(css-|sc-|ng-|jsx-|emotion-|vanilla-|styled-|_|-?[a-z]{0,4}-?[0-9a-f]{5,}|-?[a-z]+\d{4,}$)/;

  function escapeIdent(value: string): string {
    if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(value);
    return value.replace(/([^A-Za-z0-9_-])/g, '\\$1');
  }

  function escapeAttrValue(value: string): string {
    return value.replace(/(["\\])/g, '\\$1');
  }

  function isUnique(selector: string): boolean {
    try {
      return doc.querySelectorAll(selector).length === 1;
    } catch {
      return false;
    }
  }

  function stableClasses(el: Element): string {
    const raw = el.getAttribute('class');
    if (!raw) return '';
    const stable = raw
      .split(/\s+/)
      .filter((cls) => cls && cls.length <= 40 && !volatileClassPattern.test(cls));
    return stable.slice(0, 2).join(' ');
  }

  /**
   * Build a selector that resolves to exactly this element, preferring stable
   * anchors (id, test id, name) before falling back to a structural path.
   */
  function buildSelector(el: Element): string {
    const tag = el.tagName.toLowerCase();

    if (el.id) {
      const byId = '#' + escapeIdent(el.id);
      if (isUnique(byId)) return byId;
    }

    for (const attr of testIdAttributes) {
      const testValue = el.getAttribute(attr);
      if (testValue) {
        const byTest = '[' + attr + '="' + escapeAttrValue(testValue) + '"]';
        if (isUnique(byTest)) return byTest;
      }
    }

    const name = el.getAttribute('name');
    if (name) {
      const byName = tag + '[name="' + escapeAttrValue(name) + '"]';
      if (isUnique(byName)) return byName;
    }

    const parts: string[] = [];
    let current: Element | null = el;
    let depth = 0;
    while (current && current.nodeType === 1 && depth < 6) {
      let part = current.tagName.toLowerCase();
      const classes = stableClasses(current);
      if (classes) part += '.' + classes.split(' ').map(escapeIdent).join('.');

      const parent: Element | null = current.parentElement;
      if (parent) {
        const sameTag = Array.prototype.filter.call(
          parent.children,
          (kid: Element) => kid.tagName === current!.tagName,
        ) as Element[];
        if (sameTag.length > 1) part += ':nth-of-type(' + (sameTag.indexOf(current) + 1) + ')';
      }
      parts.unshift(part);
      const candidate = parts.join(' > ');
      if (isUnique(candidate)) return candidate;
      current = parent;
      depth++;
    }
    return parts.join(' > ') || tag;
  }

  function isVisible(el: Element): boolean {
    const html = el as HTMLElement;
    const style = window.getComputedStyle(html);
    if (style.display === 'none') return false;
    if (style.visibility === 'hidden' || style.visibility === 'collapse') return false;
    if (parseFloat(style.opacity || '1') === 0) return false;
    if (html.hidden) return false;
    if (html.getAttribute('aria-hidden') === 'true') return false;
    const rects = Array.prototype.slice.call(html.getClientRects()) as DOMRect[];
    return rects.some((rect) => rect.width > 0 && rect.height > 0);
  }

  function enabledState(el: Element): boolean {
    const html = el as HTMLElement & { disabled?: boolean };
    if (html.disabled === true) return false;
    if (el.getAttribute('aria-disabled') === 'true') return false;
    if (el.closest('fieldset[disabled]')) return false;
    const tag = el.tagName;
    if (tag === 'OPTGROUP' && (el as HTMLOptGroupElement).disabled) return false;
    if (tag === 'OPTION' && (el as HTMLOptionElement).disabled) return false;
    return true;
  }

  function labelledByText(el: Element): string | null {
    const ids = el.getAttribute('aria-labelledby');
    if (!ids) return null;
    const parts: string[] = [];
    for (const token of ids.split(/\s+/)) {
      const target = doc.getElementById(token);
      if (!target) continue;
      const text = (target.textContent || '').replace(/\s+/g, ' ').trim();
      if (text) parts.push(text);
    }
    return parts.length ? parts.join(' ').substring(0, maxText) : null;
  }

  function labelFor(el: Element): string | null {
    const fromIds = labelledByText(el);
    if (fromIds) return fromIds;

    const ariaLabel = el.getAttribute('aria-label');
    if (ariaLabel && ariaLabel.trim()) return ariaLabel.trim().substring(0, maxText);

    if (el.id) {
      let explicit: NodeListOf<Element> | null = null;
      try {
        explicit = doc.querySelectorAll('label[for="' + escapeIdent(el.id) + '"]');
      } catch {
        explicit = null;
      }
      if (explicit) {
        for (const label of Array.prototype.slice.call(explicit) as Element[]) {
          const text = (label.textContent || '').replace(/\s+/g, ' ').trim();
          if (text) return text.substring(0, maxText);
        }
      }
    }

    const wrapper = el.closest('label');
    if (wrapper) {
      const clone = wrapper.cloneNode(true) as HTMLElement;
      const nested = Array.prototype.slice.call(clone.querySelectorAll('input,select,textarea,button')) as Element[];
      for (const node of nested) node.remove();
      const text = (clone.textContent || '').replace(/\s+/g, ' ').trim();
      if (text) return text.substring(0, maxText);
    }
    return null;
  }

  function cleanText(value: string | null): string | null {
    if (value === null) return null;
    const cleaned = value.replace(/\s+/g, ' ').trim();
    if (!cleaned) return null;
    return cleaned.length > maxText ? cleaned.substring(0, maxText) : cleaned;
  }

  function readableText(el: Element): string | null {
    const fromIds = labelledByText(el);
    if (fromIds) return fromIds;
    const ariaLabel = el.getAttribute('aria-label');
    if (ariaLabel && ariaLabel.trim()) return cleanText(ariaLabel);
    const title = el.getAttribute('title');
    if (title && title.trim()) return cleanText(title);
    const html = el as HTMLElement;
    const cleaned = cleanText(html.innerText || el.textContent || '');
    if (cleaned) return cleaned;
    const alt = el.getAttribute('alt');
    if (alt && alt.trim()) return cleanText(alt);
    return null;
  }

  function isSubmitControl(el: Element, tag: string, typeHint: string): boolean {
    if (tag === 'button') {
      const buttonType = (el.getAttribute('type') || '').toLowerCase();
      return buttonType === 'submit' || buttonType === '';
    }
    if (tag === 'input') return typeHint === 'submit' || typeHint === 'image';
    return false;
  }

  // --- forms -------------------------------------------------------------
  const formNodes = Array.prototype.slice.call(doc.querySelectorAll('form')) as HTMLFormElement[];
  const forms: RawDomForm[] = formNodes.map((formNode, f) => ({
    domIndex: f,
    selector: buildSelector(formNode),
    action: formNode.getAttribute('action'),
    method: formNode.getAttribute('method'),
    name: formNode.getAttribute('name'),
    id: formNode.getAttribute('id'),
    visible: isVisible(formNode),
    // Field/submit lists are wired below, once every element index is known.
    fieldIndices: [] as number[],
    submitIndices: [] as number[],
    externalSubmitIndices: [] as number[],
  }));

  function owningFormIndex(el: Element): number | null {
    const form = (el as HTMLInputElement).form;
    if (!form) return null;
    return formNodes.indexOf(form as HTMLFormElement);
  }

  // --- elements ----------------------------------------------------------
  const selector = options.scope.join(', ');
  const allNodes = Array.prototype.slice.call(doc.querySelectorAll(selector)) as HTMLElement[];
  const truncated = allNodes.length > maxElements;
  const nodes = truncated ? allNodes.slice(0, maxElements) : allNodes;

  const elements: RawDomElement[] = nodes.map((node, i2) => {
    const tag = node.tagName.toLowerCase();
    const typeHint = tag === 'input' ? (node.getAttribute('type') || 'text').toLowerCase() : '';
    const submit = isSubmitControl(node, tag, typeHint);
    const ownerIndex = owningFormIndex(node);
    const visible = isVisible(node);

    // The static `value` *attribute* is captured only for visible controls.
    // Reading the live `.value` property is never done, and an invisible
    // control's attribute is where secrets live (a hidden CSRF token, a
    // prefilled password), so it is dropped rather than recorded.
    const staticValue = visible && (tag === 'input' || tag === 'textarea')
      ? cleanText(node.getAttribute('value'))
      : null;

    let text = readableText(node);
    if (!text) text = cleanText(node.getAttribute('placeholder'));
    if (!text) text = staticValue;
    if (!text) text = cleanText(node.getAttribute('name'));

    let testId: string | null = null;
    for (const attr of testIdAttributes) {
      const value = node.getAttribute(attr);
      if (value) {
        testId = value;
        break;
      }
    }

    const tabIndexAttr = node.getAttribute('tabindex');
    const tabIndex = tabIndexAttr !== null && /^-?\d+$/.test(tabIndexAttr) ? parseInt(tabIndexAttr, 10) : null;

    return {
      domIndex: i2,
      tag,
      typeHint,
      role: node.getAttribute('role'),
      ariaLabel: cleanText(node.getAttribute('aria-label')),
      text,
      label: labelFor(node),
      name: node.getAttribute('name'),
      id: node.getAttribute('id'),
      placeholder: cleanText(node.getAttribute('placeholder')),
      href: tag === 'a' ? node.getAttribute('href') : null,
      value: staticValue,
      title: cleanText(node.getAttribute('title')),
      selector: buildSelector(node),
      visible,
      enabled: enabledState(node),
      disabled: (node as HTMLInputElement).disabled === true,
      readonly: (node as HTMLInputElement).readOnly === true,
      required: (node as HTMLInputElement).required === true,
      tabIndex,
      testId,
      formIndex: ownerIndex,
      isSubmitControl: submit,
      isExternalSubmit: submit && node.getAttribute('form') !== null,
    };
  });

  // Wire each element into its form's field / submit lists.
  elements.forEach((element, e2) => {
    if (element.formIndex === null) return;
    const target = forms[element.formIndex];
    if (!target) return;
    if (element.tag !== 'button') target.fieldIndices.push(e2);
    if (element.isSubmitControl) {
      if (element.isExternalSubmit) target.externalSubmitIndices.push(e2);
      else target.submitIndices.push(e2);
    }
  });

  // --- page signals ------------------------------------------------------
  const body = doc.body;
  const fullText = ((body && (body.innerText || body.textContent)) || '').replace(/\s+/g, ' ').trim();

  let repeatedBlockCount = 0;
  try {
    const blockCandidates = Array.prototype.slice.call(
      doc.querySelectorAll('main *, body > div > *, body > section > *'),
    ) as Element[];
    const groups: Record<string, number> = {};
    for (const block of blockCandidates.slice(0, 2000)) {
      const cls = (block.getAttribute('class') || '').split(/\s+/).filter(Boolean)[0];
      if (!cls) continue;
      groups[cls] = (groups[cls] || 0) + 1;
      if (groups[cls] > repeatedBlockCount) repeatedBlockCount = groups[cls];
    }
  } catch {
    repeatedBlockCount = 0;
  }

  const headingTexts = (Array.prototype.slice.call(doc.querySelectorAll('h1,h2,h3')) as HTMLElement[])
    .slice(0, 8)
    .map((h) => cleanText(h.textContent))
    .filter((text): text is string => Boolean(text));

  const buttonTexts = (Array.prototype.slice.call(
    doc.querySelectorAll('button,[role="button"],input[type="submit"]'),
  ) as HTMLElement[])
    .slice(0, 40)
    .map((b) => cleanText(b.getAttribute('aria-label')) || cleanText(b.textContent))
    .filter((text): text is string => Boolean(text));

  const linkTexts = (Array.prototype.slice.call(doc.querySelectorAll('a[href]')) as HTMLAnchorElement[])
    .slice(0, 60)
    .map((a) => cleanText(a.textContent))
    .filter((text): text is string => Boolean(text));

  const formActionPaths = formNodes
    .map((form) => form.getAttribute('action'))
    .filter((action): action is string => Boolean(action));

  const inputTypeSet: Record<string, boolean> = {};
  for (const element of elements) {
    if (element.tag === 'input' && element.typeHint) inputTypeSet[element.typeHint] = true;
  }

  const isFieldTag = (el: RawDomElement): boolean =>
    el.tag === 'input' || el.tag === 'select' || el.tag === 'textarea';

  const signals: RawPageSignals = {
    path: doc.location.pathname + doc.location.search,
    title: doc.title || '',
    text: fullText.substring(0, MAX_TEXT_SAMPLE),
    formCount: formNodes.length,
    formActionPaths,
    inputTypes: Object.keys(inputTypeSet),
    visibleFieldCount: elements.filter((el) => el.visible && isFieldTag(el)).length,
    hasPasswordField: elements.some((el) => el.tag === 'input' && el.typeHint === 'password'),
    hasFileInput: elements.some((el) => el.tag === 'input' && el.typeHint === 'file'),
    hasSearchInput: elements.some(
      (el) =>
        el.tag === 'input' &&
        (el.typeHint === 'search' ||
          (el.typeHint === 'text' &&
            /search|query|keyword/i.test(`${el.name || ''} ${el.placeholder || ''} ${el.ariaLabel || ''}`))),
    ),
    tableCount: doc.querySelectorAll('table,[role="table"]').length,
    navCount: doc.querySelectorAll('nav,[role="navigation"]').length,
    headingTexts,
    buttonTexts,
    linkTexts,
    repeatedBlockCount,
  };

  const canonical = doc.querySelector('link[rel="canonical"]');
  const metaDescription = doc.querySelector('meta[name="description"]');

  const meta: RawPageMeta = {
    readyState: doc.readyState,
    htmlLang: doc.documentElement.getAttribute('lang'),
    canonicalUrl: canonical ? canonical.getAttribute('href') : null,
    metaDescription: metaDescription ? metaDescription.getAttribute('content') : null,
    visibleText: fullText.substring(0, MAX_TEXT_SAMPLE),
    visibleTextLength: fullText.length,
  };

  return { elements, forms, signals, meta, truncated };
}

/**
 * Script text installed into the page so serialized mappers can resolve the
 * toolchain's function-name helper.
 *
 * The TS toolchain (esbuild under `tsx` and `vitest`) compiles with
 * `keepNames`, which rewrites function declarations to
 * `var f = __name(function f() {...}, "f")`. `__name` only exists in the
 * compiled bundle, so when Playwright stringifies `collectDomData` and runs it
 * in the page, the call throws `ReferenceError: __name is not defined` and the
 * whole element map comes back empty. A no-op global of the same name is the
 * minimal fix, and it is installed as *text* so this shim is never itself
 * serialized.
 */
export const SERIALIZATION_SHIM = 'globalThis.__name ??= function (value) { return value; };';

/** Install the shim on pages that are already loaded and on future navigations. */
export async function installSerializationShim(page: Page): Promise<void> {
  await page.addInitScript({ content: SERIALIZATION_SHIM });
  // `addInitScript` only applies to the next navigation, so cover the current
  // document too. A string argument is evaluated as-is and never serialized.
  await page.evaluate(SERIALIZATION_SHIM).catch(() => undefined);
}
