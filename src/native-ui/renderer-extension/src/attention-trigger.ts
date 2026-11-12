const SITE_DESTINATION = 'builtin:sites';
const REVIEW_DESTINATION = 'builtin:pull-requests';

export interface AttentionTriggerOptions {
  /** Explicit embedding/test host. Native sidebar discovery is skipped when provided. */
  container?: HTMLElement;
}

export interface AttentionTriggerControl {
  dispose(): void;
}

const PRESENTATION_ATTRIBUTES = [
  'data-color',
  'data-variant',
  'data-squircle',
  'data-uniform',
  'data-size',
  'data-icon-size',
  'data-suppress-active-style',
] as const;

const STYLE = `
button[data-harnessmix-attention-trigger]{
  position:relative!important;width:36px!important;min-width:36px!important;max-width:36px!important;
  height:36px!important;min-height:36px!important;max-height:36px!important;padding:0!important;
  display:flex!important;align-items:center!important;justify-content:center!important;flex:0 0 36px!important;
  gap:0!important;margin:0!important;font-size:0!important;pointer-events:auto!important;-webkit-app-region:no-drag!important;
}
button[data-harnessmix-attention-trigger]::after{
  all:initial;content:"";display:block;width:18px;height:18px;flex:0 0 18px;color:inherit;background:currentColor;
  opacity:1;position:static;pointer-events:none;
  -webkit-mask:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4z'/%3E%3Cpath d='M8 9h8M8 13h5'/%3E%3C/svg%3E") center/contain no-repeat;
  mask:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4z'/%3E%3Cpath d='M8 9h8M8 13h5'/%3E%3C/svg%3E") center/contain no-repeat;
}
button[data-harnessmix-attention-trigger]>.badge{
  position:absolute;top:1px;right:1px;min-width:14px;height:14px;line-height:14px;padding:0 3px!important;
  border-radius:7px!important;font:600 9px/14px system-ui,sans-serif!important;text-align:center;
  background:#c82c24!important;color:#fff!important;box-shadow:0 0 0 1px var(--color-background-primary,#fff);
}
`;

function visible(element: HTMLElement): boolean {
  if (typeof element.checkVisibility === 'function') {
    try { return element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }); } catch { /* older Chromium */ }
  }
  if (element.hidden || element.closest('[hidden]')) return false;
  if (typeof element.getClientRects === 'function') return element.getClientRects().length > 0;
  return true;
}

function findAnchor(): HTMLButtonElement | null {
  for (const destination of [SITE_DESTINATION, REVIEW_DESTINATION]) {
    const matches = document.querySelectorAll<HTMLButtonElement>(`button[data-sidebar-destination="${destination}"]`);
    for (const match of matches) if (visible(match)) return match;
  }
  return null;
}

function copyPresentation(button: HTMLButtonElement, anchor: HTMLButtonElement): void {
  if (button.className !== anchor.className) button.className = anchor.className;
  // Clear the former header pill's inline presentation before adopting native button classes.
  if (button.getAttribute('style') !== null) button.removeAttribute('style');
  for (const name of PRESENTATION_ATTRIBUTES) {
    const value = anchor.getAttribute(name);
    if (value === null) button.removeAttribute(name);
    else if (button.getAttribute(name) !== value) button.setAttribute(name, value);
  }
}

/** Keep one real trigger button mounted below the visible native sidebar destinations. */
export function installAttentionTrigger(button: HTMLButtonElement, options: AttentionTriggerOptions = {}): AttentionTriggerControl {
  let disposed = false;
  let queued = false;
  const style = document.createElement('style');
  style.setAttribute('data-harnessmix-attention-trigger-style', '');
  style.textContent = STYLE;
  document.head.append(style);
  button.setAttribute('data-harnessmix-attention-trigger', '');

  const updateTitle = (): void => {
    const label = button.getAttribute('aria-label');
    if (label && button.title !== label) button.title = label;
  };
  const reconcile = (): void => {
    queued = false;
    if (disposed) return;
    updateTitle();
    if (options.container) {
      if (button.parentElement !== options.container) options.container.append(button);
      return;
    }
    const anchor = findAnchor();
    if (!anchor?.parentElement) return;
    copyPresentation(button, anchor);
    if (anchor.nextElementSibling !== button) anchor.parentElement.insertBefore(button, anchor.nextSibling);
  };
  const schedule = (): void => {
    if (disposed || queued) return;
    queued = true;
    queueMicrotask(reconcile);
  };
  const sidebarObserver = new MutationObserver(schedule);
  sidebarObserver.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style', 'hidden'] });
  const labelObserver = new MutationObserver(updateTitle);
  labelObserver.observe(button, { attributes: true, attributeFilter: ['aria-label'] });
  reconcile();

  return { dispose(): void {
    if (disposed) return;
    disposed = true;
    sidebarObserver.disconnect();
    labelObserver.disconnect();
    style.remove();
    button.remove();
  } };
}
