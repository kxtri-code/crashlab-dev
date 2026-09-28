/**
 * Pure element classification: raw DOM descriptors -> report elements.
 *
 * Split out of the in-page script so it can be unit-tested without a browser.
 * Everything here is a deterministic function of its input, which is what makes
 * future regression tests and test-generation stable.
 */

import type { RawDomElement, RawDomForm } from './domRaw.js';
import type { FormField, InteractiveElement, InteractiveElementType, ScoutForm } from './types.js';
import { canonicalizeUrl } from '../util/url.js';
import { cleanText } from '../util/text.js';

/** Input types that render as their own control rather than a text box. */
const CHECKBOX_LIKE = new Set(['checkbox', 'switch']);
const RADIO_LIKE = new Set(['radio']);

/** Roles that present a control as a button. */
const BUTTON_ROLES = new Set(['button', 'menuitem', 'tab', 'switch']);

/** Roles that present a control as a link. */
const LINK_ROLES = new Set(['link']);

/** Roles that present a control as a text field. */
const TEXTBOX_ROLES = new Set(['textbox', 'searchbox']);

/** Roles that present a control as a checkbox or radio. */
const CHECKBOX_ROLES = new Set(['checkbox']);
const RADIO_ROLES = new Set(['radio', 'menuitemradio', 'radiogroup']);

/**
 * Map a raw element onto the report taxonomy.
 *
 * Order matters: explicit `role` wins over implicit tag semantics, and a
 * `<select multiple>`/`<textarea>` keeps its own type.
 */
export function classifyElement(raw: RawDomElement): InteractiveElementType {
  const role = (raw.role ?? '').toLowerCase();

  if (raw.tag === 'a' || raw.tag === 'area' || LINK_ROLES.has(role)) {
    return 'link';
  }
  if (BUTTON_ROLES.has(role)) return 'button';
  if (CHECKBOX_ROLES.has(role)) return 'checkbox';
  if (RADIO_ROLES.has(role)) return 'radio';
  if (TEXTBOX_ROLES.has(role)) return raw.tag === 'textarea' ? 'textarea' : 'input';

  switch (raw.tag) {
    case 'button':
      return 'button';
    case 'textarea':
      return 'textarea';
    case 'select':
      return 'select';
    case 'input': {
      const type = raw.typeHint;
      if (CHECKBOX_LIKE.has(type)) return 'checkbox';
      if (RADIO_LIKE.has(type)) return 'radio';
      if (type === 'submit' || type === 'button' || type === 'reset' || type === 'image') return 'button';
      return 'input';
    }
    case 'summary':
      return 'button';
    case 'option':
    case 'optgroup':
      return 'other';
    default:
      return 'other';
  }
}

/** Playwright's ARIA role for a classified element, for role-based locators. */
function ariaRoleFor(raw: RawDomElement, type: InteractiveElementType): string | null {
  const explicit = (raw.role ?? '').toLowerCase();
  if (explicit) return explicit;
  if (raw.tag === 'textarea' || (raw.tag === 'input' && type === 'input')) return 'textbox';
  if (raw.tag === 'select') return 'combobox';
  if (type === 'link') return 'link';
  if (type === 'checkbox') return 'checkbox';
  if (type === 'radio') return 'radio';
  if (type === 'button') return 'button';
  return null;
}

/** Single-quote a locator fragment, escaping embedded quotes. */
function quote(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

/**
 * Suggest the best-practice Playwright locator for an element.
 *
 * Preference order mirrors Playwright's own guidance: test id, then accessible
 * role+name, then label, then placeholder. Returns `null` when nothing stable
 * is available, so callers can fall back to the CSS `selector`.
 */
export function suggestLocator(raw: RawDomElement, type: InteractiveElementType): string | null {
  if (raw.testId) return `page.getByTestId(${quote(raw.testId)})`;

  const role = ariaRoleFor(raw, type);
  const name = cleanText(raw.text) ?? cleanText(raw.label) ?? cleanText(raw.ariaLabel);

  // A name is only worth matching if it is distinctive enough to not be ambiguous.
  if (role && name && name.length >= 2 && name.length <= 60) {
    return `page.getByRole(${quote(role)}, { name: ${quote(name)} })`;
  }

  const label = cleanText(raw.label);
  if (label && label.length >= 2 && label.length <= 60 && type !== 'link') {
    return `page.getByLabel(${quote(label)})`;
  }

  const placeholder = cleanText(raw.placeholder);
  if (placeholder && placeholder.length >= 2 && placeholder.length <= 60) {
    return `page.getByPlaceholder(${quote(placeholder)})`;
  }

  return null;
}

/** Convert one raw descriptor into a report element. */
export function toInteractiveElement(
  raw: RawDomElement,
  index: number,
  baseUrl: string | null,
): InteractiveElement {
  const type = classifyElement(raw);
  return {
    type,
    tag: raw.tag,
    text: cleanText(raw.text),
    label: cleanText(raw.label),
    name: cleanText(raw.name),
    id: cleanText(raw.id),
    placeholder: cleanText(raw.placeholder),
    ariaLabel: cleanText(raw.ariaLabel),
    role: cleanText(raw.role),
    href: canonicalizeUrl(raw.href, baseUrl),
    inputType: raw.tag === 'input' || raw.tag === 'textarea' || raw.tag === 'select' ? raw.typeHint || null : null,
    // Static attribute only; the live `.value` property is never captured.
    value: cleanText(raw.value),
    selector: raw.selector,
    locator: suggestLocator(raw, type),
    visible: raw.visible,
    enabled: raw.enabled,
    required: raw.required,
    disabled: raw.disabled,
    readonly: raw.readonly,
    index,
    formIndex: raw.formIndex,
  };
}

/** Project a report element down to the field shape used inside a form. */
export function toFormField(element: InteractiveElement): FormField {
  return {
    type: element.type,
    tag: element.tag,
    name: element.name,
    id: element.id,
    label: element.label,
    placeholder: element.placeholder,
    ariaLabel: element.ariaLabel,
    inputType: element.inputType,
    required: element.required,
    visible: element.visible,
    enabled: element.enabled,
    selector: element.selector,
    locator: element.locator,
  };
}

/** Map every raw element, preserving DOM order. */
export function mapElements(raws: RawDomElement[], baseUrl: string | null): InteractiveElement[] {
  return raws.map((raw, index) => toInteractiveElement(raw, index, baseUrl));
}

/** Map one raw form plus the already-mapped elements it references. */
export function toScoutForm(
  raw: RawDomForm,
  elements: InteractiveElement[],
  baseUrl: string | null,
): ScoutForm {
  const fieldOf = (rawIndex: number): FormField | null => {
    const element = elements[rawIndex];
    return element ? toFormField(element) : null;
  };

  return {
    selector: raw.selector,
    action: canonicalizeUrl(raw.action, baseUrl) ?? cleanText(raw.action),
    method: cleanText(raw.method)?.toUpperCase() ?? null,
    name: cleanText(raw.name),
    id: cleanText(raw.id),
    visible: raw.visible,
    fields: raw.fieldIndices.map(fieldOf).filter((field): field is FormField => field !== null),
    submitButtons: raw.submitIndices.map(fieldOf).filter((field): field is FormField => field !== null),
    externalSubmitButtons: raw.externalSubmitIndices
      .map(fieldOf)
      .filter((field): field is FormField => field !== null),
  };
}

/** Map every raw form, preserving DOM order. */
export function mapForms(raws: RawDomForm[], elements: InteractiveElement[], baseUrl: string | null): ScoutForm[] {
  return raws.map((raw) => toScoutForm(raw, elements, baseUrl));
}
